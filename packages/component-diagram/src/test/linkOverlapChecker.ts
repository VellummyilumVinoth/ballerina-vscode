/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * A systematic, whole-diagram check for the "a link visibly cuts through an unrelated node" class
 * of bug, replacing eyeballing screenshots one layout at a time.
 *
 * It drives the *production* pipeline end to end - `buildDiagramData` (the same graph
 * `Diagram.tsx` builds) -> `autoDistribute` (which positions every column and internally runs
 * `avoidLinkObstructions`) -> `NodeLinkModel.getSVGPath` (the real bezier path builder) - then
 * samples each link's actual rendered curve and tests every sample against every *other* node's
 * real bounding box. Nothing here re-implements layout or path math; the only thing this module
 * supplies is the endpoint geometry jsdom can't (see `resolveEndpointAnchors`).
 */

import { DiagramEngine, DiagramModel } from "@projectstorm/react-diagrams";
import { CDModel } from "@wso2/ballerina-core";
import {
    autoDistribute,
    buildDiagramData,
    BoundingBox,
    generateEngine,
    getNodeBoundingBox,
    getPortAnchorY,
} from "../utils/diagram";
import { NodeLinkModel, Point2D } from "../components/NodeLink";
import { NodeModel } from "../utils/types";
import { EntryNodeModel } from "../components/nodes/EntryNode";
import { ConnectionNodeModel } from "../components/nodes/ConnectionNode";
import { ListenerNodeModel } from "../components/nodes/ListenerNode";
import { GQLState } from "../components/Diagram";

/**
 * Samples taken along each cubic segment of a link's path. A segment spans at most a few hundred
 * px here, so ~200 samples put consecutive samples well under a pixel apart - fine enough that a
 * curve can't slip through a node box (tens of px tall) between two samples.
 */
const SAMPLES_PER_SEGMENT = 200;

/**
 * How far inside a node's box a sample must fall before it counts as a real crossing. A curve that
 * merely grazes a border (sub-pixel) is visually indistinguishable from one running alongside it,
 * and reporting those would make the check noisy without describing anything a user can see.
 */
const CROSSING_TOLERANCE = 0.5;

export interface LinkCrossing {
    /** e.g. `entry "/f" [port get-f] -> connection "ftpClient"` */
    link: string;
    /** the unrelated node the link's curve enters, e.g. `entry "workflow2" (workflow)` */
    node: string;
    nodeBox: BoundingBox;
    /** deepest distance (px) the curve reaches inside `nodeBox`, measured from its nearest edge */
    penetration: number;
    /** the sampled point at which that deepest penetration occurs */
    deepestPoint: Point2D;
    /** the link's full geometry: endpoint anchors plus any detour waypoints */
    linkPoints: Point2D[];
}

/** The laid-out diagram, exactly as the production pipeline produces it. */
export interface LayoutResult {
    engine: DiagramEngine;
    nodes: NodeModel[];
    links: NodeLinkModel[];
}

/**
 * Runs the production build + layout pipeline for `project`, with no React render involved:
 * `buildDiagramData` -> `DiagramModel` -> `autoDistribute` (which runs `avoidLinkObstructions`).
 *
 * `expandedNodes` is empty and `graphQLGroupOpen` uses the same defaults `Diagram.tsx` seeds its
 * state with (Query open, Subscription/Mutation collapsed), so this reproduces the layout a user
 * sees on first open - the state every reported overlap so far has been in.
 */
export function layoutProject(project: CDModel): LayoutResult {
    const engine = generateEngine();
    const graphQLGroupOpen: Record<string, GQLState> = {};
    project.services
        ?.filter((service) => service.type === "graphql:Service")
        .forEach((service) => {
            graphQLGroupOpen[service.uuid] = { Query: true, Subscription: false, Mutation: false };
        });

    const { nodes, links } = buildDiagramData(project, new Set<string>(), graphQLGroupOpen);

    const model = new DiagramModel();
    model.addAll(...nodes, ...links);
    engine.setModel(model);

    autoDistribute(engine);

    return { engine, nodes, links };
}

/**
 * Where a link's two ends actually attach, which the model alone can't tell us here.
 *
 * In a browser each `NodePortWidget` reports its rendered position and react-diagrams moves the
 * link's first/last point onto it; under jsdom every element measures 0x0, so those points stay at
 * the origin. This reconstructs them from the layout instead, using the exact same rule
 * `avoidLinkObstructions` reasons with: out/function ports sit on the source box's inner edge,
 * in-ports on the target box's inner edge, at the Y `getPortAnchorY` computes for that specific
 * port (a function row's own Y, not the node's center).
 *
 * Left/right is derived from the boxes rather than assumed source-on-the-left, mirroring
 * `avoidLinkObstructions`, so the check stays correct if a link is ever drawn right-to-left.
 */
function resolveEndpointAnchors(
    link: NodeLinkModel
): { source: Point2D; target: Point2D } | null {
    const { sourceNode, targetNode } = link;
    if (!sourceNode || !targetNode || sourceNode === targetNode) {
        return null;
    }

    const sourceBox = getNodeBoundingBox(sourceNode);
    const targetBox = getNodeBoundingBox(targetNode);
    const sourceIsLeft = sourceBox.left <= targetBox.left;

    return {
        source: {
            x: sourceIsLeft ? sourceBox.right : sourceBox.left,
            y: getPortAnchorY(sourceNode, link.getSourcePort()),
        },
        target: {
            x: sourceIsLeft ? targetBox.left : targetBox.right,
            y: getPortAnchorY(targetNode, link.getTargetPort()),
        },
    };
}

/**
 * The full point list a link is drawn through: the two reconstructed endpoint anchors plus every
 * detour waypoint `avoidLinkObstructions` added in between (those the model *does* carry, in
 * canvas coordinates, since the layout pass sets them directly).
 */
export function getLinkGeometry(link: NodeLinkModel): Point2D[] | null {
    const anchors = resolveEndpointAnchors(link);
    if (!anchors) {
        return null;
    }
    const waypoints = link
        .getPoints()
        .slice(1, -1)
        .map((point) => point.getPosition())
        .map(({ x, y }) => ({ x, y }));
    return [anchors.source, ...waypoints, anchors.target];
}

/**
 * Parses an SVG path of the shape `buildBezierPath` emits - `M x y` followed by one or more
 * `C c1x c1y c2x c2y x y` - into its cubic segments. Deliberately strict: anything else means the
 * path builder changed shape and this checker's sampling would no longer describe what's drawn, so
 * it throws rather than silently checking a subset of the curve.
 */
function parseBezierPath(path: string): Array<[Point2D, Point2D, Point2D, Point2D]> {
    const tokens = path.trim().split(/\s+/);
    if (tokens[0] !== "M") {
        throw new Error(`Unsupported link path (expected a leading "M"): ${path}`);
    }
    let cursor: Point2D = { x: Number(tokens[1]), y: Number(tokens[2]) };
    const segments: Array<[Point2D, Point2D, Point2D, Point2D]> = [];
    let index = 3;
    while (index < tokens.length) {
        if (tokens[index] !== "C") {
            throw new Error(`Unsupported link path command "${tokens[index]}" in: ${path}`);
        }
        const numbers = tokens.slice(index + 1, index + 7).map(Number);
        if (numbers.length < 6 || numbers.some(Number.isNaN)) {
            throw new Error(`Malformed cubic segment in link path: ${path}`);
        }
        const control1 = { x: numbers[0], y: numbers[1] };
        const control2 = { x: numbers[2], y: numbers[3] };
        const end = { x: numbers[4], y: numbers[5] };
        segments.push([cursor, control1, control2, end]);
        cursor = end;
        index += 7;
    }
    if (segments.length === 0) {
        throw new Error(`Link path has no drawable segments: ${path}`);
    }
    return segments;
}

function cubicAt(segment: [Point2D, Point2D, Point2D, Point2D], t: number): Point2D {
    const [p0, p1, p2, p3] = segment;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return {
        x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
        y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    };
}

/** How far inside `box` a point lies (0 when on or outside the boundary). */
function penetrationDepth(point: Point2D, box: BoundingBox): number {
    const depth = Math.min(
        point.x - box.left,
        box.right - point.x,
        point.y - box.top,
        box.bottom - point.y
    );
    return depth > 0 ? depth : 0;
}

function describeNode(node: NodeModel): string {
    if (node instanceof EntryNodeModel) {
        const entryPoint = node.node as { symbol?: string; name?: string; absolutePath?: string };
        const label = entryPoint.symbol ?? entryPoint.name ?? entryPoint.absolutePath ?? node.getID();
        return `entry "${label}" (${node.type})`;
    }
    if (node instanceof ConnectionNodeModel) {
        return `connection "${node.node.symbol}"`;
    }
    if (node instanceof ListenerNodeModel) {
        return `listener "${node.node.symbol}"`;
    }
    return `node "${(node as NodeModel).getID()}"`;
}

function describeLink(link: NodeLinkModel): string {
    const sourcePort = link.getSourcePort()?.getOptions().name;
    const targetPort = link.getTargetPort()?.getOptions().name;
    return (
        `${describeNode(link.sourceNode)} [${sourcePort ?? "?"}]` +
        ` -> ${describeNode(link.targetNode)} [${targetPort ?? "?"}]`
    );
}

/**
 * Samples every link's rendered curve against every node that isn't one of its own endpoints, and
 * returns the deepest crossing found per (link, node) pair, worst first.
 *
 * The curve is obtained by moving the link's endpoint points onto their reconstructed anchors and
 * then calling the real `NodeLinkModel.getSVGPath()` - i.e. exactly the `d` attribute the widget
 * renders, not a re-derivation of it.
 */
export function findLinkNodeCrossings(project: CDModel): LinkCrossing[] {
    const { nodes, links } = layoutProject(project);
    const boxes = new Map<NodeModel, BoundingBox>(nodes.map((node) => [node, getNodeBoundingBox(node)]));
    const crossings: LinkCrossing[] = [];

    links.forEach((link) => {
        const points = getLinkGeometry(link);
        if (!points) {
            return;
        }

        // Put the endpoints where they really render, so getSVGPath() produces the production path.
        const linkPoints = link.getPoints();
        linkPoints[0].setPosition(points[0].x, points[0].y);
        linkPoints[linkPoints.length - 1].setPosition(
            points[points.length - 1].x,
            points[points.length - 1].y
        );

        const segments = parseBezierPath(link.getSVGPath());

        nodes.forEach((node) => {
            if (node === link.sourceNode || node === link.targetNode) {
                return;
            }
            const box = boxes.get(node);
            let worstDepth = 0;
            let worstPoint: Point2D = { x: 0, y: 0 };
            segments.forEach((segment) => {
                for (let step = 0; step <= SAMPLES_PER_SEGMENT; step++) {
                    const sample = cubicAt(segment, step / SAMPLES_PER_SEGMENT);
                    const depth = penetrationDepth(sample, box);
                    if (depth > worstDepth) {
                        worstDepth = depth;
                        worstPoint = sample;
                    }
                }
            });
            if (worstDepth > CROSSING_TOLERANCE) {
                crossings.push({
                    link: describeLink(link),
                    node: describeNode(node),
                    nodeBox: box,
                    penetration: worstDepth,
                    deepestPoint: worstPoint,
                    linkPoints: points,
                });
            }
        });
    });

    return crossings.sort((a, b) => b.penetration - a.penetration);
}

const round = (value: number) => Math.round(value * 100) / 100;

/** Renders crossings as a readable report - used as the assertion message below. */
export function formatCrossings(crossings: LinkCrossing[]): string {
    return crossings
        .map((crossing) => {
            const box = crossing.nodeBox;
            const geometry = crossing.linkPoints.map((point) => `(${round(point.x)}, ${round(point.y)})`).join(" -> ");
            return [
                `${crossing.link}`,
                `  crosses ${crossing.node}`,
                `    node box: x [${round(box.left)}, ${round(box.right)}], y [${round(box.top)}, ${round(box.bottom)}]`,
                `    deepest point: (${round(crossing.deepestPoint.x)}, ${round(crossing.deepestPoint.y)})` +
                    `, ${round(crossing.penetration)}px inside`,
                `    link geometry: ${geometry}`,
            ].join("\n");
        })
        .join("\n");
}

/**
 * Asserts that no link in `project`'s laid-out diagram crosses any node other than its own
 * endpoints. On failure the message lists every offending link/node pair with real coordinates and
 * penetration depths, so a regression can be diagnosed from the output alone.
 */
export function checkNoLinkCrossesAnyNode(project: CDModel, fixtureName: string): void {
    const crossings = findLinkNodeCrossings(project);
    if (crossings.length > 0) {
        throw new Error(
            `${fixtureName}: ${crossings.length} link/node crossing(s) found\n${formatCrossings(crossings)}`
        );
    }
}

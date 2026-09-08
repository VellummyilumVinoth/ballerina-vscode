/**
 * Copyright (c) 2025, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
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
import createEngine, { DiagramEngine, DiagramModel, PortModel } from "@projectstorm/react-diagrams";
import { NodePortFactory, NodePortModel } from "../components/NodePort";
import {
    NodeLinkFactory,
    NodeLinkModel,
    NodeLinkModelOptions,
    Point2D,
    sampleBezierPath,
} from "../components/NodeLink";
import { OverlayLayerFactory } from "../components/OverlayLayer";
import { DagreEngine } from "../resources/dagre/DagreEngine";
import { NodeModel } from "./types";
import { EntryNodeFactory, EntryNodeModel } from "../components/nodes/EntryNode";
import { ConnectionNodeFactory } from "../components/nodes/ConnectionNode/ConnectionNodeFactory";
import { ListenerNodeFactory } from "../components/nodes/ListenerNode/ListenerNodeFactory";
import {
    LISTENER_NODE_WIDTH,
    NodeTypes,
    NODE_GAP_X,
    ENTRY_NODE_WIDTH,
    ENTRY_NODE_HEIGHT,
    NODE_GAP_Y,
    LISTENER_NODE_HEIGHT,
    CON_NODE_WIDTH,
    CON_NODE_HEIGHT,
} from "../resources/constants";
import { ListenerNodeModel } from "../components/nodes/ListenerNode";
import { ConnectionNodeModel } from "../components/nodes/ConnectionNode";
import {
    CDConnection,
    CDResourceFunction,
    CDFunction,
    CDModel,
    CDService,
    CDWorkflow,
    CDWorkflowEvent,
} from "@wso2/ballerina-core";
import { GQLFuncListType, GQLState, GroupKey, PREVIEW_COUNT, SHOW_ALL_THRESHOLD } from "../components/Diagram";

export function generateEngine(): DiagramEngine {
    const engine = createEngine({
        registerDefaultDeleteItemsAction: false,
        registerDefaultZoomCanvasAction: false,
        registerDefaultPanAndZoomCanvasAction: false,
        // repaintDebounceMs: 100,
    });

    engine.getPortFactories().registerFactory(new NodePortFactory());
    engine.getLinkFactories().registerFactory(new NodeLinkFactory());

    engine.getNodeFactories().registerFactory(new ListenerNodeFactory());
    engine.getNodeFactories().registerFactory(new EntryNodeFactory());
    engine.getNodeFactories().registerFactory(new ConnectionNodeFactory());

    engine.getLayerFactories().registerFactory(new OverlayLayerFactory());

    // engine.getActionEventBus().registerAction(new VerticalScrollCanvasAction());
    return engine;
}

export function autoDistribute(engine: DiagramEngine) {
    const model = engine.getModel();

    // Get all nodes by type. Workflows are laid out in their own column so the edges from
    // their triggers (services/automation) flow left to right without crossing other nodes.
    const listenerNodes = model.getNodes().filter((node) => node.getType() === NodeTypes.LISTENER_NODE);
    const allEntryNodes = model.getNodes().filter((node) => node.getType() === NodeTypes.ENTRY_NODE);
    const entryNodes = allEntryNodes.filter((node) => (node as EntryNodeModel).type !== "workflow");
    const workflowNodes = allEntryNodes.filter((node) => (node as EntryNodeModel).type === "workflow");
    const connectionNodes = model.getNodes().filter((node) => node.getType() === NodeTypes.CONNECTION_NODE);

    // Set X positions for each column: listeners | entry points | workflows | connections.
    // The workflow column collapses when empty.
    const listenerX = 250;
    const entryX = listenerX + LISTENER_NODE_WIDTH + NODE_GAP_X;
    let nextX = entryX + ENTRY_NODE_WIDTH + NODE_GAP_X;
    const workflowX = nextX;
    if (workflowNodes.length > 0) {
        nextX += ENTRY_NODE_WIDTH + NODE_GAP_X;
    }
    const connectionX = nextX;

    // Separate listeners into connected and unconnected
    const connectedListeners: ListenerNodeModel[] = [];
    const unconnectedListeners: ListenerNodeModel[] = [];

    listenerNodes.forEach((node) => {
        const listenerNode = node as ListenerNodeModel;
        const attachedServices = listenerNode.node.attachedServices;

        // Find the attached service nodes
        const serviceNodes = entryNodes.filter((n) => attachedServices.includes(n.getID()));

        if (serviceNodes.length > 0) {
            // Has attached services - position at average Y of services
            const avgY = serviceNodes.reduce((sum, n) => sum + n.getY(), 0) / serviceNodes.length;
            listenerNode.setPosition(listenerX, avgY);
            connectedListeners.push(listenerNode);
        } else {
            // No attached services - will position later
            unconnectedListeners.push(listenerNode);
        }
    });

    // Update X positions for entry nodes while keeping their Y positions
    entryNodes.forEach((node) => {
        const entryNode = node as EntryNodeModel;
        entryNode.setPosition(entryX, entryNode.getY());
    });

    // Position workflow nodes near the entry points that trigger them or send them data,
    // stacking downwards to avoid overlaps
    const workflowsWithDesiredY = workflowNodes.map((node) => {
        const workflowNode = node as EntryNodeModel;
        const workflow = workflowNode.node as CDWorkflow;
        const senderIds = new Set([...(workflow.attachedServices ?? []), ...(workflow.attachedFunctions ?? [])]);
        workflow.events?.forEach((event) => {
            event.attachedServices?.forEach((uuid) => senderIds.add(uuid));
            event.attachedFunctions?.forEach((uuid) => senderIds.add(uuid));
        });
        const senderNodes = entryNodes.filter((n) => senderIds.has(n.getID()));
        const desiredY =
            senderNodes.length > 0
                ? senderNodes.reduce((sum, n) => sum + n.getY(), 0) / senderNodes.length
                : node.getY();
        return { node: workflowNode, desiredY };
    });
    workflowsWithDesiredY.sort((a, b) => a.desiredY - b.desiredY);
    let workflowBottom = -Infinity;
    workflowsWithDesiredY.forEach(({ node, desiredY }) => {
        const y = Math.max(desiredY, workflowBottom + NODE_GAP_Y / 2);
        node.setPosition(workflowX, y);
        workflowBottom = y + (node.height || ENTRY_NODE_HEIGHT);
    });

    // Position connection nodes
    connectionNodes.forEach((node, index) => {
        const connectionNode = node as ConnectionNodeModel;
        connectionNode.setPosition(connectionX, node.getY());
    });

    // Position unconnected listeners below all other nodes
    if (unconnectedListeners.length > 0) {
        // Find the maximum Y position among all nodes
        const allNodes = [...connectedListeners, ...entryNodes, ...workflowNodes, ...connectionNodes];
        let maxY = 100; // Default starting position if no other nodes

        if (allNodes.length > 0) {
            maxY = Math.max(...allNodes.map(node => {
                const nodeHeight = node.height || LISTENER_NODE_HEIGHT;
                return node.getY() + nodeHeight;
            }));
        }

        // Position unconnected listeners below, with spacing
        unconnectedListeners.forEach((listenerNode, index) => {
            const yPosition = maxY + NODE_GAP_Y/2 + (index * (LISTENER_NODE_HEIGHT + NODE_GAP_Y/2));
            listenerNode.setPosition(listenerX, yPosition);
        });
    }

    avoidLinkObstructions(engine);

    engine.repaintCanvas();
}

/** Minimum clearance kept between a rerouted link and the edge of the node it detours around. */
export const LINK_DETOUR_MARGIN = 16;

/**
 * Shared row metrics for the plain entry/workflow body layout: a fixed-height header block,
 * then a uniform-height row per function/event, optionally followed by a "view all" row (see
 * `Node`/`Box`/`FunctionBoxWrapper` in `nodes/EntryNode/components/styles.ts` and the row
 * components in `GeneralWidget.tsx`). `calculateEntryNodeHeight`/`calculateWorkflowNodeHeight`
 * (which size a node) and `getPortAnchorY` (which locates a specific row's port for link
 * routing) both derive from these same numbers so the two can't drift out of sync.
 */
const ROW_PADDING = 8;
const ENTRY_HEADER_HEIGHT = 64 + ROW_PADDING;
const ENTRY_ROW_HEIGHT = 40 + ROW_PADDING;
const ENTRY_VIEW_ALL_BUTTON_HEIGHT = 40;

export interface BoundingBox {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

/**
 * Returns a node's on-canvas box. Entry/workflow nodes always carry an explicit `.height`
 * (computed from their content - see calculateEntryNodeHeight/calculateWorkflowNodeHeight), but
 * connection and listener nodes never set the model's width/height fields (their box comes from
 * fixed CSS sizing instead), so those fall back to the matching size constants.
 */
export function getNodeBoundingBox(node: NodeModel): BoundingBox {
    const type = node.getType();
    const defaultWidth = type === NodeTypes.CONNECTION_NODE
        ? CON_NODE_WIDTH
        : type === NodeTypes.LISTENER_NODE
            ? LISTENER_NODE_WIDTH
            : ENTRY_NODE_WIDTH;
    const defaultHeight = type === NodeTypes.CONNECTION_NODE
        ? CON_NODE_HEIGHT
        : type === NodeTypes.LISTENER_NODE
            ? LISTENER_NODE_HEIGHT
            : ENTRY_NODE_HEIGHT;
    const width = node.width || defaultWidth;
    const height = node.height || defaultHeight;
    return {
        left: node.getX(),
        right: node.getX() + width,
        top: node.getY(),
        bottom: node.getY() + height,
    };
}

/**
 * Returns the Y coordinate a link actually leaves/enters a node at, based on the specific port
 * it's attached to - not just the node's box center.
 *
 * The generic in/out ports (and, for `ai:Service` nodes, their single function port - see
 * `AIServiceWidget.tsx`) sit at the node's true vertical center, because `Node` is a flex *row*
 * with those ports as its first/last children (see `styles.ts`). But `GeneralServiceWidget`
 * stacks function rows and workflow event rows in a column *below* the header (`FunctionBox` /
 * `WorkflowEventBox`, each wrapped in a `FunctionBoxWrapper`), so a link attached to one of
 * those specific ports actually leaves from that row's own Y - which can be well below the
 * node's center for a short node with few rows. Treating it as centered is exactly what let a
 * function-row link cut through an unrelated node sitting below where the node's center
 * happened to be.
 *
 * `GraphQLServiceWidget` groups functions under collapsible per-group headers whose layout
 * depends on live UI state (which groups are open) that this layout pass has no access to, so
 * GraphQL function/group ports still fall back to the node-center approximation - a known,
 * narrower gap than the one this function fixes.
 */
export function getPortAnchorY(node: NodeModel, port: PortModel | null | undefined): number {
    const box = getNodeBoundingBox(node);
    const center = (box.top + box.bottom) / 2;
    if (!port || !(node instanceof EntryNodeModel)) {
        return center;
    }

    if (port === node.getInPort() || port === node.getOutPort()) {
        return center;
    }

    if (node.type === "workflow") {
        const events = (node.node as CDWorkflow).events ?? [];
        const eventIndex = events.findIndex((event) => node.getEventPort(event) === port);
        if (eventIndex === -1) {
            return center; // workflow nodes have no other row-level ports
        }
        return box.top + ENTRY_HEADER_HEIGHT + eventIndex * ENTRY_ROW_HEIGHT + ENTRY_ROW_HEIGHT / 2;
    }

    const service = node.node as CDService;
    if (service?.type === "ai:Service" || service?.type === "graphql:Service") {
        return center;
    }

    if (port === node.getViewAllResourcesPort()) {
        // Only ever linked while collapsed, in which case exactly PREVIEW_COUNT rows are
        // visible above it (see partitionRegularServiceFunctions in Diagram.tsx).
        return box.top + ENTRY_HEADER_HEIGHT + PREVIEW_COUNT * ENTRY_ROW_HEIGHT + ENTRY_VIEW_ALL_BUTTON_HEIGHT / 2;
    }

    // A specific function's own port. Ports are added in the same order functions are shown in
    // (see EntryNodeModel's constructor and partitionRegularServiceFunctions in Diagram.tsx),
    // and a function is only ever linked via its own port while visible, so its position among
    // the node's out-ports - after the leading generic "out" port - is exactly its row index.
    const rowIndex = node.getOutPorts().indexOf(port as NodePortModel) - 1;
    if (rowIndex >= 0) {
        return box.top + ENTRY_HEADER_HEIGHT + rowIndex * ENTRY_ROW_HEIGHT + ENTRY_ROW_HEIGHT / 2;
    }

    return center;
}

/**
 * Samples per bezier segment used when asking where a link actually runs. A segment spans a few
 * hundred px at most in this layout, so ~64 chords keep the polyline within a small fraction of a
 * pixel of the true curve - far finer than the node boxes (>= 64px tall) being tested against.
 */
const CURVE_SAMPLES_PER_SEGMENT = 64;

/**
 * Whether the segment `a`-`b` touches `box`, via Liang-Barsky parametric clipping: the segment
 * enters the box's X slab over `t` in `[txEnter, txExit]` and its Y slab over `[tyEnter, tyExit]`,
 * and intersects the box exactly when those two ranges overlap inside `[0, 1]`. A segment running
 * parallel to a slab (`delta === 0`) either lies within it for all `t` or misses it entirely.
 */
function segmentIntersectsBox(a: Point2D, b: Point2D, box: BoundingBox): boolean {
    let enter = 0;
    let exit = 1;
    const slabs: Array<[number, number, number, number]> = [
        [b.x - a.x, a.x, box.left, box.right],
        [b.y - a.y, a.y, box.top, box.bottom],
    ];
    for (const [delta, origin, low, high] of slabs) {
        if (delta === 0) {
            if (origin < low || origin > high) {
                return false;
            }
            continue;
        }
        const t1 = (low - origin) / delta;
        const t2 = (high - origin) / delta;
        enter = Math.max(enter, Math.min(t1, t2));
        exit = Math.min(exit, Math.max(t1, t2));
        if (enter > exit) {
            return false;
        }
    }
    return true;
}

/** Whether the curve NodeLinkModel would draw through `points` passes through `box`. */
function curveCrossesBox(points: Point2D[], box: BoundingBox): boolean {
    const polyline = sampleBezierPath(points, CURVE_SAMPLES_PER_SEGMENT);
    return polyline.some((point, index) => index > 0 && segmentIntersectsBox(polyline[index - 1], point, box));
}

/**
 * autoDistribute() lays nodes out in fixed left-to-right columns. Whenever a link's endpoints sit
 * in non-adjacent columns - e.g. an automation or a service function linking straight to a
 * connection while the workflow column exists in between - the link can cut right through an
 * unrelated node occupying a column it skips over. This pass finds those links and adds two
 * waypoints that route them through the nearest free vertical gap in the offending column
 * instead - above or below whichever node(s) are in the way - rather than through it.
 *
 * It is a general geometric check (it doesn't know or care that the "workflow" column is the one
 * usually in the way, so it keeps working if more columns are ever inserted between existing
 * ones), and it asks the question against the curve NodeLinkModel actually paints, by sampling
 * the very same bezier segments (see sampleBezierPath / getBezierSegments) rather than against
 * the straight chord between the link's endpoints.
 *
 * Testing the chord is what this pass used to do, and it is *not* a safe approximation: with a
 * horizontal tangent forced at both ends, a link deliberately bows away from its chord by up to
 * half the segment's height. A `GET /f` function row linking to the lower of two connections
 * passed 0.3px clear of a stacked workflow node's top edge as a chord while the drawn curve
 * entered that node by 4.4px - visible as a link clipping the box's corner, with this pass
 * reporting nothing wrong. Sampling the real curve removes that whole class of near-miss by
 * construction, instead of trying to cover the bow with a bigger clearance margin.
 */
export function avoidLinkObstructions(engine: DiagramEngine) {
    const model = engine.getModel();
    const allNodes = model.getNodes() as NodeModel[];
    const links = model.getLinks().filter((linkModel): linkModel is NodeLinkModel => linkModel instanceof NodeLinkModel);

    links.forEach((link) => {
        // Every link starts life with exactly 2 points (see NodeLinkModel/DefaultLinkModel), but
        // guard against being run more than once over the same link.
        link.removeMiddlePoints();

        const sourceNode = link.sourceNode;
        const targetNode = link.targetNode;
        if (!sourceNode || !targetNode || sourceNode === targetNode) {
            return;
        }

        const sourceBox = getNodeBoundingBox(sourceNode);
        const targetBox = getNodeBoundingBox(targetNode);
        const sourceAnchorY = getPortAnchorY(sourceNode, link.getSourcePort());
        const targetAnchorY = getPortAnchorY(targetNode, link.getTargetPort());

        // Out/function ports sit on their node's inner (facing) edge and in-ports on the target's,
        // so a link spans horizontally from one box's edge to the other's. Which one is on the
        // left is read off the layout rather than assumed, so this stays correct for a link ever
        // drawn right-to-left.
        const sourceIsLeft = sourceBox.left <= targetBox.left;
        const leftBox = sourceIsLeft ? sourceBox : targetBox;
        const rightBox = sourceIsLeft ? targetBox : sourceBox;
        const anchorLeft = { x: leftBox.right, y: sourceIsLeft ? sourceAnchorY : targetAnchorY };
        const anchorRight = { x: rightBox.left, y: sourceIsLeft ? targetAnchorY : sourceAnchorY };
        if (anchorRight.x <= anchorLeft.x) {
            return; // same or overlapping columns - no horizontal span for anything to sit in
        }

        // Every node whose X-range overlaps the link's own horizontal span at all. Since a
        // segment's curve never leaves the span between its endpoints' X coordinates (see
        // getBezierSegments), no other node can possibly be crossed - and defining the set by
        // overlap rather than by "sits strictly between the two columns" is what makes the detour
        // construction below provably safe.
        const obstructions = allNodes
            .filter((node) => node !== sourceNode && node !== targetNode)
            .map(getNodeBoundingBox)
            .filter((box) => box.right > anchorLeft.x && box.left < anchorRight.x);
        const straightCurve = [anchorLeft, anchorRight];
        if (!obstructions.some((box) => curveCrossesBox(straightCurve, box))) {
            return;
        }

        // Route around every overlapping node - not just the one(s) the curve happens to cross -
        // so the detour lane is guaranteed clear of all of their siblings too.
        const columnLeft = Math.min(...obstructions.map((box) => box.left));
        const columnRight = Math.max(...obstructions.map((box) => box.right));
        const detourX = NODE_GAP_X / 4;

        // The detour is only sound while both bend points land inside the link's own span and
        // outside every obstruction's X-range, which is what confines its outer segments to
        // obstruction-free horizontal bands (see the safety argument below). In the current
        // column layout that always holds for a real obstruction: columns are disjoint X-bands
        // separated by NODE_GAP_X, and this link's span runs from one column's right edge to
        // another's left edge, so an overlapping node's column is wholly inside the span with a
        // full NODE_GAP_X of slack at each end. Bailing out is still the right answer if that ever
        // stops being true - a bend point placed past its own endpoint would fold the link back on
        // itself, which reads far worse than the crossing it was trying to avoid.
        if (columnLeft - detourX <= anchorLeft.x || columnRight + detourX >= anchorRight.x) {
            return;
        }

        // Where the link currently runs as it passes the obstructing column - the lane closest to
        // this is the one that disturbs the link's shape least.
        const columnCenterX = (columnLeft + columnRight) / 2;
        const naiveY = sampleBezierPath(straightCurve, CURVE_SAMPLES_PER_SEGMENT)
            .reduce((closest, point) =>
                Math.abs(point.x - columnCenterX) < Math.abs(closest.x - columnCenterX) ? point : closest
            ).y;

        // Every Y band the lane must stay out of: each obstruction's box inflated by the clearance
        // margin, with overlapping bands merged. Merging - rather than assuming the boxes are
        // disjoint and more than 2x the margin apart - is what guarantees the chosen lane clears
        // *all* of them: two nodes sitting closer together than that (or overlapping outright, as
        // nodes in different columns caught by the span test may well do) collapse into a single
        // blocked band instead of leaving a phantom gap between them for the lane to land in.
        const blockedBands = obstructions
            .map((box) => ({ top: box.top - LINK_DETOUR_MARGIN, bottom: box.bottom + LINK_DETOUR_MARGIN }))
            .sort((a, b) => a.top - b.top)
            .reduce<Array<{ top: number; bottom: number }>>((bands, band) => {
                const previous = bands[bands.length - 1];
                if (previous && band.top <= previous.bottom) {
                    previous.bottom = Math.max(previous.bottom, band.bottom);
                    return bands;
                }
                bands.push({ ...band });
                return bands;
            }, []);

        // The free lanes between those bands: above the first, between each consecutive pair, and
        // below the last. Merging leaves every interior lane with real room in it, and the two
        // unbounded outer lanes mean there is always at least one candidate.
        const lanes = [
            { top: -Infinity, bottom: blockedBands[0].top },
            ...blockedBands.slice(1).map((band, index) => ({ top: blockedBands[index].bottom, bottom: band.top })),
            { top: blockedBands[blockedBands.length - 1].bottom, bottom: Infinity },
        ];

        // Pick whichever free lane requires the smallest detour from where the link runs now.
        let laneY = naiveY;
        let bestDistance = Infinity;
        lanes.forEach((lane) => {
            const candidateY = Math.min(Math.max(naiveY, lane.top), lane.bottom);
            const distance = Math.abs(candidateY - naiveY);
            if (distance < bestDistance) {
                bestDistance = distance;
                laneY = candidateY;
            }
        });

        // Why the resulting `source -> bend1 -> bend2 -> target` link is clear of every
        // obstruction, without needing to re-test the new curve:
        // - The middle segment is flat at laneY (its endpoints share that Y - see
        //   getBezierSegments), and laneY sits at least LINK_DETOUR_MARGIN clear of every
        //   obstruction's box by construction of the lanes above.
        // - The outer segments stay within their own endpoints' X spans, [anchorLeft.x, columnLeft
        //   - detourX] and [columnRight + detourX, anchorRight.x]. No obstruction reaches either
        //   band: columnLeft/columnRight are the extremes of the whole obstruction set, so every
        //   obstruction's box lies inside [columnLeft, columnRight]. And nothing outside that set
        //   can be crossed either, since the set already includes everything overlapping the
        //   link's span.
        link.point(columnLeft - detourX, laneY, 1);
        link.point(columnRight + detourX, laneY, 2);
    });
}

function getGraphQLGroupLabel(accessor?: string, name?: string): GroupKey | null {
    if (accessor === "get") return "Query";
    if (accessor === "subscribe") return "Subscription";
    if (!accessor && name) return "Mutation";
    return null;
}

function partitionRegularServiceFunctions(
    service: CDService,
    expandedNodes: Set<string>
): { visible: Array<CDFunction | CDResourceFunction>; hidden: Array<CDFunction | CDResourceFunction> } {
    const serviceFunctions: Array<CDFunction | CDResourceFunction> = [];
    if (service.remoteFunctions?.length) serviceFunctions.push(...service.remoteFunctions);
    if (service.resourceFunctions?.length) serviceFunctions.push(...service.resourceFunctions);

    const isExpanded = expandedNodes.has(service.uuid);
    if (serviceFunctions.length <= SHOW_ALL_THRESHOLD || isExpanded) {
        return { visible: serviceFunctions, hidden: [] };
    }
    return { visible: serviceFunctions.slice(0, PREVIEW_COUNT), hidden: serviceFunctions.slice(PREVIEW_COUNT) };
}

function partitionGraphQLServiceFunctions(
    service: CDService,
    expandedNodes: Set<string>,
    groupOpen?: { Query: boolean; Subscription: boolean; Mutation: boolean; }
): { visible: GQLFuncListType; hidden: GQLFuncListType } {
    const serviceFunctions: Array<CDFunction | CDResourceFunction> = [];
    if (service.remoteFunctions?.length) serviceFunctions.push(...service.remoteFunctions);
    if (service.resourceFunctions?.length) serviceFunctions.push(...service.resourceFunctions);

    const grouped = serviceFunctions.reduce((acc, fn) => {
        const accessor = (fn as CDResourceFunction).accessor;
        const name = (fn as CDFunction).name;
        const group = getGraphQLGroupLabel(accessor, name);
        if (!group) return acc;
        (acc[group] ||= []).push(fn);
        return acc;
    }, {} as GQLFuncListType);

    const visible: GQLFuncListType = {
        Query: [],
        Subscription: [],
        Mutation: [],
    };
    const hidden: GQLFuncListType = {
        Query: [],
        Subscription: [],
        Mutation: [],
    };

    (Object.keys(grouped) as GroupKey[]).forEach((group) => {
        const items = grouped[group];
        const isOpen = groupOpen ? !!groupOpen[group] : true; // default open if not provided
        if (!isOpen) {
            hidden[group].push(...items);
            return;
        }
        const groupExpanded = expandedNodes.has(service.uuid + group);
        if (items.length <= SHOW_ALL_THRESHOLD || groupExpanded) {
            visible[group].push(...items);
        } else {
            visible[group].push(...items.slice(0, PREVIEW_COUNT));
            hidden[group].push(...items.slice(PREVIEW_COUNT));
        }
    });

    return { visible, hidden };
}

function createFunctionConnections(
    funcs: Array<CDFunction | CDResourceFunction>,
    nodes: NodeModel[],
    node: EntryNodeModel,
    portGetter: (func: CDFunction | CDResourceFunction, group?: GroupKey) => any,
    links: NodeLinkModel[],
    group?: GroupKey
) {
    funcs.forEach((func) => {
        [...(func.connections ?? []), ...(func.workflows ?? [])].forEach((targetUuid) => {
            const targetNode = nodes.find((n) => n.getID() === targetUuid);
            if (targetNode) {
                const port = portGetter(func, group);
                if (port) {
                    const link = createPortNodeLink(node, port, targetNode);
                    if (link) {
                        links.push(link);
                    }
                }
            }
        });
        // link workflow:sendData calls to the specific data event of the workflow
        Object.entries(func.workflowSendData ?? {}).forEach(([workflowUuid, eventNames]) => {
            const workflowNode = nodes.find((n) => n.getID() === workflowUuid) as EntryNodeModel;
            if (!workflowNode) {
                return;
            }
            eventNames.forEach((eventName) => {
                const port = portGetter(func, group);
                if (!port) {
                    return;
                }
                const eventPort = workflowNode.getEventPortByName(eventName);
                if (eventPort) {
                    const link = createPortsLink(port, eventPort);
                    link.setSourceNode(node);
                    link.setTargetNode(workflowNode);
                    links.push(link);
                }
            });
        });
        // workflow:sendData calls whose data event cannot be matched are drawn as broken links
        func.invalidWorkflowSendData?.forEach((workflowUuid) => {
            const workflowNode = nodes.find((n) => n.getID() === workflowUuid);
            if (workflowNode) {
                const port = portGetter(func, group);
                if (port) {
                    const link = createPortNodeLink(node, port, workflowNode, { visible: true, broken: true });
                    if (link) {
                        links.push(link);
                    }
                }
            }
        });
    });
}

/**
 * Builds the full node/link graph for `project` - the same pipeline `Diagram.tsx` uses to feed
 * `drawDiagram`/`autoDistribute`, extracted as a pure, engine-independent function so it can be
 * driven directly by tests (see `checkNoLinkCrossesAnyNode` in `test/linkOverlapChecker.ts`)
 * without needing a React render. `Diagram.tsx`'s own `getDiagramData` is a thin wrapper around
 * this that supplies its own component state for `expandedNodes`/`graphQLGroupOpen`.
 */
export function buildDiagramData(
    project: CDModel,
    expandedNodes: Set<string>,
    graphQLGroupOpen: Record<string, GQLState>
): { nodes: NodeModel[]; links: NodeLinkModel[] } {
    const nodes: NodeModel[] = [];
    const links: NodeLinkModel[] = [];

    // filtered autogenerated connections and connections with enableFlowModel as false
    const filteredConnections = project.connections?.filter((connection) =>
        !connection.symbol?.startsWith("_") && connection.enableFlowModel !== false
    );
    // Sort and create connections
    const sortedConnections = sortItems(filteredConnections || []) as CDConnection[];
    sortedConnections.forEach((connection, index) => {
        const node = new ConnectionNodeModel(connection);
        node.setPosition(0, 100 + index * 100);
        nodes.push(node);
    });

    let startY = 100;

    // Create workflow nodes first so service function rows can link to them.
    // Their edges are created after the services and the automation below.
    // Filter autogenerated workflows, mirroring the connection filtering above
    const filteredWorkflows = project.workflows?.filter(
        (workflow) => !workflow.symbol?.startsWith("_") && workflow.enableFlowModel !== false
    );
    const sortedWorkflows = sortItems(filteredWorkflows || []) as CDWorkflow[];
    let workflowStartY = 100;
    sortedWorkflows.forEach((workflow) => {
        const workflowNode = new EntryNodeModel(workflow, "workflow");
        const numRows = (workflow.events?.length ?? 0) + (workflow.humanTasks?.length ?? 0);
        const nodeHeight = calculateWorkflowNodeHeight(numRows);
        workflowNode.height = nodeHeight;
        workflowNode.setPosition(0, workflowStartY);
        nodes.push(workflowNode);
        workflowStartY += nodeHeight + 16;
    });

    // Sort services by sortText before creating nodes
    const sortedServices = sortItems(project.services || []) as CDService[];
    sortedServices.forEach((service) => {
        // Create entry node with calculated height
        const node = new EntryNodeModel(service, "service");

        const isGraphQL = service.type === "graphql:Service";
        if (isGraphQL) {
            const { visible, hidden } = partitionGraphQLServiceFunctions(
                service,
                expandedNodes,
                graphQLGroupOpen[service.uuid] ?? { Query: true, Subscription: false, Mutation: false }
            );
            // Reusable function to create connections for a list of functions to a given port getter
            const nodeHeight = calculateGraphQLNodeHeight(
                visible,
                hidden,
                graphQLGroupOpen[service.uuid] || { Query: true, Subscription: false, Mutation: false });

            node.height = nodeHeight;
            node.setPosition(0, startY);
            nodes.push(node);
            startY += nodeHeight + 16;

            // For GraphQL, handle visible and hidden per group
            (Object.keys(visible) as GroupKey[]).forEach((group) => {
                createFunctionConnections(
                    visible[group],
                    nodes,
                    node,
                    (func) => node.getFunctionPort(func),
                    links,
                    group
                );
            });

            (Object.keys(hidden) as GroupKey[]).forEach((group) => {
                createFunctionConnections(
                    hidden[group],
                    nodes,
                    node,
                    (_func, grp) => node.getGraphQLGroupPort(grp!),
                    links,
                    group
                );
            });

        } else {

            // Calculate height based on visible functions and expansion state
            const totalFunctions = service.remoteFunctions.length + service.resourceFunctions.length;
            const isExpanded = expandedNodes.has(service.uuid);
            const nodeHeight = calculateEntryNodeHeight(totalFunctions, isExpanded);
            node.height = nodeHeight;
            node.setPosition(0, startY);
            nodes.push(node);

            startY += nodeHeight + 16;

            const { hidden, visible } = partitionRegularServiceFunctions(service, expandedNodes);
            createFunctionConnections(
                visible,
                nodes,
                node,
                (func) => node.getFunctionPort(func),
                links
            );

            if (hidden.length > 0) {
                createFunctionConnections(
                    hidden,
                    nodes,
                    node,
                    () => node.getViewAllResourcesPort(),
                    links
                );
            }
        }
    });
    // create automation
    const automation = project.automation;
    if (automation) {
        const automationNode = new EntryNodeModel(automation, "automation");
        nodes.push(automationNode);
        // link connections
        automation.connections?.forEach((connectionUuid) => {
            const connectionNode = nodes.find((node) => node.getID() === connectionUuid);
            if (connectionNode) {
                const link = createNodesLink(automationNode, connectionNode);
                if (link) {
                    links.push(link);
                }
            }
        });
    }

    // create workflow edges
    sortedWorkflows.forEach((workflow) => {
        const workflowNode = nodes.find((node) => node.getID() === workflow.uuid) as EntryNodeModel;
        if (!workflowNode) {
            return;
        }

        // link the services that trigger this workflow via workflow:run. When a specific
        // function of the service runs the workflow, the link is already drawn from the
        // function row (createFunctionConnections); only fall back to a service-level edge
        const serviceFunctionLinksTo = (service: CDService, workflowUuid: string) =>
            [...(service.remoteFunctions ?? []), ...(service.resourceFunctions ?? [])].some((func) =>
                func.workflows?.includes(workflowUuid)
            );
        workflow.attachedServices?.forEach((serviceUuid) => {
            const service = project.services?.find((item) => item.uuid === serviceUuid);
            if (service && serviceFunctionLinksTo(service, workflow.uuid)) {
                return;
            }
            const triggerNode = nodes.find((node) => node.getID() === serviceUuid);
            if (triggerNode) {
                const link = createNodesLink(triggerNode, workflowNode);
                if (link) {
                    links.push(link);
                }
            }
        });

        // link the automation that triggers this workflow via workflow:run
        workflow.attachedFunctions?.forEach((triggerUuid) => {
            const triggerNode = nodes.find((node) => node.getID() === triggerUuid);
            if (triggerNode) {
                const link = createNodesLink(triggerNode, workflowNode);
                if (link) {
                    links.push(link);
                }
            }
        });

        // draw broken links for workflow:sendData calls whose data event cannot be matched.
        // Edges from a specific service function row are already drawn by createFunctionConnections
        const serviceFunctionInvalidSendsTo = (service: CDService, workflowUuid: string) =>
            [...(service.remoteFunctions ?? []), ...(service.resourceFunctions ?? [])].some((func) =>
                func.invalidWorkflowSendData?.includes(workflowUuid)
            );
        const invalidSenderUuids = [
            ...(workflow.invalidSendDataServices ?? []).filter((serviceUuid) => {
                const service = project.services?.find((item) => item.uuid === serviceUuid);
                return !(service && serviceFunctionInvalidSendsTo(service, workflow.uuid));
            }),
            ...(workflow.invalidSendDataFunctions ?? []),
        ];
        invalidSenderUuids.forEach((senderUuid) => {
            const senderNode = nodes.find((node) => node.getID() === senderUuid);
            if (senderNode) {
                const link = createNodesLink(senderNode, workflowNode, { visible: true, broken: true });
                if (link) {
                    links.push(link);
                }
            }
        });

        // link the entry points that send data to this workflow via workflow:sendData. Edges
        // from a specific service function row are already drawn by createFunctionConnections;
        // only fall back to a service-level edge when no function row carries the link
        const serviceFunctionSendsTo = (service: CDService, workflowUuid: string, eventName: string) =>
            [...(service.remoteFunctions ?? []), ...(service.resourceFunctions ?? [])].some((func) =>
                func.workflowSendData?.[workflowUuid]?.includes(eventName)
            );
        workflow.events?.forEach((event) => {
            const eventPort = workflowNode.getEventPort(event);
            if (!eventPort) {
                return;
            }
            const senderUuids = [
                ...(event.attachedServices ?? []).filter((serviceUuid) => {
                    const service = project.services?.find((item) => item.uuid === serviceUuid);
                    return !(service && serviceFunctionSendsTo(service, workflow.uuid, event.name));
                }),
                ...(event.attachedFunctions ?? []),
            ];
            senderUuids.forEach((senderUuid) => {
                const senderNode = nodes.find((node) => node.getID() === senderUuid);
                if (senderNode && senderNode.getOutPort()) {
                    const link = createPortsLink(senderNode.getOutPort(), eventPort);
                    link.setSourceNode(senderNode);
                    link.setTargetNode(workflowNode);
                    links.push(link);
                }
            });
        });

        // link this workflow to the connections used by its activities. Activities are not
        // rendered on the overview — only the derived workflow → connection edges are drawn.
        // Direct connections (e.g. a durable agent's model provider) are linked the same way.
        const linkedConnections = new Set<string>();
        workflow.connections?.forEach((connectionUuid) => {
            if (linkedConnections.has(connectionUuid)) {
                return;
            }
            linkedConnections.add(connectionUuid);
            const connectionNode = nodes.find((node) => node.getID() === connectionUuid);
            if (connectionNode) {
                const link = createNodesLink(workflowNode, connectionNode);
                if (link) {
                    links.push(link);
                }
            }
        });
        workflow.activities?.forEach((activityUuid) => {
            const activity = project.activities?.find((item) => item.uuid === activityUuid);
            activity?.connections?.forEach((connectionUuid) => {
                if (linkedConnections.has(connectionUuid)) {
                    return;
                }
                linkedConnections.add(connectionUuid);
                const connectionNode = nodes.find((node) => node.getID() === connectionUuid);
                if (connectionNode) {
                    const link = createNodesLink(workflowNode, connectionNode);
                    if (link) {
                        links.push(link);
                    }
                }
            });
        });
    });

    // create listeners
    project.listeners?.forEach((listener) => {
        const node = new ListenerNodeModel(listener);
        nodes.push(node);
        // link services
        listener.attachedServices.forEach((serviceUuid) => {
            const serviceNode = nodes.find((node) => node.getID() === serviceUuid);
            if (serviceNode) {
                const link = createNodesLink(node, serviceNode);
                if (link) {
                    links.push(link);
                }
            }
        });
    });

    return { nodes, links };
}

export function registerListeners(engine: DiagramEngine) {
    engine.getModel().registerListener({
        offsetUpdated: (event: any) => {
            saveDiagramZoomAndPosition(engine.getModel());
        },
    });
}

export function genDagreEngine() {
    return new DagreEngine({
        graph: {
            rankdir: "LR",
            nodesep: 120,
            ranksep: 400,
            marginx: 100,
            marginy: 100,
            // ranker: "longest-path",
        },
    });
}

export function sortItems<T extends { sortText?: string }>(items: T[]): T[] {
    return [...items].sort((a, b) => {
        if (!a.sortText && !b.sortText) return 0;
        if (!a.sortText) return 1;
        if (!b.sortText) return -1;

        // Split the sortText into filename and number parts
        const [aFile, aNum] = a.sortText.split(".bal");
        const [bFile, bNum] = b.sortText.split(".bal");

        // First compare filenames
        if (aFile !== bFile) {
            return aFile.localeCompare(bFile);
        }

        // If filenames are same, compare numbers
        const aNumber = parseInt(aNum || "0", 10);
        const bNumber = parseInt(bNum || "0", 10);
        return aNumber - bNumber;
    });
}

// create link between ports
export function createPortsLink(sourcePort: NodePortModel, targetPort: NodePortModel, options?: NodeLinkModelOptions) {
    const link = new NodeLinkModel(options);
    link.setSourcePort(sourcePort);
    link.setTargetPort(targetPort);
    sourcePort.addLink(link);
    return link;
}

// create link between nodes
export function createNodesLink(sourceNode: NodeModel, targetNode: NodeModel, options?: NodeLinkModelOptions) {
    const sourcePort = sourceNode.getOutPort();
    const targetPort = targetNode.getInPort();
    if (!sourcePort || !targetPort) {
        return null;
    }
    const link = createPortsLink(sourcePort, targetPort, options);
    link.setSourceNode(sourceNode);
    link.setTargetNode(targetNode);
    return link;
}

// create link between a specific port on `sourceNode` (e.g. one function's out-port) and `targetNode`'s in-port
export function createPortNodeLink(
    sourceNode: NodeModel,
    port: NodePortModel,
    targetNode: NodeModel,
    options?: NodeLinkModelOptions
) {
    const targetPort = targetNode.getInPort();
    if (!targetPort) {
        return null;
    }
    const link = createPortsLink(port, targetPort, options);
    link.setSourceNode(sourceNode);
    link.setTargetNode(targetNode);
    return link;
}

// save diagram zoom level and position to local storage
export const saveDiagramZoomAndPosition = (model: DiagramModel) => {
    const zoomLevel = model.getZoomLevel();
    const offsetX = model.getOffsetX();
    const offsetY = model.getOffsetY();

    // Store them in localStorage
    localStorage.setItem("diagram-zoom-level", JSON.stringify(zoomLevel));
    localStorage.setItem("diagram-offset-x", JSON.stringify(offsetX));
    localStorage.setItem("diagram-offset-y", JSON.stringify(offsetY));
};

// load diagram zoom level and position from local storage
export const loadDiagramZoomAndPosition = (engine: DiagramEngine) => {
    const zoomLevel = JSON.parse(localStorage.getItem("diagram-zoom-level") || "100");
    const offsetX = JSON.parse(localStorage.getItem("diagram-offset-x") || "0");
    const offsetY = JSON.parse(localStorage.getItem("diagram-offset-y") || "0");

    engine.getModel().setZoomLevel(zoomLevel);
    engine.getModel().setOffset(offsetX, offsetY);
};

// check local storage has zoom level and position
export const hasDiagramZoomAndPosition = (file: string) => {
    return localStorage.getItem("diagram-file-path") === file;
};

export const resetDiagramZoomAndPosition = (file?: string) => {
    if (file) {
        localStorage.setItem("diagram-file-path", file);
    }
    localStorage.setItem("diagram-zoom-level", "100");
    localStorage.setItem("diagram-offset-x", "0");
    localStorage.setItem("diagram-offset-y", "0");
};

export const centerDiagram = (engine: DiagramEngine) => {
    if (engine.getCanvas()?.getBoundingClientRect) {
        // zoom to fit nodes and center diagram
        engine.zoomToFitNodes({ margin: 40, maxZoom: 1 });
    }
};

export const getModelId = (nodeId: string) => {
    return nodeId.split("-").pop();
};

// calculate entry node height based on number of functions
export const calculateEntryNodeHeight = (numFunctions: number, isExpanded: boolean) => {
    if (isExpanded) {
        return ENTRY_HEADER_HEIGHT + numFunctions * ENTRY_ROW_HEIGHT + ROW_PADDING + ENTRY_VIEW_ALL_BUTTON_HEIGHT;
    }

    if (numFunctions <= 2) {
        return ENTRY_HEADER_HEIGHT + numFunctions * ENTRY_ROW_HEIGHT + ROW_PADDING;
    }

    return ENTRY_HEADER_HEIGHT + 2 * ENTRY_ROW_HEIGHT + ROW_PADDING + ENTRY_VIEW_ALL_BUTTON_HEIGHT;
};

export const calculateGraphQLNodeHeight = (
    visible: GQLFuncListType,
    hidden: GQLFuncListType,
    graphQLGroupOpen: GQLState
) => {
    const PADDING = 8;
    const BASE_HEIGHT = 64 + 2 * PADDING;
    const FUNCTION_HEIGHT = 40 + PADDING;
    const SHOW_BUTTON_HEIGHT = 40;
    const HEADER_HEIGHT = 45 + 2 * PADDING;

    let totalHeight = BASE_HEIGHT;

    Object.keys(visible).forEach((group) => {
        const visibleCount = visible[group].length;
        const hiddenCount = hidden[group].length;
        const hasShowML = visibleCount > PREVIEW_COUNT || hiddenCount > 0;
        const isCollapsed = !graphQLGroupOpen[group];
        const hasSection = visibleCount > 0 || hiddenCount > 0;
        const hasFunction = visibleCount > 0;

        let sectionHeight = 0;

        if (hasSection) {
            if (isCollapsed) {
                sectionHeight = HEADER_HEIGHT;
            } else {
                if (hasFunction) {
                    sectionHeight += HEADER_HEIGHT;
                    sectionHeight += visibleCount * FUNCTION_HEIGHT;
                }
                if (hasShowML) {
                    sectionHeight += SHOW_BUTTON_HEIGHT;
                }
            }
        }

        totalHeight += sectionHeight;
    });

    return totalHeight;
};

export const getEntryNodeFunctionPortName = (func: CDFunction | CDResourceFunction) => {
    if ((func as CDResourceFunction).accessor) {
        return (func as CDResourceFunction).accessor + "-" + (func as CDResourceFunction).path;
    }
    return (func as CDFunction).name;
};

export const getWorkflowEventPortNameByEventName = (eventName: string) => {
    return "event-" + eventName;
};

export const getWorkflowEventPortName = (event: CDWorkflowEvent) => {
    return getWorkflowEventPortNameByEventName(event.name);
};

// calculate workflow node height based on the number of event and human task rows
export const calculateWorkflowNodeHeight = (numRows: number) => {
    return ENTRY_HEADER_HEIGHT + numRows * ENTRY_ROW_HEIGHT + (numRows > 0 ? ROW_PADDING : 0);
};

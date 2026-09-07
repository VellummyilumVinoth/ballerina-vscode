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

import { DefaultLinkModel } from "@projectstorm/react-diagrams";
import { ThemeColors } from "@wso2/ui-toolkit";
import { NODE_LINK } from "../../resources/constants";
import { NodeModel } from "../../utils/types";

export const LINK_BOTTOM_OFFSET = 30;

/**
 * Corner radius used to round the interior bend points of a multi-point (detour) link - see
 * `buildRoundedPolylinePath`. Chosen against this diagram's scale (node gaps of 160px, a
 * LINK_DETOUR_MARGIN of 16px in utils/diagram.ts): visibly rounds the corner without the curve
 * eating a meaningful chunk of the detour's clearance margin.
 */
export const LINK_CORNER_RADIUS = 28;

export interface Point2D {
    x: number;
    y: number;
}

function pointDistance(a: Point2D, b: Point2D): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
}

/** The point on the ray from `from` towards `towards`, `distance` along it (clamped to not pass `towards`). */
function pointAtDistanceTowards(from: Point2D, towards: Point2D, distance: number): Point2D {
    const dx = towards.x - from.x;
    const dy = towards.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length === 0 || distance <= 0) {
        return { x: from.x, y: from.y };
    }
    const t = Math.min(distance, length) / length;
    return { x: from.x + dx * t, y: from.y + dy * t };
}

/**
 * Builds an SVG path through `points` (length >= 3) as straight segments, but rounds every
 * *interior* point - i.e. every point except the first and last, which are real port endpoints
 * rather than corners `avoidLinkObstructions` introduced - into a quadratic-bezier "cut corner",
 * using the original sharp corner itself as the curve's control point:
 *
 *   ... L approach  Q corner.x corner.y  departure.x departure.y  L ...
 *
 * where `approach`/`departure` sit `radius` back from the corner along its incoming/outgoing
 * segment (clamped so a short segment can never make the two corners at its ends overlap).
 *
 * That choice of control point is what makes the rounding safe to layer on top of
 * avoidLinkObstructions' collision math without touching it: a quadratic Bezier is, at every t,
 * a convex combination of its start, control, and end points - so the curve can never leave the
 * triangle (approach, corner, departure). Since the original sharp corner sits exactly on the
 * boundary of that triangle, the curve can only move *inward* from it (towards the line joining
 * approach and departure), never bulge outward past where the sharp-cornered path already was.
 * The sharp-cornered path was routed with LINK_DETOUR_MARGIN of clearance from the obstruction it
 * avoids, so the rounded path is always at least as clear - see the "never reduces clearance"
 * test in NodeLinkModel.test.ts, which doesn't just assert this from the geometry argument but
 * samples the actual curve and checks it against the straight-polyline version.
 */
export function buildRoundedPolylinePath(points: Point2D[], radius: number): string {
    const [start, ...rest] = points;
    let path = `M ${start.x} ${start.y}`;
    let cursor = start;

    // rest = [interior point(s)..., end]; every element except the last is an interior corner.
    for (let i = 0; i < rest.length - 1; i++) {
        const corner = rest[i];
        const next = rest[i + 1];
        // Clamp to at most half of *either* adjacent segment so the approach/departure points
        // of neighbouring corners can never cross each other on a short shared segment.
        const r = Math.min(radius, pointDistance(cursor, corner) / 2, pointDistance(corner, next) / 2);
        const approach = pointAtDistanceTowards(corner, cursor, r);
        const departure = pointAtDistanceTowards(corner, next, r);
        path += ` L ${approach.x} ${approach.y} Q ${corner.x} ${corner.y} ${departure.x} ${departure.y}`;
        cursor = departure;
    }

    const end = rest[rest.length - 1];
    path += ` L ${end.x} ${end.y}`;
    return path;
}

export interface NodeLinkModelOptions {
    label?: string;
    visible: boolean;
    broken?: boolean;
    // neutral dashed link (e.g. a read-only interaction with a durable agent)
    dashed?: boolean;
    onAddClick?: () => void;
}

export class NodeLinkModel extends DefaultLinkModel {
    sourceNode: NodeModel;
    targetNode: NodeModel;
    // options
    label: string;
    visible = true;
    // marks a link that cannot be resolved statically (e.g. a workflow:sendData call whose
    // data event name does not match any event declared by the workflow)
    broken = false;
    dashed = false;
    // call back
    onAddClick?: () => void;

    constructor(label?: string);
    constructor(options: NodeLinkModelOptions);
    constructor(options: NodeLinkModelOptions | string) {
        super({
            type: NODE_LINK,
            width: 10,
            color: ThemeColors.PRIMARY,
            selectedColor: ThemeColors.SECONDARY,
            curvyness: 0,
        });
        if (options) {
            if (typeof options === "string" && options.length > 0) {
                this.label = options;
            } else {
                if ((options as NodeLinkModelOptions).label) {
                    this.label = (options as NodeLinkModelOptions).label;
                }
                if ((options as NodeLinkModelOptions).visible === false) {
                    this.visible = (options as NodeLinkModelOptions).visible;
                }
                if ((options as NodeLinkModelOptions).broken) {
                    this.broken = true;
                }
                if ((options as NodeLinkModelOptions).dashed) {
                    this.dashed = true;
                }
            }
            if ((options as NodeLinkModelOptions).onAddClick) {
                this.onAddClick = (options as NodeLinkModelOptions).onAddClick;
            }
        }
    }

    setSourceNode(node: NodeModel) {
        this.sourceNode = node;
    }

    setTargetNode(node: NodeModel) {
        this.targetNode = node;
    }

    /**
     * DefaultLinkModel.getSVGPath() only knows how to draw a single bezier curve between
     * exactly 2 points, so it silently returns undefined for any link carrying extra waypoints.
     * Waypoints get added by avoidLinkObstructions() (see utils/diagram.ts) to route a link
     * around a node it would otherwise cut through. The common 2-point case is left untouched
     * and simply delegates to the base implementation.
     *
     * For a link with waypoints, the path is a straight polyline through every point, but with
     * each interior waypoint (the bends avoidLinkObstructions actually introduced - never the
     * first/last point, which are real port endpoints) rounded into a short curve rather than a
     * sharp corner - see buildRoundedPolylinePath for how and why that's safe to do without
     * touching avoidLinkObstructions' collision math.
     */
    getSVGPath(): string {
        const points = this.getPoints();
        if (points.length <= 2) {
            return super.getSVGPath();
        }
        return buildRoundedPolylinePath(
            points.map((point) => point.getPosition()),
            LINK_CORNER_RADIUS
        );
    }
}

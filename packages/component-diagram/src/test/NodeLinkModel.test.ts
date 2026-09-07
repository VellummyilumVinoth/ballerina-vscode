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

import { NodeLinkModel, buildRoundedPolylinePath, LINK_CORNER_RADIUS, Point2D } from "../components/NodeLink/NodeLinkModel";
import { ENTRY_NODE_WIDTH, NODE_GAP_X } from "../resources/constants";

interface Box {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

/** Straight-line distance from a point to the nearest edge/corner of an axis-aligned box (0 if inside). Reimplemented independently of production code, for the safety check below. */
function distanceToBox(p: Point2D, box: Box): number {
    const dx = Math.max(box.left - p.x, 0, p.x - box.right);
    const dy = Math.max(box.top - p.y, 0, p.y - box.bottom);
    return Math.hypot(dx, dy);
}

/** Evaluates a quadratic Bezier (start, control, end) at t, reimplemented independently of production code. */
function quadraticBezierAt(start: Point2D, control: Point2D, end: Point2D, t: number): Point2D {
    const mt = 1 - t;
    return {
        x: mt * mt * start.x + 2 * mt * t * control.x + t * t * end.x,
        y: mt * mt * start.y + 2 * mt * t * control.y + t * t * end.y,
    };
}

function samplePoints(count: number): number[] {
    const ts: number[] = [];
    for (let i = 0; i <= count; i++) {
        ts.push(i / count);
    }
    return ts;
}

/** Builds a plain NodeLinkModel with exactly the given points (no ports attached). */
function buildLinkWithPoints(points: Point2D[]): NodeLinkModel {
    const link = new NodeLinkModel({ visible: true });
    link.getFirstPoint().setPosition(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
        link.point(points[i].x, points[i].y, i);
    }
    link.getLastPoint().setPosition(points[points.length - 1].x, points[points.length - 1].y);
    return link;
}

describe("NodeLinkModel.getSVGPath", () => {
    test("a 2-point link still delegates to the base bezier implementation, unchanged", () => {
        const link = buildLinkWithPoints([{ x: 10, y: 20 }, { x: 300, y: 220 }]);
        // DefaultLinkModel.getSVGPath() builds a bezier curve straight from point to point when
        // there are exactly 2 points (curvyness is always 0 for this app, so it's a straight
        // line drawn as a degenerate bezier). Confirm we still get exactly that, not our own
        // rounded-polyline logic, for the common case.
        expect(link.getSVGPath()).toBe("M10 20 C10 20, 300 220, 300 220");
    });

    test("rounds each interior point into a quadratic bezier using the original corner as control point", () => {
        // Mirrors a real avoidLinkObstructions detour: entry node (automation) -> workflow column
        // (obstruction) -> connection, using this diagram's actual column-spacing constants.
        const start: Point2D = { x: ENTRY_NODE_WIDTH, y: 32 };
        const corner1: Point2D = { x: ENTRY_NODE_WIDTH + NODE_GAP_X - NODE_GAP_X / 4, y: 84 };
        const corner2: Point2D = { x: ENTRY_NODE_WIDTH + NODE_GAP_X + ENTRY_NODE_WIDTH + NODE_GAP_X / 4, y: 84 };
        const end: Point2D = { x: 2 * (ENTRY_NODE_WIDTH + NODE_GAP_X) + ENTRY_NODE_WIDTH, y: 232 };

        const path = buildRoundedPolylinePath([start, corner1, corner2, end], LINK_CORNER_RADIUS);

        expect(path.startsWith(`M ${start.x} ${start.y} `)).toBe(true);
        expect(path.trim().endsWith(`L ${end.x} ${end.y}`)).toBe(true);

        const qMatches = [...path.matchAll(/Q ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)/g)];
        expect(qMatches).toHaveLength(2);

        // The control point of each Q must be exactly the original sharp corner - that's the
        // property that keeps the curve inside the (approach, corner, departure) triangle.
        expect(Number(qMatches[0][1])).toBe(corner1.x);
        expect(Number(qMatches[0][2])).toBe(corner1.y);
        expect(Number(qMatches[1][1])).toBe(corner2.x);
        expect(Number(qMatches[1][2])).toBe(corner2.y);

        // The approach/departure points sit strictly between the corner and its neighbour (not
        // at the neighbour itself, not past the corner).
        const lMatches = [...path.matchAll(/L ([\d.-]+) ([\d.-]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
        const [approach1] = lMatches; // the L immediately before the first Q
        expect(approach1.x).toBeGreaterThan(start.x);
        expect(approach1.x).toBeLessThan(corner1.x);
        expect(approach1.y).toBeGreaterThan(start.y);
        expect(approach1.y).toBeLessThan(corner1.y);
    });

    test("clamps the radius so a very short detour lane never produces overlapping/crossing curves", () => {
        // The two corners are only 10px apart - far less than 2 * LINK_CORNER_RADIUS - so
        // naively using the full radius at both ends would make the approach/departure points
        // cross over each other.
        const start: Point2D = { x: 0, y: 0 };
        const corner1: Point2D = { x: 100, y: 50 };
        const corner2: Point2D = { x: 110, y: 50 };
        const end: Point2D = { x: 300, y: 200 };

        const path = buildRoundedPolylinePath([start, corner1, corner2, end], LINK_CORNER_RADIUS);
        const qMatches = [...path.matchAll(/Q ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)/g)];
        const lMatches = [...path.matchAll(/L ([\d.-]+) ([\d.-]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
        expect(qMatches).toHaveLength(2);

        // departure1 (corner1's exit point, on the shared middle segment) is the end-point of
        // the first Q command; approach2 (corner2's entry point, also on that same segment) is
        // the L immediately following it. On a lane this short, an unclamped radius would push
        // departure1 past approach2, making the curves cross - assert they don't.
        const departure1 = { x: Number(qMatches[0][3]), y: Number(qMatches[0][4]) };
        const approach2 = lMatches[1];
        expect(departure1.x).toBeLessThanOrEqual(approach2.x);
    });

    test("never reduces clearance from the obstruction the corner was routed around", () => {
        // Same realistic detour shape as above, with the workflow-shaped obstruction box that
        // determined where the lane (Y=84) and the two corners actually sit.
        const start: Point2D = { x: 240, y: 32 };
        const corner1: Point2D = { x: 360, y: 84 };
        const corner2: Point2D = { x: 680, y: 84 };
        const end: Point2D = { x: 800, y: 232 };
        const obstruction: Box = { left: 400, right: 640, top: 100, bottom: 172 };

        // Sanity: the box really is what the lane was routed around (16px margin, matching
        // LINK_DETOUR_MARGIN in utils/diagram.ts), and the straight polyline actually crosses it.
        expect(obstruction.top - corner1.y).toBe(16);

        const path = buildRoundedPolylinePath([start, corner1, corner2, end], LINK_CORNER_RADIUS);
        const qMatches = [...path.matchAll(/Q ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)/g)];
        const lMatches = [...path.matchAll(/L ([\d.-]+) ([\d.-]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));

        // corner1's curve: approach (first L) -> corner1 (control) -> its own departure (first Q's end)
        const approach1 = lMatches[0];
        const departure1 = { x: Number(qMatches[0][3]), y: Number(qMatches[0][4]) };
        // corner2's curve: approach (the L right after the first Q) -> corner2 -> departure
        const approach2 = lMatches[1];
        const departure2 = { x: Number(qMatches[1][3]), y: Number(qMatches[1][4]) };

        [
            { label: "corner1", straightA: approach1, corner: corner1, straightB: departure1 },
            { label: "corner2", straightA: approach2, corner: corner2, straightB: departure2 },
        ].forEach(({ straightA, corner, straightB }) => {
            const ts = samplePoints(50);

            const curveMinDistance = Math.min(
                ...ts.map((t) => distanceToBox(quadraticBezierAt(straightA, corner, straightB, t), obstruction))
            );
            // The straight-polyline equivalent this curve replaced: two straight segments,
            // (straightA -> corner) and (corner -> straightB), sampled the same way.
            const straightMinDistance = Math.min(
                ...ts.map((t) => distanceToBox({ x: straightA.x + (corner.x - straightA.x) * t, y: straightA.y + (corner.y - straightA.y) * t }, obstruction)),
                ...ts.map((t) => distanceToBox({ x: corner.x + (straightB.x - corner.x) * t, y: corner.y + (straightB.y - corner.y) * t }, obstruction))
            );

            // Never *closer* than the sharp-cornered path was (a tiny epsilon absorbs float error).
            expect(curveMinDistance).toBeGreaterThanOrEqual(straightMinDistance - 1e-9);
        });
    });
});

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

import { DiagramModel } from "@projectstorm/react-diagrams";
import { CDAutomation, CDConnection, CDLocation, CDResourceFunction, CDService, CDWorkflow } from "@wso2/ballerina-core";
import {
    avoidLinkObstructions,
    calculateEntryNodeHeight,
    calculateWorkflowNodeHeight,
    createNodesLink,
    createPortNodeLink,
    generateEngine,
    getPortAnchorY,
    LINK_DETOUR_MARGIN,
} from "../utils/diagram";
import { EntryNodeModel } from "../components/nodes/EntryNode";
import { ConnectionNodeModel } from "../components/nodes/ConnectionNode";
import { NodeLinkModel } from "../components/NodeLink";
import { ENTRY_NODE_WIDTH, NODE_GAP_X } from "../resources/constants";

// Reproduces PR #689's 4-column layout (listener | entry | workflow | connection): the entry
// and workflow columns are adjacent, so a fixed gap of NODE_GAP_X puts the connection column far
// enough right that a node can genuinely sit "in between" an entry node and a connection node.
const ENTRY_X = 0;
const WORKFLOW_X = ENTRY_X + ENTRY_NODE_WIDTH + NODE_GAP_X;
const CONNECTION_X = WORKFLOW_X + ENTRY_NODE_WIDTH + NODE_GAP_X;

const emptyLocation: CDLocation = {
    filePath: "",
    startLine: { line: 0, offset: 0 },
    endLine: { line: 0, offset: 0 },
};

function makeAutomation(uuid: string): CDAutomation {
    return { name: "automation", displayName: "Automation", location: emptyLocation, connections: [], uuid };
}

function makeConnection(uuid: string): CDConnection {
    return { symbol: "conn", location: emptyLocation, scope: "GLOBAL", uuid, enableFlowModel: true, sortText: "" };
}

function makeWorkflow(uuid: string): CDWorkflow {
    return {
        symbol: "workflow",
        location: emptyLocation,
        attachedServices: [],
        attachedFunctions: [],
        events: [],
        humanTasks: [],
        uuid,
        enableFlowModel: true,
        sortText: "",
    };
}

function makeResourceFunction(accessor: string, path: string): CDResourceFunction {
    return { accessor, path, location: emptyLocation, connections: [] };
}

function makeService(uuid: string, resourceFunctions: CDResourceFunction[], type = "http:Service"): CDService {
    return {
        location: emptyLocation,
        attachedListeners: [],
        connections: [],
        functions: [],
        remoteFunctions: [],
        resourceFunctions,
        absolutePath: "",
        type,
        icon: "",
        uuid,
        enableFlowModel: true,
        sortText: "",
    };
}

/** Builds a link between two nodes on a fresh engine/model and runs the pass under test. */
function runObstructionPass(nodes: Array<EntryNodeModel | ConnectionNodeModel>, link: NodeLinkModel) {
    const engine = generateEngine();
    const model = new DiagramModel();
    model.addAll(...nodes, link);
    engine.setModel(model);
    avoidLinkObstructions(engine);
    return link;
}

describe("avoidLinkObstructions", () => {
    test("routes a link around a workflow node sitting between its source and target columns", () => {
        const automationNode = new EntryNodeModel(makeAutomation("automation-1"), "automation");
        automationNode.setPosition(ENTRY_X, 0); // box: [0, 64]

        const workflowNode = new EntryNodeModel(makeWorkflow("workflow-1"), "workflow");
        workflowNode.height = calculateWorkflowNodeHeight(0);
        workflowNode.setPosition(WORKFLOW_X, 100); // box: [100, 172]

        const connectionNode = new ConnectionNodeModel(makeConnection("connection-1"));
        connectionNode.setPosition(CONNECTION_X, 200); // box: [200, 264]

        const link = createNodesLink(automationNode, connectionNode) as NodeLinkModel;
        expect(link.getPoints()).toHaveLength(2);

        runObstructionPass([automationNode, workflowNode, connectionNode], link);

        const points = link.getPoints();
        expect(points).toHaveLength(4);

        const [, bendA, bendB] = points;
        const laneY = bendA.getPosition().y;

        // Both bend points form one horizontal lane across the workflow column.
        expect(bendB.getPosition().y).toBeCloseTo(laneY);
        expect(bendA.getPosition().x).toBeLessThan(WORKFLOW_X);
        expect(bendB.getPosition().x).toBeGreaterThan(WORKFLOW_X + ENTRY_NODE_WIDTH);

        // The chosen lane must clear the workflow node's box (with margin), not cut through it.
        const workflowTop = 100;
        const workflowBottom = 172;
        const clearsAbove = laneY <= workflowTop - LINK_DETOUR_MARGIN;
        const clearsBelow = laneY >= workflowBottom + LINK_DETOUR_MARGIN;
        expect(clearsAbove || clearsBelow).toBe(true);
    });

    test("leaves a direct link untouched when nothing sits between its columns", () => {
        const automationNode = new EntryNodeModel(makeAutomation("automation-1"), "automation");
        automationNode.setPosition(ENTRY_X, 0);

        const connectionNode = new ConnectionNodeModel(makeConnection("connection-1"));
        connectionNode.setPosition(WORKFLOW_X, 0); // adjacent column, nothing in between

        const link = createNodesLink(automationNode, connectionNode) as NodeLinkModel;

        runObstructionPass([automationNode, connectionNode], link);

        expect(link.getPoints()).toHaveLength(2);
    });

    test("leaves a link untouched when an intermediate-column node doesn't lie on its path", () => {
        const automationNode = new EntryNodeModel(makeAutomation("automation-1"), "automation");
        automationNode.setPosition(ENTRY_X, 0); // box: [0, 64]

        const connectionNode = new ConnectionNodeModel(makeConnection("connection-1"));
        connectionNode.setPosition(CONNECTION_X, 0); // box: [0, 64] - same band as automation

        // Workflow sits far below the straight line between automation and the connection.
        const workflowNode = new EntryNodeModel(makeWorkflow("workflow-1"), "workflow");
        workflowNode.height = calculateWorkflowNodeHeight(0);
        workflowNode.setPosition(WORKFLOW_X, 1000);

        const link = createNodesLink(automationNode, connectionNode) as NodeLinkModel;

        runObstructionPass([automationNode, workflowNode, connectionNode], link);

        expect(link.getPoints()).toHaveLength(2);
    });

    test("clears every node in the column when multiple workflow nodes stack in the way", () => {
        const automationNode = new EntryNodeModel(makeAutomation("automation-1"), "automation");
        automationNode.setPosition(ENTRY_X, 0); // box: [0, 64]

        const workflowNodeA = new EntryNodeModel(makeWorkflow("workflow-1"), "workflow");
        workflowNodeA.height = calculateWorkflowNodeHeight(0);
        workflowNodeA.setPosition(WORKFLOW_X, 80); // box: [80, 152]

        const workflowNodeB = new EntryNodeModel(makeWorkflow("workflow-2"), "workflow");
        workflowNodeB.height = calculateWorkflowNodeHeight(0);
        workflowNodeB.setPosition(WORKFLOW_X, 168); // box: [168, 240], directly below A with only margin-sized gap

        const connectionNode = new ConnectionNodeModel(makeConnection("connection-1"));
        connectionNode.setPosition(CONNECTION_X, 300); // box: [300, 364]

        const link = createNodesLink(automationNode, connectionNode) as NodeLinkModel;

        runObstructionPass([automationNode, workflowNodeA, workflowNodeB, connectionNode], link);

        const points = link.getPoints();
        expect(points).toHaveLength(4);
        const laneY = points[1].getPosition().y;

        const clearsA = laneY <= 80 - LINK_DETOUR_MARGIN || laneY >= 152 + LINK_DETOUR_MARGIN;
        const clearsB = laneY <= 168 - LINK_DETOUR_MARGIN || laneY >= 240 + LINK_DETOUR_MARGIN;
        expect(clearsA).toBe(true);
        expect(clearsB).toBe(true);
    });
});

describe("getPortAnchorY", () => {
    test("anchors a plain function port at its own body row, not the node's center", () => {
        const func = makeResourceFunction("get", "f");
        const serviceNode = new EntryNodeModel(makeService("service-1", [func]), "service");
        serviceNode.height = calculateEntryNodeHeight(1, false); // 128
        serviceNode.setPosition(0, 0); // box: [0, 128], center: 64

        const functionPort = serviceNode.getFunctionPort(func);
        const rowAnchorY = getPortAnchorY(serviceNode, functionPort);

        // Header block (72) + half of the first body row (48/2) - see ENTRY_HEADER_HEIGHT /
        // ENTRY_ROW_HEIGHT in utils/diagram.ts, shared with calculateEntryNodeHeight.
        expect(rowAnchorY).toBe(96);
        expect(rowAnchorY).not.toBe(64); // must not fall back to the node's vertical center
    });

    test("anchors the generic in/out ports at the node's true vertical center", () => {
        const serviceNode = new EntryNodeModel(makeService("service-1", [makeResourceFunction("get", "f")]), "service");
        serviceNode.height = calculateEntryNodeHeight(1, false);
        serviceNode.setPosition(0, 0); // box: [0, 128], center: 64

        expect(getPortAnchorY(serviceNode, serviceNode.getInPort())).toBe(64);
        expect(getPortAnchorY(serviceNode, serviceNode.getOutPort())).toBe(64);
    });

    test("anchors a workflow event port at its own body row", () => {
        const event = { name: "dataReady", attachedServices: [], attachedFunctions: [] };
        const workflow: CDWorkflow = { ...makeWorkflow("workflow-1"), events: [event] };
        const workflowNode = new EntryNodeModel(workflow, "workflow");
        workflowNode.height = calculateWorkflowNodeHeight(1);
        workflowNode.setPosition(0, 0); // box top: 0

        const eventPort = workflowNode.getEventPort(event);
        expect(getPortAnchorY(workflowNode, eventPort)).toBe(96); // same row math as a function port
    });

    test("falls back to the node center for ports it can't statically place (e.g. GraphQL)", () => {
        const func = makeResourceFunction("get", "f");
        const gqlNode = new EntryNodeModel(makeService("gql-1", [func], "graphql:Service"), "service");
        gqlNode.height = 200;
        gqlNode.setPosition(0, 0); // center: 100

        const functionPort = gqlNode.getFunctionPort(func);
        expect(getPortAnchorY(gqlNode, functionPort)).toBe(100);
    });
});

describe("avoidLinkObstructions with a real function port (createPortNodeLink)", () => {
    test("routes a service function's link around a workflow node the node-center approximation would have missed", () => {
        // A single-function service's function row anchors well below its own center (see the
        // "anchors a plain function port" test above: row=96 vs center=64 for this exact shape).
        // Regression for the escalation where GET/f -> httpServiceClient visibly crossed a
        // workflow node even though the (old, node-center-based) obstruction check found nothing
        // wrong - because it looked at the wrong Y entirely, not because bending itself was broken.
        const func = makeResourceFunction("get", "f");
        const serviceNode = new EntryNodeModel(makeService("service-1", [func]), "service");
        serviceNode.height = calculateEntryNodeHeight(1, false); // 128
        serviceNode.setPosition(ENTRY_X, 0); // box: [0, 128], center: 64, function row: 96

        const connectionNode = new ConnectionNodeModel(makeConnection("connection-1"));
        connectionNode.setPosition(CONNECTION_X, 64); // box: [64, 128], center: 96

        // Deliberately thin, and positioned to straddle only the TRUE (row-based, flat at Y=96)
        // straight line - not the old center-based one (center=64 -> center=96 slopes upward,
        // crossing the workflow column at Y=~80, well outside this box). If this node were ever
        // wrongly treated as "not in the way", this test would catch it.
        const workflowNode = new EntryNodeModel(makeWorkflow("workflow-1"), "workflow");
        workflowNode.height = 16;
        workflowNode.setPosition(WORKFLOW_X, 88); // box: [88, 104] - contains 96, excludes ~80

        const functionPort = serviceNode.getFunctionPort(func);
        const link = createPortNodeLink(serviceNode, functionPort, connectionNode) as NodeLinkModel;
        expect(link.getPoints()).toHaveLength(2);

        // createPortNodeLink must wire sourceNode/targetNode to the actual owning nodes, not both
        // to the target - avoidLinkObstructions silently no-ops otherwise (sourceNode === targetNode).
        expect(link.sourceNode).toBe(serviceNode);
        expect(link.targetNode).toBe(connectionNode);

        runObstructionPass([serviceNode, workflowNode, connectionNode], link);

        const points = link.getPoints();
        expect(points).toHaveLength(4);
        const laneY = points[1].getPosition().y;
        const clearsWorkflow = laneY <= 88 - LINK_DETOUR_MARGIN || laneY >= 104 + LINK_DETOUR_MARGIN;
        expect(clearsWorkflow).toBe(true);
    });
});

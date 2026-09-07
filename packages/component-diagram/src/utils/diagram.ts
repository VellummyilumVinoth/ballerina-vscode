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
import { NodeLinkFactory, NodeLinkModel, NodeLinkModelOptions } from "../components/NodeLink";
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
    CDService,
    CDWorkflow,
    CDWorkflowEvent,
} from "@wso2/ballerina-core";
import { GQLFuncListType, GQLState, PREVIEW_COUNT } from "../components/Diagram";

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

interface BoundingBox {
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
function getNodeBoundingBox(node: NodeModel): BoundingBox {
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
 * autoDistribute() lays nodes out in fixed left-to-right columns, but every link is still a
 * plain straight line between its source and target port (NodeLinkModel always uses curvyness:
 * 0, and nothing else ever adds waypoints). Whenever a link's endpoints sit in non-adjacent
 * columns - e.g. an automation or a service function linking straight to a connection while the
 * workflow column exists in between - that straight line can cut right through an unrelated
 * node occupying the column it skips over.
 *
 * This pass is a general geometric check (it doesn't know or care that the "workflow" column is
 * the one usually in the way, so it keeps working if more columns are ever inserted between
 * existing ones): for every link, it looks for nodes whose column lies strictly between the
 * link's two endpoints, and whose box the straight line would cross. When it finds one, it adds
 * two waypoints that route the link through the nearest free vertical gap in that column instead
 * - above or below whichever node(s) are in the way - rather than through them.
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

        // Columns are always laid out left to right; if the two ends are in the same or
        // adjacent columns there's no room for another node to sit in between them.
        const sourceIsLeft = sourceBox.left <= targetBox.left;
        const leftBox = sourceIsLeft ? sourceBox : targetBox;
        const rightBox = sourceIsLeft ? targetBox : sourceBox;
        if (rightBox.left <= leftBox.right) {
            return;
        }

        const anchorLeft = { x: leftBox.right, y: sourceIsLeft ? sourceAnchorY : targetAnchorY };
        const anchorRight = { x: rightBox.left, y: sourceIsLeft ? targetAnchorY : sourceAnchorY };
        const yAtX = (x: number) => {
            const t = (x - anchorLeft.x) / (anchorRight.x - anchorLeft.x);
            return anchorLeft.y + t * (anchorRight.y - anchorLeft.y);
        };

        // Nodes whose entire column lies strictly between the two endpoints (e.g. the workflow
        // column, when the link skips straight from an entry node to a connection).
        const betweenBoxes = allNodes
            .filter((node) => node !== sourceNode && node !== targetNode)
            .map(getNodeBoundingBox)
            .filter((box) => box.left >= anchorLeft.x && box.right <= anchorRight.x);
        if (betweenBoxes.length === 0) {
            return;
        }

        const crossesBox = (box: BoundingBox) => {
            const lo = Math.min(yAtX(box.left), yAtX(box.right));
            const hi = Math.max(yAtX(box.left), yAtX(box.right));
            return lo <= box.bottom && hi >= box.top;
        };
        if (!betweenBoxes.some(crossesBox)) {
            return;
        }

        // Route around every node physically in that column - not just the one(s) the straight
        // line happens to cross - so the detour lane is guaranteed clear of all of its siblings.
        const columnLeft = Math.min(...betweenBoxes.map((box) => box.left));
        const columnRight = Math.max(...betweenBoxes.map((box) => box.right));
        const naiveY = yAtX((columnLeft + columnRight) / 2);

        const sortedColumn = [...betweenBoxes].sort((a, b) => a.top - b.top);
        const gaps: Array<{ top: number; bottom: number }> = [];
        let cursor = -Infinity;
        sortedColumn.forEach((box) => {
            gaps.push({ top: cursor, bottom: box.top - LINK_DETOUR_MARGIN });
            cursor = box.bottom + LINK_DETOUR_MARGIN;
        });
        gaps.push({ top: cursor, bottom: Infinity });

        // Pick whichever free gap requires the smallest detour from the straight-line Y. A gap
        // whose bottom ends up above its top has no real room in it (two obstructing nodes sit
        // closer together than 2x the margin) and must be skipped, not clamped into.
        let laneY = naiveY;
        let bestDistance = Infinity;
        gaps.filter((gap) => gap.bottom >= gap.top).forEach((gap) => {
            const candidateY = Math.min(Math.max(naiveY, gap.top), gap.bottom);
            const distance = Math.abs(candidateY - naiveY);
            if (distance < bestDistance) {
                bestDistance = distance;
                laneY = candidateY;
            }
        });

        const detourX = NODE_GAP_X / 4;
        link.point(columnLeft - detourX, laneY, 1);
        link.point(columnRight + detourX, laneY, 2);
    });
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

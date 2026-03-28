/**
 * LangGraph factory for the Murmur agent turn loop.
 *
 * The graph encapsulates one decision-complete conversational cycle for a
 * single agent: synchronize transcript/floor state, think, moderate, speak,
 * and then end with the updated listening state for the next invocation.
 */

import {
  END,
  START,
  StateGraph,
} from "@langchain/langgraph";

import { createListenNode } from "./nodes/listen.js";
import { createModerateNode } from "./nodes/moderate.js";
import { createSpeakNode } from "./nodes/speak.js";
import { createThinkNode } from "./nodes/think.js";
import {
  AGENT_GRAPH_NODE_NAMES,
  AgentGraphAnnotation,
  type AgentGraphBindings,
  type AgentGraphState,
} from "./state.js";

/**
 * Stable name assigned to the compiled Murmur agent graph.
 */
export const AGENT_GRAPH_NAME = "murmur-agent-graph";

/**
 * Routes graph execution after the `listen` node.
 *
 * @param state - Current graph state after listen-node synchronization.
 * @returns The next node when the floor is held, otherwise the graph end node.
 */
export function routeAfterListen(
  state: AgentGraphState,
): typeof END | typeof AGENT_GRAPH_NODE_NAMES.think {
  return state.isFloorHolder ? AGENT_GRAPH_NODE_NAMES.think : END;
}

/**
 * Builds and compiles the canonical Murmur agent conversation graph.
 *
 * @param bindings - Caller-owned dependencies for graph side effects.
 * @returns A compiled LangGraph ready for per-turn invocation.
 */
export function createAgentGraph(
  bindings: AgentGraphBindings,
) {
  return new StateGraph(AgentGraphAnnotation)
    .addNode(AGENT_GRAPH_NODE_NAMES.listen, createListenNode(bindings))
    .addNode(AGENT_GRAPH_NODE_NAMES.think, createThinkNode(bindings))
    .addNode(AGENT_GRAPH_NODE_NAMES.moderate, createModerateNode(bindings))
    .addNode(AGENT_GRAPH_NODE_NAMES.speak, createSpeakNode(bindings))
    .addEdge(START, AGENT_GRAPH_NODE_NAMES.listen)
    .addConditionalEdges(AGENT_GRAPH_NODE_NAMES.listen, routeAfterListen)
    .addEdge(AGENT_GRAPH_NODE_NAMES.think, AGENT_GRAPH_NODE_NAMES.moderate)
    .addEdge(AGENT_GRAPH_NODE_NAMES.moderate, AGENT_GRAPH_NODE_NAMES.speak)
    .addEdge(AGENT_GRAPH_NODE_NAMES.speak, END)
    .compile({
      name: AGENT_GRAPH_NAME,
    });
}

/**
 * LangGraph think node for the Murmur agent loop.
 *
 * The think node reads the current rolling transcript context, calls the
 * injected LLM provider, and stores the next candidate response for moderation.
 */

import type { AgentGraphBindings, AgentGraphState } from "../state.js";
import { normalizeRequiredText } from "../state.js";

/**
 * Creates the `think` node with the supplied runtime bindings.
 *
 * @param bindings - Caller-owned dependencies for graph side effects.
 * @returns A LangGraph node that performs one model inference.
 */
export function createThinkNode(bindings: AgentGraphBindings) {
  return async function thinkNode(
    state: AgentGraphState,
  ): Promise<Partial<AgentGraphState>> {
    const roomId = normalizeRequiredText(state.roomId, "state.roomId");

    if (roomId !== bindings.roomId) {
      throw new Error(
        `Graph state roomId "${roomId}" does not match bindings.roomId "${bindings.roomId}".`,
      );
    }

    const requestStartedAt = Date.now();
    const transcriptContext = bindings.contextManager.getContext();
    const responseText = await bindings.llmProvider.generateResponse(
      bindings.agent.personality,
      transcriptContext,
    );
    const normalizedResponse = normalizeRequiredText(
      responseText,
      "LLM response",
    );

    bindings.logger.info(
      {
        agentId: state.agentId,
        latencyMs: Date.now() - requestStartedAt,
        roomId,
        transcriptEntries: state.rollingTranscript.length,
      },
      "Generated agent response in think node.",
    );

    return {
      status: "thinking",
      currentResponse: normalizedResponse,
      currentResponseWasFiltered: false,
    };
  };
}

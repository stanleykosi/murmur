/**
 * LangGraph moderation node for the Murmur agent loop.
 *
 * This node applies the canonical shared moderation filter to the current
 * candidate response before the graph hands the text to the `speak` node.
 */

import { filterContent } from "@murmur/shared";

import type { AgentGraphBindings, AgentGraphState } from "../state.js";
import { normalizeRequiredText } from "../state.js";

/**
 * Creates the `moderate` node with the supplied runtime bindings.
 *
 * @param bindings - Caller-owned dependencies for graph side effects.
 * @returns A LangGraph node that filters the current response text.
 */
export function createModerateNode(bindings: AgentGraphBindings) {
  return async function moderateNode(
    state: AgentGraphState,
  ): Promise<Partial<AgentGraphState>> {
    const currentResponse = normalizeRequiredText(
      state.currentResponse ?? "",
      "state.currentResponse",
    );
    const moderationResult = filterContent(currentResponse);

    if (moderationResult.wasFiltered) {
      bindings.logger.warn(
        {
          agentId: state.agentId,
          roomId: state.roomId,
        },
        "Filtered agent response in moderate node.",
      );
    }

    return {
      status: "thinking",
      currentResponse: moderationResult.clean,
      currentResponseWasFiltered: moderationResult.wasFiltered,
    };
  };
}

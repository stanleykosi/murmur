/**
 * Canonical Redis runtime-key builders shared across Murmur services.
 *
 * This module centralizes the room-scoped Redis namespaces used by the API and
 * agent orchestrator for floor control, mute state, silence tracking, and
 * per-agent last-spoke timestamps. Keeping them in one package prevents cross-
 * service drift as more realtime coordination flows are added.
 */

/**
 * Validates a Redis key segment before interpolating it into a namespaced key.
 *
 * @param value - Candidate identifier supplied by the caller.
 * @param label - Human-readable field name used in fail-fast diagnostics.
 * @returns The trimmed key segment.
 * @throws {Error} When the identifier is not a string or is blank.
 */
function normalizeKeySegment(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return normalizedValue;
}

/**
 * Builds the canonical Redis floor-state key for a room.
 *
 * @param roomId - Room identifier used to namespace the floor hash.
 * @returns The Redis key storing the current floor holder and claim timestamp.
 */
export function getFloorStateKey(roomId: string): string {
  return `floor:${normalizeKeySegment(roomId, "roomId")}`;
}

/**
 * Builds the canonical Redis muted-agent set key for a room.
 *
 * @param roomId - Room identifier used to namespace muted agent membership.
 * @returns The Redis key storing muted agent IDs for the room.
 */
export function getMutedAgentsKey(roomId: string): string {
  return `room:${normalizeKeySegment(roomId, "roomId")}:muted`;
}

/**
 * Builds the canonical Redis silence timer key for a room.
 *
 * @param roomId - Room identifier used to namespace silence tracking.
 * @returns The Redis key storing the most recent silence-start timestamp.
 */
export function getRoomSilenceKey(roomId: string): string {
  return `room:${normalizeKeySegment(roomId, "roomId")}:silence`;
}

/**
 * Builds the canonical Redis last-spoke timestamp key for one agent in a room.
 *
 * @param roomId - Room identifier used to namespace the conversation.
 * @param agentId - Agent identifier used to namespace the participant.
 * @returns The Redis key storing the agent's most recent speech timestamp.
 */
export function getAgentLastSpokeKey(
  roomId: string,
  agentId: string,
): string {
  return `room:${normalizeKeySegment(roomId, "roomId")}:agent:${normalizeKeySegment(agentId, "agentId")}:lastSpoke`;
}

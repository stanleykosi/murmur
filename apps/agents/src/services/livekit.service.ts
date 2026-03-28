/**
 * LiveKit token helpers for the Murmur agents service.
 *
 * The orchestrator connects each agent runner to the room directly, so it must
 * mint its own publish-capable room tokens using the same canonical identity
 * format as the API service.
 */

import { AccessToken } from "livekit-server-sdk";

import { env } from "../config/env.js";

const LIVEKIT_TOKEN_TTL = "24h";

/**
 * Validates and trims a required identifier.
 *
 * @param value - Raw identifier value supplied by the caller.
 * @param label - Human-readable field name for diagnostics.
 * @returns The trimmed identifier value.
 * @throws {Error} When the value is blank or not a string.
 */
function normalizeIdentifier(value: string, label: string): string {
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
 * Creates a publish-and-subscribe LiveKit room token for one agent runner.
 *
 * @param roomId - Murmur room identifier, reused as the LiveKit room name.
 * @param agentId - Persisted Murmur agent identifier.
 * @returns A signed LiveKit JWT for the runner.
 */
export async function createAgentToken(
  roomId: string,
  agentId: string,
): Promise<string> {
  const normalizedRoomId = normalizeIdentifier(roomId, "roomId");
  const normalizedAgentId = normalizeIdentifier(agentId, "agentId");
  const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: `agent_${normalizedAgentId}`,
    ttl: LIVEKIT_TOKEN_TTL,
  });

  token.addGrant({
    room: normalizedRoomId,
    roomJoin: true,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  });

  return await token.toJwt();
}

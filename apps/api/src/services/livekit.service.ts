/**
 * LiveKit token helpers for the Murmur API service.
 *
 * This module owns the canonical server-side token generation flows used to
 * connect listeners and agents to LiveKit rooms. Tokens are issued with a
 * 24-hour TTL and explicit grant sets so the API remains the single authority
 * for transport permissions.
 */

import { AccessToken } from "livekit-server-sdk";

import { env } from "../config/env.js";
import { InternalServerError, ValidationError } from "../lib/errors.js";

const LIVEKIT_TOKEN_TTL = "24h";

/**
 * Normalizes an internal identifier used in downstream transport identities.
 *
 * @param value - Raw identifier value supplied by a caller.
 * @param label - Human-readable identifier label for error messages.
 * @returns The trimmed identifier value.
 * @throws {ValidationError} When the identifier is blank.
 */
function normalizeIdentifier(value: string, label: string): string {
  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new ValidationError(`${label} must be a non-empty string.`);
  }

  return normalizedValue;
}

/**
 * Generates a subscribe-only LiveKit room token for a listener.
 *
 * @param roomId - Murmur room identifier, reused as the LiveKit room name.
 * @param userId - Canonical Murmur user identifier for the listener.
 * @returns A signed JWT that allows joining and subscribing to room media.
 * @throws {ValidationError} When a required identifier is blank.
 * @throws {InternalServerError} When token signing fails unexpectedly.
 */
export async function createListenerToken(
  roomId: string,
  userId: string,
): Promise<string> {
  const normalizedRoomId = normalizeIdentifier(roomId, "roomId");
  const normalizedUserId = normalizeIdentifier(userId, "userId");

  try {
    const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
      identity: `listener_${normalizedUserId}`,
      ttl: LIVEKIT_TOKEN_TTL,
    });

    token.addGrant({
      room: normalizedRoomId,
      roomJoin: true,
      canPublish: false,
      // Keep listeners strictly subscribe-only, including data channels.
      canPublishData: false,
      canSubscribe: true,
    });

    return await token.toJwt();
  } catch (error) {
    throw new InternalServerError(
      "Failed to generate a LiveKit listener token.",
      {
        roomId: normalizedRoomId,
        userId: normalizedUserId,
      },
      error,
    );
  }
}

/**
 * Generates a publish-and-subscribe LiveKit room token for an agent.
 *
 * @param roomId - Murmur room identifier, reused as the LiveKit room name.
 * @param agentId - Canonical Murmur agent identifier.
 * @returns A signed JWT that allows the agent to join, publish, and subscribe.
 * @throws {ValidationError} When a required identifier is blank.
 * @throws {InternalServerError} When token signing fails unexpectedly.
 */
export async function createAgentToken(
  roomId: string,
  agentId: string,
): Promise<string> {
  const normalizedRoomId = normalizeIdentifier(roomId, "roomId");
  const normalizedAgentId = normalizeIdentifier(agentId, "agentId");

  try {
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
  } catch (error) {
    throw new InternalServerError(
      "Failed to generate a LiveKit agent token.",
      {
        agentId: normalizedAgentId,
        roomId: normalizedRoomId,
      },
      error,
    );
  }
}

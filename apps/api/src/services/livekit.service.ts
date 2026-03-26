/**
 * LiveKit token helpers for the Murmur API service.
 *
 * This module owns the canonical server-side token generation flows used to
 * connect listeners and agents to LiveKit rooms, plus the admin-side room
 * deletion flow used when a room is ended. Tokens are issued with a 24-hour
 * TTL and explicit grant sets so the API remains the single authority for
 * transport permissions.
 */

import { AccessToken, RoomServiceClient, TwirpError } from "livekit-server-sdk";

import { env } from "../config/env.js";
import { InternalServerError, ValidationError } from "../lib/errors.js";

const LIVEKIT_TOKEN_TTL = "24h";
const LIVEKIT_ADMIN_REQUEST_TIMEOUT_SECONDS = 10;
let roomServiceClient: RoomServiceClient | null = null;

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
 * Returns the shared LiveKit room-service client used for admin operations.
 *
 * The client is cached for the life of the process because its configuration
 * is immutable after environment validation succeeds.
 *
 * @returns The shared LiveKit room service client.
 */
function getRoomServiceClient(): RoomServiceClient {
  if (roomServiceClient !== null) {
    return roomServiceClient;
  }

  roomServiceClient = new RoomServiceClient(
    env.LIVEKIT_URL,
    env.LIVEKIT_API_KEY,
    env.LIVEKIT_API_SECRET,
    {
      requestTimeout: LIVEKIT_ADMIN_REQUEST_TIMEOUT_SECONDS,
    },
  );

  return roomServiceClient;
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

/**
 * Deletes a LiveKit room used for a Murmur conversation.
 *
 * Retrying an already-deleted room is treated as success so the admin room-end
 * flow can safely resume after partial failures in downstream cleanup steps.
 *
 * @param roomId - Murmur room identifier, reused as the LiveKit room name.
 * @throws {ValidationError} When the room identifier is blank.
 * @throws {InternalServerError} When the LiveKit room-service call fails.
 */
export async function deleteRoom(roomId: string): Promise<void> {
  const normalizedRoomId = normalizeIdentifier(roomId, "roomId");

  try {
    await getRoomServiceClient().deleteRoom(normalizedRoomId);
  } catch (error) {
    if (
      error instanceof TwirpError &&
      (error.code === "not_found" || error.status === 404)
    ) {
      return;
    }

    throw new InternalServerError(
      "Failed to delete the LiveKit room.",
      {
        roomId: normalizedRoomId,
      },
      error,
    );
  }
}

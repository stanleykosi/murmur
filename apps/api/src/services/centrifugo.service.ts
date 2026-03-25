/**
 * Centrifugo integration helpers for the Murmur API service.
 *
 * This module owns the canonical client-token and server-publish flows used by
 * Murmur's transcript and room-lifecycle streams. The Fastify API remains the
 * single writer for Centrifugo events and the only issuer of client JWTs.
 */

import type { RoomEndedEvent, TranscriptEvent } from "@murmur/shared";
import { getTranscriptChannel } from "@murmur/shared";
import jwt from "jsonwebtoken";

import { env } from "../config/env.js";
import { InternalServerError, ValidationError, isAppError } from "../lib/errors.js";

const CENTRIFUGO_CLIENT_TOKEN_TTL = "24h";
const CENTRIFUGO_PUBLISH_TIMEOUT_MS = 5_000;

/**
 * Minimal payload accepted by Centrifugo's publish endpoint.
 */
interface PublishPayload {
  channel: string;
  data: TranscriptEvent | RoomEndedEvent;
}

/**
 * Normalizes an identifier before it is embedded in a JWT or channel payload.
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
 * Builds the Centrifugo HTTP API publish endpoint from the configured base URL.
 *
 * @returns The absolute `/api/publish` endpoint URL.
 */
function buildPublishEndpointUrl(): string {
  const normalizedBaseUrl = env.CENTRIFUGO_API_URL.endsWith("/")
    ? env.CENTRIFUGO_API_URL
    : `${env.CENTRIFUGO_API_URL}/`;

  return new URL("api/publish", normalizedBaseUrl).toString();
}

/**
 * Sends a publish request to Centrifugo and fails fast when the upstream API
 * does not acknowledge the event.
 *
 * @param payload - Channel name and event data to publish.
 * @throws {InternalServerError} When the publish request fails or is rejected.
 */
async function publishToCentrifugo(payload: PublishPayload): Promise<void> {
  let response: Response;

  try {
    response = await fetch(buildPublishEndpointUrl(), {
      method: "POST",
      headers: {
        Authorization: `apikey ${env.CENTRIFUGO_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CENTRIFUGO_PUBLISH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new InternalServerError(
      "Failed to publish an event to Centrifugo.",
      {
        channel: payload.channel,
      },
      error,
    );
  }

  if (response.ok) {
    return;
  }

  const responseBody = await response.text().catch(() => "");

  throw new InternalServerError("Centrifugo rejected the publish request.", {
    channel: payload.channel,
    responseBody,
    statusCode: response.status,
  });
}

/**
 * Creates a signed Centrifugo client token for a listener session.
 *
 * @param userId - Canonical Murmur user identifier embedded as the token `sub`.
 * @returns A signed JWT with a 24-hour expiration.
 * @throws {ValidationError} When the user identifier is blank.
 * @throws {InternalServerError} When token signing fails unexpectedly.
 */
export function createClientToken(userId: string): string {
  const normalizedUserId = normalizeIdentifier(userId, "userId");

  try {
    return jwt.sign(
      {
        sub: normalizedUserId,
      },
      env.CENTRIFUGO_TOKEN_SECRET,
      {
        expiresIn: CENTRIFUGO_CLIENT_TOKEN_TTL,
      },
    );
  } catch (error) {
    throw new InternalServerError(
      "Failed to generate a Centrifugo client token.",
      {
        userId: normalizedUserId,
      },
      error,
    );
  }
}

/**
 * Publishes a transcript event to the canonical room transcript channel.
 *
 * @param roomId - Murmur room identifier whose transcript stream is targeted.
 * @param event - Transcript payload to broadcast.
 * @throws {ValidationError} When the room identifier is blank.
 * @throws {InternalServerError} When Centrifugo publishing fails.
 */
export async function publishTranscript(
  roomId: string,
  event: TranscriptEvent,
): Promise<void> {
  const normalizedRoomId = normalizeIdentifier(roomId, "roomId");

  await publishToCentrifugo({
    channel: getTranscriptChannel(normalizedRoomId),
    data: event,
  });
}

/**
 * Publishes a `room_ended` event to the canonical room transcript channel.
 *
 * @param roomId - Murmur room identifier whose listeners should be notified.
 * @returns The exact event payload that was broadcast.
 * @throws {ValidationError} When the room identifier is blank.
 * @throws {InternalServerError} When Centrifugo publishing fails.
 */
export async function publishRoomEnded(roomId: string): Promise<RoomEndedEvent> {
  const normalizedRoomId = normalizeIdentifier(roomId, "roomId");
  const event: RoomEndedEvent = {
    type: "room_ended",
    roomId: normalizedRoomId,
    endedAt: new Date().toISOString(),
  };

  try {
    await publishToCentrifugo({
      channel: getTranscriptChannel(normalizedRoomId),
      data: event,
    });
  } catch (error) {
    if (isAppError(error)) {
      throw error;
    }

    throw new InternalServerError(
      "Failed to publish a room-ended event to Centrifugo.",
      {
        roomId: normalizedRoomId,
      },
      error,
    );
  }

  return event;
}

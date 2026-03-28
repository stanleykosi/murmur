/**
 * Centrifugo publishing helpers for the Murmur agents service.
 *
 * Agent runners publish transcript events directly so listener-facing realtime
 * updates do not depend on the API process being in the middle of the audio
 * turn loop.
 */

import { getTranscriptChannel, type TranscriptEvent } from "@murmur/shared";

import { env } from "../config/env.js";

const CENTRIFUGO_PUBLISH_TIMEOUT_MS = 5_000;

/**
 * Minimal payload accepted by Centrifugo's publish endpoint.
 */
interface PublishPayload {
  channel: string;
  data: TranscriptEvent;
}

/**
 * Builds the absolute Centrifugo publish endpoint URL.
 *
 * @returns The absolute `/api/publish` URL.
 */
function buildPublishEndpointUrl(): string {
  const normalizedBaseUrl = env.CENTRIFUGO_API_URL.endsWith("/")
    ? env.CENTRIFUGO_API_URL
    : `${env.CENTRIFUGO_API_URL}/`;

  return new URL("api/publish", normalizedBaseUrl).toString();
}

/**
 * Sends one transcript publish request to Centrifugo.
 *
 * @param payload - Channel name and transcript payload to publish.
 * @throws {Error} When the upstream request fails or is rejected.
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
    throw new Error("Failed to publish a transcript event to Centrifugo.", {
      cause: error,
    });
  }

  if (response.ok) {
    return;
  }

  const responseBody = await response.text().catch(() => "");

  throw new Error(
    `Centrifugo rejected the transcript publish request with status ${response.status}. Response body: ${responseBody}`,
  );
}

/**
 * Publishes a transcript event to the canonical room transcript channel.
 *
 * @param event - Transcript event to broadcast.
 */
export async function publishTranscript(event: TranscriptEvent): Promise<void> {
  await publishToCentrifugo({
    channel: getTranscriptChannel(event.roomId),
    data: event,
  });
}

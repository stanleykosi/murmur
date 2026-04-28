/**
 * Cartesia-backed TTS provider for Murmur agents.
 *
 * This module implements the canonical Cartesia Sonic-3 request flow, applies
 * Murmur's shared retry and logging policy, and returns the full PCM payload as
 * a Node.js `Buffer` for later publication into the voice pipeline.
 */

import { env } from "../config/env.js";
import type { TTSProvider } from "./types.js";
import {
  createTtsLogger,
  getErrorStatusCode,
  getRetryDelayMs,
  isRetryableTtsError,
  normalizeError,
  normalizeSynthesisText,
  normalizeVoiceId,
  readResponseBodyAsBuffer,
  readResponseBodyAsText,
  TTS_MAX_ATTEMPTS,
  TTS_REQUEST_TIMEOUT_MS,
  TtsMissingBodyError,
  TtsResponseError,
  type DelayImplementation,
  type FetchImplementation,
  waitForRetryDelay,
} from "./shared.js";

import type { Logger } from "pino";

/**
 * Canonical Cartesia synthesis endpoint.
 */
export const CARTESIA_TTS_ENDPOINT = "https://api.cartesia.ai/tts/bytes";

/**
 * Date-pinned Cartesia API version selected for Murmur's current implementation.
 */
export const CARTESIA_API_VERSION = "2026-03-01";

/**
 * Cartesia model identifier used for all Murmur synthesis requests.
 */
export const CARTESIA_MODEL_ID = "sonic-3";

/**
 * Raw PCM output format requested from Cartesia.
 */
export const CARTESIA_OUTPUT_FORMAT = {
  container: "raw",
  encoding: "pcm_s16le",
  sample_rate: 24_000,
} as const;

const cartesiaLogger = createTtsLogger("tts-cartesia");

/**
 * Cartesia request payload accepted by the `/tts/bytes` endpoint.
 */
interface CartesiaRequestBody {
  model_id: typeof CARTESIA_MODEL_ID;
  transcript: string;
  voice: {
    mode: "id";
    id: string;
  };
  output_format: typeof CARTESIA_OUTPUT_FORMAT;
}

/**
 * Canonical Murmur TTS provider implementation backed by Cartesia Sonic-3.
 */
export class CartesiaTTSProvider implements TTSProvider {
  /**
   * Creates a Cartesia provider with injectable side effects for tests.
   *
   * @param fetchImplementation - Fetch function used for HTTP requests.
   * @param logger - Structured logger for request lifecycle events.
   * @param delay - Delay helper used between retry attempts.
   */
  public constructor(
    private readonly fetchImplementation: FetchImplementation = globalThis.fetch,
    private readonly logger: Logger = cartesiaLogger,
    private readonly delay: DelayImplementation = waitForRetryDelay,
  ) {}

  /**
   * Synthesizes the provided text using a Cartesia voice and returns the
   * collected PCM audio bytes.
   *
   * @param text - Text content to synthesize.
   * @param voiceId - Cartesia voice identifier.
   * @returns A buffer of 24 kHz PCM audio.
   * @throws {Error} When input validation fails or synthesis cannot complete.
   */
  public async synthesize(text: string, voiceId: string): Promise<Buffer> {
    const normalizedText = normalizeSynthesisText(text);
    const normalizedVoiceId = normalizeVoiceId(voiceId);
    const requestStartedAt = Date.now();

    this.logger.info(
      {
        attempt: 1,
        provider: "cartesia",
        textLength: normalizedText.length,
        voiceId: normalizedVoiceId,
      },
      "Started TTS synthesis.",
    );

    for (let attempt = 1; attempt <= TTS_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.fetchImplementation(CARTESIA_TTS_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.CARTESIA_API_KEY}`,
            "Cartesia-Version": CARTESIA_API_VERSION,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            buildCartesiaRequestBody(normalizedText, normalizedVoiceId),
          ),
          signal: AbortSignal.timeout(TTS_REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
          throw new TtsResponseError(
            "Cartesia",
            response.status,
            await readResponseBodyAsText(response),
          );
        }

        const audioBuffer = await readResponseBodyAsBuffer(response, "Cartesia");

        this.logger.info(
          {
            attempt,
            bytes: audioBuffer.length,
            latencyMs: Date.now() - requestStartedAt,
            provider: "cartesia",
            textLength: normalizedText.length,
            voiceId: normalizedVoiceId,
          },
          "Completed TTS synthesis.",
        );

        return audioBuffer;
      } catch (error) {
        if (attempt < TTS_MAX_ATTEMPTS && isRetryableTtsError(error)) {
          const delayMs = getRetryDelayMs(attempt);

          this.logger.warn(
            {
              attempt,
              delayMs,
              latencyMs: Date.now() - requestStartedAt,
              provider: "cartesia",
              statusCode: getErrorStatusCode(error),
              textLength: normalizedText.length,
              voiceId: normalizedVoiceId,
            },
            "Retrying TTS synthesis after a retryable upstream failure.",
          );

          await this.delay(delayMs);
          continue;
        }

        const normalizedError = normalizeError(
          "Unknown Cartesia TTS synthesis failure.",
          error,
        );

        this.logger.error(
          {
            attempt,
            err: normalizedError,
            latencyMs: Date.now() - requestStartedAt,
            provider: "cartesia",
            statusCode: getErrorStatusCode(error),
            textLength: normalizedText.length,
            voiceId: normalizedVoiceId,
          },
          "TTS synthesis failed.",
        );

        throw buildCartesiaFailure(normalizedVoiceId, normalizedError);
      }
    }

    throw new Error(
      `Cartesia TTS synthesis failed for voice "${normalizedVoiceId}" after ${TTS_MAX_ATTEMPTS} attempts.`,
    );
  }
}

/**
 * Builds the canonical Cartesia request payload for a synthesis call.
 *
 * @param text - Trimmed text that should be synthesized.
 * @param voiceId - Trimmed Cartesia voice identifier.
 * @returns The JSON body sent to the Cartesia API.
 */
export function buildCartesiaRequestBody(
  text: string,
  voiceId: string,
): CartesiaRequestBody {
  return {
    model_id: CARTESIA_MODEL_ID,
    transcript: text,
    voice: {
      mode: "id",
      id: voiceId,
    },
    output_format: CARTESIA_OUTPUT_FORMAT,
  };
}

/**
 * Normalizes a terminal Cartesia synthesis failure into a stable error shape.
 *
 * @param voiceId - Cartesia voice identifier associated with the failed call.
 * @param error - Normalized error produced by the request attempt.
 * @returns A new error with Murmur-specific context and the original cause.
 */
function buildCartesiaFailure(voiceId: string, error: Error): Error {
  if (error instanceof TtsResponseError) {
    return new Error(
      `Cartesia TTS synthesis failed for voice "${voiceId}" with status ${error.statusCode}: ${error.responseBody || "No response body returned."}`,
      {
        cause: error,
      },
    );
  }

  if (error instanceof TtsMissingBodyError) {
    return new Error(
      `Cartesia TTS synthesis failed for voice "${voiceId}": ${error.message}`,
      {
        cause: error,
      },
    );
  }

  return new Error(
    `Cartesia TTS synthesis failed for voice "${voiceId}" after ${TTS_MAX_ATTEMPTS} attempts.`,
    {
      cause: error,
    },
  );
}

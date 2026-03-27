/**
 * ElevenLabs-backed TTS provider for Murmur agents.
 *
 * This module implements the canonical ElevenLabs Flash v2.5 streaming
 * synthesis flow, applies Murmur's shared retry and logging policy, and
 * returns the full PCM payload as a Node.js `Buffer`.
 */

import type { Logger } from "pino";

import { env } from "../config/env.js";
import type { TTSProvider } from "./provider.js";
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

/**
 * Canonical ElevenLabs text-to-speech API base URL.
 */
export const ELEVENLABS_TTS_BASE_URL =
  "https://api.elevenlabs.io/v1/text-to-speech";

/**
 * ElevenLabs model identifier used for all Murmur synthesis requests.
 */
export const ELEVENLABS_MODEL_ID = "eleven_flash_v2_5";

/**
 * PCM output format query parameter used for ElevenLabs streaming responses.
 */
export const ELEVENLABS_OUTPUT_FORMAT = "pcm_24000";

const elevenLabsLogger = createTtsLogger("tts-elevenlabs");

/**
 * Canonical Murmur TTS provider implementation backed by ElevenLabs.
 */
export class ElevenLabsTTSProvider implements TTSProvider {
  /**
   * Creates an ElevenLabs provider with injectable side effects for tests.
   *
   * @param fetchImplementation - Fetch function used for HTTP requests.
   * @param logger - Structured logger for request lifecycle events.
   * @param delay - Delay helper used between retry attempts.
   */
  public constructor(
    private readonly fetchImplementation: FetchImplementation = globalThis.fetch,
    private readonly logger: Logger = elevenLabsLogger,
    private readonly delay: DelayImplementation = waitForRetryDelay,
  ) {}

  /**
   * Synthesizes the provided text using an ElevenLabs voice and returns the
   * collected PCM audio bytes.
   *
   * @param text - Text content to synthesize.
   * @param voiceId - ElevenLabs voice identifier.
   * @returns A buffer of 24 kHz PCM audio.
   * @throws {Error} When input validation fails or synthesis cannot complete.
   */
  public async synthesize(text: string, voiceId: string): Promise<Buffer> {
    const normalizedText = normalizeSynthesisText(text);
    const normalizedVoiceId = normalizeVoiceId(voiceId);
    const requestStartedAt = Date.now();
    const requestUrl = buildElevenLabsUrl(normalizedVoiceId);

    this.logger.info(
      {
        attempt: 1,
        provider: "elevenlabs",
        textLength: normalizedText.length,
        voiceId: normalizedVoiceId,
      },
      "Started TTS synthesis.",
    );

    for (let attempt = 1; attempt <= TTS_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.fetchImplementation(requestUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": env.ELEVENLABS_API_KEY,
          },
          body: JSON.stringify({
            model_id: ELEVENLABS_MODEL_ID,
            text: normalizedText,
          }),
          signal: AbortSignal.timeout(TTS_REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
          throw new TtsResponseError(
            "ElevenLabs",
            response.status,
            await readResponseBodyAsText(response),
          );
        }

        const audioBuffer = await readResponseBodyAsBuffer(
          response,
          "ElevenLabs",
        );

        this.logger.info(
          {
            attempt,
            bytes: audioBuffer.length,
            latencyMs: Date.now() - requestStartedAt,
            provider: "elevenlabs",
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
              provider: "elevenlabs",
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
          "Unknown ElevenLabs TTS synthesis failure.",
          error,
        );

        this.logger.error(
          {
            attempt,
            err: normalizedError,
            latencyMs: Date.now() - requestStartedAt,
            provider: "elevenlabs",
            statusCode: getErrorStatusCode(error),
            textLength: normalizedText.length,
            voiceId: normalizedVoiceId,
          },
          "TTS synthesis failed.",
        );

        throw buildElevenLabsFailure(normalizedVoiceId, normalizedError);
      }
    }

    throw new Error(
      `ElevenLabs TTS synthesis failed for voice "${normalizedVoiceId}" after ${TTS_MAX_ATTEMPTS} attempts.`,
    );
  }
}

/**
 * Builds the canonical ElevenLabs streaming URL for a provider voice.
 *
 * @param voiceId - Trimmed ElevenLabs voice identifier.
 * @returns The full stream endpoint URL including output format parameters.
 */
export function buildElevenLabsUrl(voiceId: string): string {
  const url = new URL(`${ELEVENLABS_TTS_BASE_URL}/${encodeURIComponent(voiceId)}/stream`);
  url.searchParams.set("output_format", ELEVENLABS_OUTPUT_FORMAT);

  return url.toString();
}

/**
 * Normalizes a terminal ElevenLabs synthesis failure into a stable error shape.
 *
 * @param voiceId - ElevenLabs voice identifier associated with the failed call.
 * @param error - Normalized error produced by the request attempt.
 * @returns A new error with Murmur-specific context and the original cause.
 */
function buildElevenLabsFailure(voiceId: string, error: Error): Error {
  if (error instanceof TtsResponseError) {
    return new Error(
      `ElevenLabs TTS synthesis failed for voice "${voiceId}" with status ${error.statusCode}: ${error.responseBody || "No response body returned."}`,
      {
        cause: error,
      },
    );
  }

  if (error instanceof TtsMissingBodyError) {
    return new Error(
      `ElevenLabs TTS synthesis failed for voice "${voiceId}": ${error.message}`,
      {
        cause: error,
      },
    );
  }

  return new Error(
    `ElevenLabs TTS synthesis failed for voice "${voiceId}" after ${TTS_MAX_ATTEMPTS} attempts.`,
    {
      cause: error,
    },
  );
}

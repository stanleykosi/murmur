/**
 * Shared runtime helpers for Murmur text-to-speech providers.
 *
 * This module centralizes the cross-provider validation, retry policy, stream
 * collection, and logger construction used by the Cartesia and ElevenLabs
 * clients so the orchestrator keeps one canonical TTS behavior.
 */

import pino, { type Logger } from "pino";

/**
 * Native fetch implementation shape used by provider constructors.
 */
export type FetchImplementation = typeof fetch;

/**
 * Delay helper injected into providers so retry behavior stays testable.
 */
export type DelayImplementation = (durationMs: number) => Promise<void>;

/**
 * Fail-fast timeout applied to every provider request attempt.
 */
export const TTS_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Maximum total number of attempts for a single TTS request.
 */
export const TTS_MAX_ATTEMPTS = 3;

/**
 * Retryable upstream HTTP status codes for TTS synthesis.
 */
export const RETRYABLE_TTS_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/**
 * Logger level inherited from the workspace environment.
 */
export const TTS_LOG_LEVEL = process.env.LOG_LEVEL?.trim() || "info";

/**
 * Error used when a provider rejects a request with an HTTP response.
 */
export class TtsResponseError extends Error {
  /**
   * Creates a provider-specific HTTP error wrapper.
   *
   * @param provider - Provider name used in diagnostics.
   * @param statusCode - HTTP status code returned by the upstream API.
   * @param responseBody - Best-effort response body text for debugging.
   */
  public constructor(
    public readonly provider: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
  ) {
    super(
      `${provider} TTS request failed with status ${statusCode}: ${responseBody || "No response body returned."}`,
    );
    this.name = "TtsResponseError";
  }
}

/**
 * Error used when an upstream provider claims success without streaming audio.
 */
export class TtsMissingBodyError extends Error {
  /**
   * Creates a missing-body error for the named provider.
   *
   * @param provider - Provider name used in the error message.
   */
  public constructor(provider: string) {
    super(`${provider} returned a successful response without an audio stream.`);
    this.name = "TtsMissingBodyError";
  }
}

/**
 * Creates a structured logger for a TTS provider module.
 *
 * @param component - Component name attached to every log line.
 * @returns A pino logger with Murmur's canonical base fields.
 */
export function createTtsLogger(component: string): Logger {
  return pino({
    level: TTS_LOG_LEVEL,
    base: {
      service: "agents",
      component,
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/**
 * Validates and trims synthesis text before it is sent to an upstream API.
 *
 * @param text - Raw text to synthesize.
 * @returns The trimmed text value.
 * @throws {Error} When the text is not a string or is blank.
 */
export function normalizeSynthesisText(text: string): string {
  if (typeof text !== "string") {
    throw new Error("text must be a string.");
  }

  const normalizedText = text.trim();

  if (normalizedText.length === 0) {
    throw new Error("text must be a non-empty string.");
  }

  return normalizedText;
}

/**
 * Validates and trims a provider voice identifier before use.
 *
 * @param voiceId - Raw provider voice identifier.
 * @returns The trimmed voice identifier.
 * @throws {Error} When the identifier is not a string or is blank.
 */
export function normalizeVoiceId(voiceId: string): string {
  if (typeof voiceId !== "string") {
    throw new Error("voiceId must be a string.");
  }

  const normalizedVoiceId = voiceId.trim();

  if (normalizedVoiceId.length === 0) {
    throw new Error("voiceId must be a non-empty string.");
  }

  return normalizedVoiceId;
}

/**
 * Reads an upstream audio response into a single Node.js `Buffer`.
 *
 * @param response - Successful fetch response that should contain audio bytes.
 * @param provider - Provider name used for diagnostics.
 * @returns The concatenated PCM audio payload.
 * @throws {TtsMissingBodyError} When the response body stream is absent.
 */
export async function readResponseBodyAsBuffer(
  response: Response,
  provider: string,
): Promise<Buffer> {
  if (!response.body) {
    throw new TtsMissingBodyError(provider);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (value) {
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

/**
 * Reads an error response body as text without throwing secondary failures.
 *
 * @param response - Upstream fetch response object.
 * @returns The trimmed response body, or an empty string when unavailable.
 */
export async function readResponseBodyAsText(
  response: Response,
): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

/**
 * Calculates the retry delay for a failed synthesis attempt.
 *
 * @param attempt - One-based attempt number that just failed.
 * @returns The delay before the next retry, in milliseconds.
 */
export function getRetryDelayMs(attempt: number): number {
  if (attempt < 1 || attempt >= TTS_MAX_ATTEMPTS) {
    return 0;
  }

  return 250 * 2 ** (attempt - 1);
}

/**
 * Determines whether a synthesis error is safe to retry.
 *
 * @param error - Failure raised during request execution.
 * @returns `true` when the error represents a retryable transient failure.
 */
export function isRetryableTtsError(error: unknown): boolean {
  if (error instanceof TtsResponseError) {
    return RETRYABLE_TTS_STATUS_CODES.has(error.statusCode);
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error instanceof TypeError
    || error.name === "AbortError"
    || error.name === "TimeoutError"
  );
}

/**
 * Sleeps for the requested duration.
 *
 * @param durationMs - Delay duration in milliseconds.
 * @returns A promise that resolves after the timer completes.
 */
export function waitForRetryDelay(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

/**
 * Extracts the HTTP status code from an upstream response error when present.
 *
 * @param error - Failure raised during synthesis.
 * @returns The status code, or `undefined` when not applicable.
 */
export function getErrorStatusCode(error: unknown): number | undefined {
  return error instanceof TtsResponseError ? error.statusCode : undefined;
}

/**
 * Converts an unknown failure into a proper `Error` object.
 *
 * @param fallbackMessage - Message to use for non-Error failures.
 * @param error - Original thrown value.
 * @returns A normalized `Error` instance.
 */
export function normalizeError(
  fallbackMessage: string,
  error: unknown,
): Error {
  return error instanceof Error ? error : new Error(fallbackMessage, { cause: error });
}

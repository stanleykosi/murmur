/**
 * Unit tests for the Murmur ElevenLabs TTS provider.
 *
 * These assertions pin the exact HTTP contract, validation rules, retry
 * behavior, and audio buffering semantics expected by the orchestrator.
 */

import type { Logger } from "pino";

import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

type ElevenLabsModule = typeof import("./elevenlabs.js");
type SharedModule = typeof import("./shared.js");

/**
 * Builds a complete environment fixture suitable for importing the ElevenLabs
 * provider module without tripping shared agent env validation.
 *
 * @param overrides - Optional environment overrides for individual test cases.
 * @returns A valid environment map for dynamic module import.
 */
function createValidEnvironment(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...ORIGINAL_ENV,
    DATABASE_URL: "postgresql://postgres:secret@example.com:5432/postgres",
    REDIS_URL: "redis://localhost:6379",
    LIVEKIT_API_KEY: "livekit-key",
    LIVEKIT_API_SECRET: "livekit-secret",
    LIVEKIT_URL: "wss://example.livekit.cloud",
    CENTRIFUGO_API_URL: "http://localhost:8000",
    CENTRIFUGO_API_KEY: "centrifugo-api-key",
    OPENROUTER_API_KEY: "sk-or-example",
    OPENROUTER_DEFAULT_MODEL: "openai/gpt-4o",
    OPENROUTER_DEFAULT_MAX_TOKENS: "420",
    CARTESIA_API_KEY: "cartesia-key",
    ELEVENLABS_API_KEY: "elevenlabs-key",
    MISTRAL_API_KEY: "mistral-key",
    SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
    LOG_LEVEL: "silent",
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete environment[key];
      continue;
    }

    environment[key] = value;
  }

  return environment;
}

/**
 * Imports the ElevenLabs provider module after priming `process.env` for
 * deterministic module-level environment parsing.
 *
 * @param environment - Environment variables to expose during module import.
 * @returns The dynamically imported ElevenLabs provider module.
 */
async function importElevenLabsModule(
  environment = createValidEnvironment(),
): Promise<ElevenLabsModule> {
  vi.resetModules();
  process.env = environment;

  return import("./elevenlabs.js");
}

/**
 * Imports the shared TTS helper module using the same deterministic env setup
 * as the provider module.
 *
 * @param environment - Environment variables to expose during module import.
 * @returns The dynamically imported shared helper module.
 */
async function importSharedModule(
  environment = createValidEnvironment(),
): Promise<SharedModule> {
  vi.resetModules();
  process.env = environment;

  return import("./shared.js");
}

/**
 * Builds a chunked `ReadableStream` response fixture from byte arrays.
 *
 * @param chunks - Binary payload chunks emitted by the simulated provider.
 * @param init - Optional response metadata.
 * @returns A `Response` whose body streams the provided chunks.
 */
function createStreamResponse(
  chunks: Uint8Array[],
  init?: ResponseInit,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }

      controller.close();
    },
  });

  return new Response(stream, init);
}

/**
 * Creates a logger stub with the methods exercised by the provider.
 *
 * @returns A minimal logger implementation compatible with the provider class.
 */
function createLoggerStub(): Logger {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as Logger;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("ElevenLabsTTSProvider", () => {
  /**
   * Verifies the provider sends the exact canonical request contract and
   * returns a concatenated PCM buffer from the streamed response body.
   */
  it("builds the canonical request and returns streamed PCM audio bytes", async () => {
    const module = await importElevenLabsModule();
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        createStreamResponse(
          [Uint8Array.from([6, 7]), Uint8Array.from([8, 9, 10])],
          { status: 200 },
        ),
      );
    const provider = new module.ElevenLabsTTSProvider(
      fetchImplementation,
      createLoggerStub(),
      vi.fn().mockResolvedValue(undefined),
    );

    const audio = await provider.synthesize("  Hello from ElevenLabs.  ", "  voice-456  ");

    expect(audio).toEqual(Buffer.from([6, 7, 8, 9, 10]));
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImplementation.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${module.ELEVENLABS_TTS_BASE_URL}/voice-456/stream?output_format=${module.ELEVENLABS_OUTPUT_FORMAT}`,
    );
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "xi-api-key": "elevenlabs-key",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model_id: "eleven_flash_v2_5",
      text: "Hello from ElevenLabs.",
    });
  });

  /**
   * Ensures invalid caller input is rejected before any network activity.
   */
  it("rejects blank text and voice identifiers before calling fetch", async () => {
    const module = await importElevenLabsModule();
    const fetchImplementation = vi.fn<typeof fetch>();
    const provider = new module.ElevenLabsTTSProvider(
      fetchImplementation,
      createLoggerStub(),
      vi.fn().mockResolvedValue(undefined),
    );

    await expect(provider.synthesize("   ", "voice-456")).rejects.toThrowError(
      /text must be a non-empty string/i,
    );
    await expect(provider.synthesize("Hello", "   ")).rejects.toThrowError(
      /voiceId must be a non-empty string/i,
    );
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  /**
   * Verifies retryable status codes trigger another attempt using the shared
   * deterministic backoff schedule.
   */
  it("retries on rate limits and succeeds on a later attempt", async () => {
    const module = await importElevenLabsModule();
    const sharedModule = await importSharedModule();
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Busy", { status: 429 }))
      .mockResolvedValueOnce(
        createStreamResponse([Uint8Array.from([10, 11, 12])], { status: 200 }),
      );
    const delay = vi.fn<SharedModule["DelayImplementation"]>().mockResolvedValue();
    const provider = new module.ElevenLabsTTSProvider(
      fetchImplementation,
      createLoggerStub(),
      delay,
    );

    const audio = await provider.synthesize("Hello", "voice-456");

    expect(audio).toEqual(Buffer.from([10, 11, 12]));
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledTimes(1);
    expect(delay).toHaveBeenCalledWith(sharedModule.getRetryDelayMs(1));
  });

  /**
   * Ensures non-retryable client errors fail immediately and surface the
   * upstream status code plus response body in the thrown error.
   */
  it("fails fast for non-retryable HTTP responses", async () => {
    const module = await importElevenLabsModule();
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("Bad request", { status: 400 }));
    const delay = vi.fn().mockResolvedValue(undefined);
    const provider = new module.ElevenLabsTTSProvider(
      fetchImplementation,
      createLoggerStub(),
      delay,
    );

    await expect(provider.synthesize("Hello", "voice-456")).rejects.toThrowError(
      /status 400: Bad request/,
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  /**
   * Ensures a successful status without a stream body fails with clear
   * diagnostics instead of returning an empty buffer.
   */
  it("throws when ElevenLabs returns a success response without a stream body", async () => {
    const module = await importElevenLabsModule();
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const provider = new module.ElevenLabsTTSProvider(
      fetchImplementation,
      createLoggerStub(),
      vi.fn().mockResolvedValue(undefined),
    );

    await expect(provider.synthesize("Hello", "voice-456")).rejects.toThrowError(
      /without an audio stream/,
    );
  });
});

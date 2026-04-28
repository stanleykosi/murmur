/**
 * Unit tests for the Murmur agents Sentry helper.
 *
 * These assertions pin the runtime-error facade so orchestrator and runner
 * failures keep their room, agent, and stage metadata attached to each captured
 * exception.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const mockInit = vi.fn();
const mockSetTag = vi.fn();
const mockCaptureException = vi.fn();
const mockFlush = vi.fn(async () => true);

const scopeSetTag = vi.fn();
const scopeSetExtra = vi.fn();

vi.mock("@sentry/node", () => ({
  captureException: mockCaptureException,
  flush: mockFlush,
  init: mockInit,
  setTag: mockSetTag,
  withScope: (callback: (scope: {
    setTag: typeof scopeSetTag;
    setExtra: typeof scopeSetExtra;
  }) => void) => {
    callback({
      setTag: scopeSetTag,
      setExtra: scopeSetExtra,
    });
  },
}));

/**
 * Builds a complete valid environment for importing the agents Sentry helper.
 *
 * @param overrides - Optional environment overrides per test.
 * @returns A valid process environment object.
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
    OPENROUTER_REQUEST_TIMEOUT_MS: "60000",
    AGENT_TURN_DEADLINE_MS: "45000",
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
 * Imports the agents Sentry helper after priming `process.env`.
 *
 * @param environment - Environment variables to expose during import.
 * @returns The dynamically imported helper module.
 */
async function importSentryModule(
  environment = createValidEnvironment(),
) {
  vi.resetModules();
  process.env = environment;

  return await import("./sentry.js");
}

afterEach(() => {
  delete (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("murmur.agents.sentry.initialized")
  ];
  process.env = { ...ORIGINAL_ENV };
  vi.clearAllMocks();
  vi.resetModules();
});

describe("agents sentry helper", () => {
  /**
   * Ensures the agents process initializes Sentry with the required DSN.
   */
  it("initializes the Sentry SDK on import", async () => {
    await importSentryModule();

    expect(mockInit).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://public@example.ingest.sentry.io/1",
        environment: expect.any(String),
        tracesSampleRate: 0.2,
      }),
    );
    expect(mockSetTag).toHaveBeenCalledWith("service", "agents");
  });

  /**
   * Ensures runtime captures keep stable tags and extras for agent failures.
   */
  it("logs once and forwards runtime metadata to Sentry", async () => {
    const module = await importSentryModule();
    const logger = {
      error: vi.fn(),
    };

    const normalizedError = module.captureRuntimeError(
      logger,
      "tts failed",
      {
        stage: "tts_synthesis",
        roomId: "room-123",
        agentId: "agent-456",
        voiceId: "voice-789",
      },
    );

    expect(normalizedError).toBeInstanceOf(Error);
    expect(normalizedError.message).toContain("tts failed");
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(scopeSetTag).toHaveBeenCalledWith("service", "agents");
    expect(scopeSetTag).toHaveBeenCalledWith("stage", "tts_synthesis");
    expect(scopeSetTag).toHaveBeenCalledWith("roomId", "room-123");
    expect(scopeSetTag).toHaveBeenCalledWith("agentId", "agent-456");
    expect(scopeSetExtra).toHaveBeenCalledWith("voiceId", "voice-789");
    expect(mockCaptureException).toHaveBeenCalledWith(normalizedError);
  });

  /**
   * Ensures callers can flush pending envelopes during orchestrator shutdown.
   */
  it("flushes pending events with the provided timeout", async () => {
    const module = await importSentryModule();

    await expect(module.flushSentry(900)).resolves.toBe(true);
    expect(mockFlush).toHaveBeenCalledWith(900);
  });
});

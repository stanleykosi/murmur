/**
 * Unit tests for the Murmur API Sentry helper.
 *
 * These tests pin the canonical Step 35 capture wrapper so request and process
 * failures keep forwarding structured metadata to Sentry without leaking raw
 * SDK usage across the API codebase.
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
 * Creates a complete valid environment for importing API modules that depend on
 * validated runtime configuration.
 *
 * @param overrides - Optional environment overrides.
 * @returns A process environment object suitable for module import.
 */
function createValidEnvironment(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...ORIGINAL_ENV,
    CORS_ALLOWED_ORIGINS: "http://localhost:3000,https://app.example.com",
    CENTRIFUGO_API_KEY: "centrifugo_api_key",
    CENTRIFUGO_API_URL: "http://centrifugo.internal:8000",
    CENTRIFUGO_TOKEN_SECRET: "centrifugo_token_secret",
    CLERK_SECRET_KEY: "sk_test_clerk_secret",
    CLERK_WEBHOOK_SECRET: "whsec_test_secret",
    DATABASE_URL: "postgresql://postgres:secret@example.com:5432/postgres",
    LIVEKIT_API_KEY: "livekit_api_key",
    LIVEKIT_API_SECRET: "livekit_api_secret",
    LIVEKIT_URL: "https://murmur-test.livekit.cloud",
    REDIS_URL: "redis://default:secret@example.com:6379",
    SENTRY_DSN: "https://public@example.ingest.sentry.io/12345",
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
 * Imports the API Sentry helper after priming `process.env`.
 *
 * @param environment - Environment variables to expose during import.
 * @returns The dynamically imported Sentry helper module.
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
    Symbol.for("murmur.api.sentry.initialized")
  ];
  process.env = { ...ORIGINAL_ENV };
  vi.clearAllMocks();
  vi.resetModules();
});

describe("api sentry helper", () => {
  /**
   * Ensures the helper initializes Sentry with the validated API DSN.
   */
  it("initializes the Sentry SDK on import", async () => {
    await importSentryModule();

    expect(mockInit).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://public@example.ingest.sentry.io/12345",
        environment: expect.any(String),
        tracesSampleRate: 0.2,
      }),
    );
    expect(mockSetTag).toHaveBeenCalledWith("service", "api");
  });

  /**
   * Ensures unknown thrown values are normalized and enriched before capture.
   */
  it("normalizes errors and forwards tags and extras", async () => {
    const module = await importSentryModule();

    const normalizedError = module.captureException("boom", {
      tags: {
        stage: "request",
      },
      extra: {
        requestId: "req-123",
      },
    });

    expect(normalizedError).toBeInstanceOf(Error);
    expect(normalizedError.message).toContain("boom");
    expect(scopeSetTag).toHaveBeenCalledWith("service", "api");
    expect(scopeSetTag).toHaveBeenCalledWith("stage", "request");
    expect(scopeSetExtra).toHaveBeenCalledWith("requestId", "req-123");
    expect(mockCaptureException).toHaveBeenCalledWith(normalizedError);
  });

  /**
   * Ensures callers can await pending envelope delivery during shutdown.
   */
  it("flushes pending events with the provided timeout", async () => {
    const module = await importSentryModule();

    await expect(module.flushSentry(750)).resolves.toBe(true);
    expect(mockFlush).toHaveBeenCalledWith(750);
  });
});

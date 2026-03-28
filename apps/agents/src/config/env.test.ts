/**
 * Unit tests for the Murmur agent workspace environment validation helpers.
 *
 * These tests pin the Step 26 configuration contract so the scaffold fails fast
 * with useful diagnostics while remaining easy to configure in development.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

/**
 * Builds a complete valid environment for importing the agent env module in
 * isolation. Individual tests override keys to probe specific behaviors.
 *
 * @param overrides - Optional environment values to replace or remove.
 * @returns A process-env object suitable for the scaffold env parser.
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
    OPENROUTER_DEFAULT_MAX_TOKENS: "450",
    CARTESIA_API_KEY: "cartesia-key",
    ELEVENLABS_API_KEY: "elevenlabs-key",
    SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
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
 * Imports the env module after priming `process.env` with a known-good
 * configuration so the module-level `env` export can initialize deterministically.
 *
 * @param environment - Environment variables to expose during module import.
 * @returns The dynamically imported env module.
 */
async function importEnvModule(environment = createValidEnvironment()) {
  vi.resetModules();
  process.env = environment;

  return import("./env.js");
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("agent env", () => {
  /**
   * Verifies the module trims string inputs and applies the default
   * OpenRouter model and token budget when the operator omits them.
   */
  it("parses a valid environment and applies the default model and max tokens", async () => {
    const environment = createValidEnvironment({
      DATABASE_URL: "  postgresql://postgres:secret@example.com:5432/postgres  ",
      OPENROUTER_DEFAULT_MODEL: undefined,
      OPENROUTER_DEFAULT_MAX_TOKENS: undefined,
      SENTRY_DSN: "   ",
    });
    const module = await importEnvModule(environment);

    expect(module.env).toMatchObject({
      DATABASE_URL: "postgresql://postgres:secret@example.com:5432/postgres",
      OPENROUTER_DEFAULT_MODEL: module.DEFAULT_OPENROUTER_MODEL,
      OPENROUTER_DEFAULT_MAX_TOKENS: module.DEFAULT_OPENROUTER_MAX_TOKENS,
      SENTRY_DSN: undefined,
    });
  });

  /**
   * Ensures operators receive one aggregated error covering every invalid key
   * so they can fix the full configuration in one pass.
   */
  it("aggregates validation failures across multiple keys", async () => {
    const module = await importEnvModule();

    expect(() =>
      module.parseAgentEnvironment(
        createValidEnvironment({
          DATABASE_URL: "not-a-url",
          REDIS_URL: " ",
          OPENROUTER_API_KEY: undefined,
          OPENROUTER_DEFAULT_MAX_TOKENS: "0",
          SENTRY_DSN: "still-not-a-url",
        }),
      ),
    ).toThrowError(
      /DATABASE_URL|REDIS_URL|OPENROUTER_API_KEY|OPENROUTER_DEFAULT_MAX_TOKENS|SENTRY_DSN/,
    );
  });

  /**
   * Confirms operators can omit Sentry entirely without blocking service boot.
   */
  it("allows SENTRY_DSN to be omitted entirely", async () => {
    const module = await importEnvModule();
    const parsedEnvironment = module.parseAgentEnvironment(
      createValidEnvironment({
        SENTRY_DSN: undefined,
      }),
    );

    expect(parsedEnvironment).not.toHaveProperty("SENTRY_DSN");
  });
});

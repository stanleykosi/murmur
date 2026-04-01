/**
 * Unit tests for the Murmur TTS provider factory.
 *
 * These assertions pin the provider-to-implementation mapping so downstream
 * graph nodes can construct the expected synthesis backend from shared agent
 * configuration without branching logic of their own.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

type ProviderModule = typeof import("./provider.js");

/**
 * Builds a complete environment fixture suitable for importing the TTS modules
 * without tripping shared agent env validation.
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
 * Imports the provider factory after priming `process.env` for deterministic
 * module-level environment parsing in the concrete provider modules.
 *
 * @param environment - Environment variables to expose during module import.
 * @returns The dynamically imported provider module.
 */
async function importProviderModule(
  environment = createValidEnvironment(),
): Promise<ProviderModule> {
  vi.resetModules();
  process.env = environment;

  return import("./provider.js");
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("createTTSProvider", () => {
  /**
   * Verifies the factory resolves the Cartesia identifier to the expected
   * concrete provider implementation.
   */
  it("returns a Cartesia provider for the cartesia key", async () => {
    const providerModule = await importProviderModule();
    const cartesiaModule = await import("./cartesia.js");

    const provider = providerModule.createTTSProvider("cartesia");

    expect(provider).toBeInstanceOf(cartesiaModule.CartesiaTTSProvider);
  });

  /**
   * Verifies the factory resolves the ElevenLabs identifier to the expected
   * concrete provider implementation.
   */
  it("returns an ElevenLabs provider for the elevenlabs key", async () => {
    const providerModule = await importProviderModule();
    const elevenLabsModule = await import("./elevenlabs.js");

    const provider = providerModule.createTTSProvider("elevenlabs");

    expect(provider).toBeInstanceOf(elevenLabsModule.ElevenLabsTTSProvider);
  });

  /**
   * Ensures runtime misuse fails fast with a descriptive error instead of
   * silently falling back to another provider.
   */
  it("throws for unsupported provider strings at runtime", async () => {
    const providerModule = await importProviderModule();

    expect(() =>
      providerModule.createTTSProvider("kokoro" as never),
    ).toThrowError(/Unsupported TTS provider "kokoro"/);
  });
});

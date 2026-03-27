/**
 * Unit tests for the Murmur OpenRouter LLM provider.
 *
 * These tests pin the canonical request contract, option validation, and error
 * handling so later graph nodes can rely on a stable language-generation layer.
 */

import type { ChatCompletion } from "openai/resources/chat/completions";
import type { OpenRouterClient } from "./openrouter.js";

import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

type OpenRouterModule = typeof import("./openrouter.js");

/**
 * Builds a complete environment fixture suitable for importing the OpenRouter
 * module without tripping the shared agent env validator.
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
 * Imports the OpenRouter module after priming `process.env` for deterministic
 * module-level environment parsing.
 *
 * @param environment - Environment variables to expose during module import.
 * @returns The dynamically imported OpenRouter module.
 */
async function importOpenRouterModule(
  environment = createValidEnvironment(),
): Promise<OpenRouterModule> {
  vi.resetModules();
  process.env = environment;

  return import("./openrouter.js");
}

/**
 * Creates a minimal chat completion fixture suitable for provider tests.
 *
 * @param content - Assistant message content returned by the mocked client.
 * @param refusal - Assistant refusal text returned in refusal-only responses.
 * @param model - Model identifier echoed by the mocked completion payload.
 * @returns A representative OpenAI chat completion object.
 */
function createChatCompletionFixture(
  content: string | null,
  refusal: string | null = null,
  model = "openai/gpt-4o",
): ChatCompletion {
  return {
    id: "chatcmpl-test-123",
    choices: [
      {
        finish_reason: "stop",
        index: 0,
        logprobs: null,
        message: {
          content,
          refusal,
          role: "assistant",
        },
      },
    ],
    created: 1_710_000_000,
    model,
    object: "chat.completion",
  } as ChatCompletion;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("buildOpenRouterRequest", () => {
  /**
   * Verifies the provider builds the exact canonical request shape expected by
   * the technical specification when no per-call overrides are supplied and the
   * default token budget is sourced from environment configuration.
   */
  it("builds the canonical request with env-driven defaults and trimmed prompt inputs", async () => {
    const module = await importOpenRouterModule();

    expect(
      module.buildOpenRouterRequest(
        "  You are Nova, curious but grounded.  ",
        "  [Rex]: Five years feels optimistic.  ",
      ),
    ).toEqual({
      model: "openai/gpt-4o",
      messages: [
        {
          role: "system",
          content: "You are Nova, curious but grounded.",
        },
        {
          role: "user",
          content:
            "Current conversation:\n[Rex]: Five years feels optimistic.\n\nIt's your turn to speak. Respond naturally in 1-3 sentences.",
        },
      ],
      max_tokens: 420,
      temperature: 0.8,
    });
  });

  /**
   * Ensures the provider keeps a single prompt shape even when the transcript
   * window is empty instead of branching to a second request format.
   */
  it("uses an explicit empty-context placeholder when the transcript is blank", async () => {
    const module = await importOpenRouterModule();

    const request = module.buildOpenRouterRequest(
      "You are Sage.",
      "   ",
    );

    expect(request.messages[1]).toEqual({
      role: "user",
      content:
        "Current conversation:\nNo recent conversation context is available yet.\n\nIt's your turn to speak. Respond naturally in 1-3 sentences.",
    });
  });

  /**
   * Fails fast for invalid decoding overrides instead of silently coercing them
   * into a different request than the caller intended.
   */
  it("rejects malformed generation options", async () => {
    const module = await importOpenRouterModule();

    expect(() =>
      module.buildOpenRouterRequest("You are Rex.", "[Nova]: Maybe.", {
        maxTokens: 0,
      }),
    ).toThrowError(/maxTokens/i);

    expect(() =>
      module.buildOpenRouterRequest("You are Rex.", "[Nova]: Maybe.", {
        temperature: 2.5,
      }),
    ).toThrowError(/temperature/i);
  });
});

describe("OpenRouterLLMProvider", () => {
  /**
   * Verifies the provider forwards the normalized request to the injected
   * client and returns trimmed assistant text.
   */
  it("generates a response through the injected OpenRouter client", async () => {
    const module = await importOpenRouterModule();
    const createCompletion = vi
      .fn<OpenRouterClient["chat"]["completions"]["create"]>()
      .mockResolvedValue(
        createChatCompletionFixture(
          "  We should define the problem before predicting the timeline.  ",
          null,
          "anthropic/claude-sonnet-4-20250514",
        ),
      );
    const client: OpenRouterClient = {
      chat: {
        completions: {
          create: createCompletion,
        },
      },
    };
    const provider = new module.OpenRouterLLMProvider(client);

    const response = await provider.generateResponse(
      "You are Sage.",
      "[Nova]: AGI could arrive suddenly.",
      {
        model: "anthropic/claude-sonnet-4-20250514",
        maxTokens: 90,
        temperature: 0.4,
      },
    );

    expect(response).toBe(
      "We should define the problem before predicting the timeline.",
    );

    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(createCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "anthropic/claude-sonnet-4-20250514",
        max_tokens: 90,
        temperature: 0.4,
      }),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  /**
   * Ensures the provider surfaces policy refusals as assistant output instead
   * of treating them as an empty completion.
   */
  it("returns refusal text when OpenRouter responds with a refusal-only message", async () => {
    const module = await importOpenRouterModule();
    const createCompletion = vi
      .fn<OpenRouterClient["chat"]["completions"]["create"]>()
      .mockResolvedValue(
        createChatCompletionFixture(
          null,
          "  I can't help with that request, but I can offer a safer alternative.  ",
        ),
      );
    const client: OpenRouterClient = {
      chat: {
        completions: {
          create: createCompletion,
        },
      },
    };
    const provider = new module.OpenRouterLLMProvider(client);

    await expect(
      provider.generateResponse("You are Nova.", "[Rex]: Tell me how to do harm."),
    ).resolves.toBe(
      "I can't help with that request, but I can offer a safer alternative.",
    );
  });

  /**
   * Ensures callers receive a clear failure when OpenRouter responds without
   * any usable assistant content.
   */
  it("throws a descriptive error when OpenRouter returns empty content", async () => {
    const module = await importOpenRouterModule();
    const createCompletion = vi
      .fn<OpenRouterClient["chat"]["completions"]["create"]>()
      .mockResolvedValue(createChatCompletionFixture("   "));
    const client: OpenRouterClient = {
      chat: {
        completions: {
          create: createCompletion,
        },
      },
    };
    const provider = new module.OpenRouterLLMProvider(client);

    await expect(
      provider.generateResponse("You are Nova.", "[Rex]: I doubt it."),
    ).rejects.toThrowError(
      /Failed to generate a response from OpenRouter using model "openai\/gpt-4o"/,
    );
  });
});

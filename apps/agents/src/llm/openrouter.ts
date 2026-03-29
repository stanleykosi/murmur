/**
 * OpenRouter-backed LLM provider for Murmur agents.
 *
 * This module wraps the OpenRouter OpenAI-compatible chat completions API and
 * enforces Murmur's canonical request shape, validation rules, timeout, and
 * structured logging so later graph nodes can rely on a single generation path.
 */

import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import pino, { type Logger } from "pino";

import { env } from "../config/env.js";
import {
  buildTurnPrompt,
  normalizeSystemPrompt,
  type LLMGenerationOptions,
  type LLMProvider,
} from "./provider.js";

/**
 * OpenRouter model selector accepted by Murmur's provider implementation.
 */
export type OpenRouterModel =
  | "openai/gpt-4o"
  | "anthropic/claude-sonnet-4-20250514"
  | string;

/**
 * Request options passed to the OpenAI SDK for a single completion call.
 */
interface OpenRouterRequestOptions {
  signal?: AbortSignal;
}

/**
 * Minimal OpenRouter client surface used by the provider.
 *
 * The concrete runtime implementation is the OpenAI SDK configured with
 * OpenRouter's base URL, but tests inject a lightweight stub that matches this
 * contract.
 */
export interface OpenRouterClient {
  chat: {
    completions: {
      create(
        request: ChatCompletionCreateParamsNonStreaming,
        options?: OpenRouterRequestOptions,
      ): Promise<ChatCompletion>;
    };
  };
}

/**
 * Fully normalized generation options used for each OpenRouter request.
 */
export interface NormalizedOpenRouterOptions {
  model: OpenRouterModel;
  maxTokens: number;
  temperature: number;
}

/**
 * Canonical OpenRouter API base URL.
 */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Canonical request headers sent to OpenRouter for Murmur traffic attribution.
 */
export const OPENROUTER_DEFAULT_HEADERS = {
  "HTTP-Referer": "https://murmur.app",
  "X-Title": "Murmur",
} as const satisfies Record<string, string>;

/**
 * Default maximum number of output tokens per conversational turn.
 *
 * This value comes from the validated agent environment so operators can tune
 * the default response budget without editing code.
 */
export const OPENROUTER_DEFAULT_MAX_TOKENS = env.OPENROUTER_DEFAULT_MAX_TOKENS;

/**
 * Default temperature for natural but still coherent room conversation turns.
 */
export const OPENROUTER_DEFAULT_TEMPERATURE = 0.8;

/**
 * Fail-fast timeout for OpenRouter requests so a stalled upstream call does not
 * block the room floor indefinitely.
 */
export const OPENROUTER_REQUEST_TIMEOUT_MS = env.OPENROUTER_REQUEST_TIMEOUT_MS;
const OPENROUTER_EMPTY_RESPONSE_RETRY_COUNT = 1;

const openRouterLogger = pino({
  level: process.env.LOG_LEVEL?.trim() || "info",
  base: {
    service: "agents",
    component: "llm-openrouter",
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Builds the canonical OpenRouter SDK client.
 *
 * @param apiKey - OpenRouter API key used for request authorization.
 * @returns An OpenAI SDK client configured for OpenRouter.
 * @throws {Error} When the API key is blank.
 */
export function createOpenRouterClient(
  apiKey = env.OPENROUTER_API_KEY,
): OpenRouterClient {
  const normalizedApiKey = apiKey.trim();

  if (normalizedApiKey.length === 0) {
    throw new Error("OpenRouter API key must be a non-empty string.");
  }

  return new OpenAI({
    apiKey: normalizedApiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: OPENROUTER_DEFAULT_HEADERS,
  });
}

/**
 * Validates and resolves generation options for a single OpenRouter request.
 *
 * @param options - Optional caller-provided overrides.
 * @returns Fully normalized options with defaults applied.
 * @throws {Error} When any option is malformed or outside supported bounds.
 */
export function normalizeOpenRouterOptions(
  options: LLMGenerationOptions = {},
): NormalizedOpenRouterOptions {
  const model = (options.model ?? env.OPENROUTER_DEFAULT_MODEL).trim();

  if (model.length === 0) {
    throw new Error("options.model must be a non-empty string.");
  }

  const maxTokens = options.maxTokens ?? OPENROUTER_DEFAULT_MAX_TOKENS;

  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new Error("options.maxTokens must be a positive integer.");
  }

  const temperature = options.temperature ?? OPENROUTER_DEFAULT_TEMPERATURE;

  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error("options.temperature must be a finite number between 0 and 2.");
  }

  return {
    model,
    maxTokens,
    temperature,
  };
}

/**
 * Builds the canonical chat message array sent to OpenRouter.
 *
 * @param systemPrompt - Agent personality instructions.
 * @param transcript - Rolling transcript window for room context.
 * @returns The normalized system and user messages for the completion call.
 */
export function buildOpenRouterMessages(
  systemPrompt: string,
  transcript: string,
): ChatCompletionMessageParam[] {
  const messages = [
    {
      role: "system",
      content: normalizeSystemPrompt(systemPrompt),
    },
    {
      role: "user",
      content: buildTurnPrompt(transcript),
    },
  ] satisfies ChatCompletionMessageParam[];

  return messages;
}

/**
 * Builds the full OpenRouter chat completion payload for a single agent turn.
 *
 * @param systemPrompt - Agent personality instructions.
 * @param transcript - Rolling transcript window for room context.
 * @param options - Optional model and decoding overrides.
 * @returns A validated OpenRouter chat completions request payload.
 */
export function buildOpenRouterRequest(
  systemPrompt: string,
  transcript: string,
  options?: LLMGenerationOptions,
): ChatCompletionCreateParamsNonStreaming {
  const normalizedOptions = normalizeOpenRouterOptions(options);

  return {
    model: normalizedOptions.model,
    messages: buildOpenRouterMessages(systemPrompt, transcript),
    max_tokens: normalizedOptions.maxTokens,
    temperature: normalizedOptions.temperature,
  };
}

/**
 * Extracts the first non-empty assistant message from an OpenRouter completion.
 *
 * @param completion - Raw chat completion response from OpenRouter.
 * @returns The trimmed assistant response text.
 * @throws {Error} When the response contains no usable assistant content.
 */
export function extractResponseText(completion: ChatCompletion): string {
  for (const choice of completion.choices) {
    const candidateText =
      choice.message.content?.trim() ?? choice.message.refusal?.trim();

    if (candidateText) {
      return candidateText;
    }
  }

  throw new Error("OpenRouter returned no assistant message content.");
}

/**
 * Indicates whether an upstream completion failed specifically because the
 * provider returned no usable assistant text.
 *
 * @param error - Candidate error thrown during response extraction.
 * @returns `true` when the error represents an empty completion.
 */
function isEmptyAssistantResponseError(error: unknown): boolean {
  return error instanceof Error
    && error.message === "OpenRouter returned no assistant message content.";
}

/**
 * Canonical Murmur LLM provider implementation that routes through OpenRouter.
 */
export class OpenRouterLLMProvider implements LLMProvider {
  /**
   * Creates a provider instance backed by the supplied OpenRouter client.
   *
   * @param client - OpenRouter-compatible client implementation.
   * @param logger - Structured logger for request lifecycle events.
   */
  public constructor(
    private readonly client: OpenRouterClient = createOpenRouterClient(),
    private readonly logger: Logger = openRouterLogger,
  ) {}

  /**
   * Generates the next spoken turn for an agent using OpenRouter chat
   * completions.
   *
   * @param systemPrompt - Agent personality instructions.
   * @param transcript - Rolling transcript window for room context.
   * @param options - Optional model and decoding overrides.
   * @returns The trimmed assistant response text.
   * @throws {Error} When the upstream call fails or returns no usable content.
   */
  public async generateResponse(
    systemPrompt: string,
    transcript: string,
    options?: LLMGenerationOptions,
  ): Promise<string> {
    const request = buildOpenRouterRequest(systemPrompt, transcript, options);
    const requestStartedAt = Date.now();

    try {
      let responseText: string | null = null;

      for (
        let attempt = 0;
        attempt <= OPENROUTER_EMPTY_RESPONSE_RETRY_COUNT;
        attempt += 1
      ) {
        const completion = await this.client.chat.completions.create(request, {
          signal: AbortSignal.timeout(OPENROUTER_REQUEST_TIMEOUT_MS),
        });

        try {
          responseText = extractResponseText(completion);
          break;
        } catch (error) {
          if (
            attempt === OPENROUTER_EMPTY_RESPONSE_RETRY_COUNT
            || !isEmptyAssistantResponseError(error)
          ) {
            throw error;
          }

          this.logger.warn(
            {
              attempt: attempt + 1,
              maxTokens: request.max_tokens,
              model: request.model,
            },
            "OpenRouter returned an empty assistant message; retrying once.",
          );
        }
      }

      if (responseText === null) {
        throw new Error("OpenRouter returned no assistant message content.");
      }

      this.logger.info(
        {
          latencyMs: Date.now() - requestStartedAt,
          maxTokens: request.max_tokens,
          messageCount: request.messages.length,
          model: request.model,
        },
        "Generated agent response via OpenRouter.",
      );

      return responseText;
    } catch (error) {
      const normalizedError =
        error instanceof Error
          ? error
          : new Error("Unknown OpenRouter request failure.", {
              cause: error,
            });

      this.logger.error(
        {
          err: normalizedError,
          latencyMs: Date.now() - requestStartedAt,
          maxTokens: request.max_tokens,
          model: request.model,
        },
        "Failed to generate agent response via OpenRouter.",
      );

      throw new Error(
        `Failed to generate a response from OpenRouter using model "${request.model}".`,
        {
          cause: normalizedError,
        },
      );
    }
  }
}

/**
 * Convenience factory for callers that want the canonical provider instance
 * shape without depending on the class constructor directly.
 *
 * @param client - Optional injected OpenRouter client for tests or overrides.
 * @param logger - Optional injected logger for tests or custom bindings.
 * @returns A ready-to-use OpenRouter-backed LLM provider.
 */
export function createOpenRouterLLMProvider(
  client?: OpenRouterClient,
  logger?: Logger,
): OpenRouterLLMProvider {
  return new OpenRouterLLMProvider(client, logger);
}

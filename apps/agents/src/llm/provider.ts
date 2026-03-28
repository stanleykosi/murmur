/**
 * Shared abstractions and prompt helpers for Murmur LLM integrations.
 *
 * This module defines the canonical contract the agent orchestrator will use
 * for language generation and centralizes prompt normalization so all provider
 * implementations behave consistently.
 */

/**
 * Placeholder text used when the rolling transcript window has not captured any
 * recent conversation yet.
 */
export const EMPTY_TRANSCRIPT_CONTEXT =
  "No recent conversation context is available yet.";

/**
 * Canonical turn-taking instruction appended to every model invocation.
 */
export const TURN_PROMPT_INSTRUCTION =
  "You are producing the next live spoken turn for this room. Use the recent transcript as context and respond with exactly one concise, natural, additive turn in 1-3 sentences. Do not use markdown, bullet points, numbered lists, emojis, speaker labels, quoted script formatting, parenthetical stage directions, or meta commentary.";

/**
 * Tunable parameters supported by Murmur's LLM generation pipeline.
 */
export interface LLMGenerationOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Minimal interface every Murmur LLM backend must satisfy.
 */
export interface LLMProvider {
  /**
   * Produces the next spoken turn for an agent from its personality prompt and
   * the current rolling transcript window.
   *
   * @param systemPrompt - Agent personality and behavioral instructions.
   * @param transcript - Recent conversation context, typically a 60-second window.
   * @param options - Optional model and decoding overrides for the current turn.
   * @returns The model's next natural-language response for the agent to speak.
   */
  generateResponse(
    systemPrompt: string,
    transcript: string,
    options?: LLMGenerationOptions,
  ): Promise<string>;
}

/**
 * Validates and trims a required text input used in prompt construction.
 *
 * @param value - Raw caller-supplied string.
 * @param label - Human-readable label used in validation errors.
 * @returns The trimmed string value.
 * @throws {Error} When the value is not a string or is blank after trimming.
 */
function normalizeRequiredText(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return normalizedValue;
}

/**
 * Validates the system prompt passed to an LLM provider.
 *
 * @param systemPrompt - Agent personality instructions.
 * @returns The trimmed system prompt.
 */
export function normalizeSystemPrompt(systemPrompt: string): string {
  return normalizeRequiredText(systemPrompt, "systemPrompt");
}

/**
 * Normalizes rolling transcript context for prompt construction.
 *
 * Empty transcript windows are converted into an explicit placeholder so the
 * provider keeps a single canonical prompt shape instead of branching between
 * special-case request bodies.
 *
 * @param transcript - Recent conversation transcript context.
 * @returns A trimmed transcript string or the empty-context placeholder.
 * @throws {Error} When the transcript value is not a string.
 */
export function normalizeTranscriptContext(transcript: string): string {
  if (typeof transcript !== "string") {
    throw new Error("transcript must be a string.");
  }

  const normalizedTranscript = transcript.trim();

  return normalizedTranscript.length > 0
    ? normalizedTranscript
    : EMPTY_TRANSCRIPT_CONTEXT;
}

/**
 * Builds the canonical user-turn prompt consumed by Murmur's LLM backends.
 *
 * @param transcript - Recent conversation transcript context.
 * @returns The user message instructing the model to continue the discussion.
 */
export function buildTurnPrompt(transcript: string): string {
  const normalizedTranscript = normalizeTranscriptContext(transcript);

  return `Recent transcript context:\n${normalizedTranscript}\n\n${TURN_PROMPT_INSTRUCTION}`;
}

/**
 * Runtime environment validation for the Murmur agent orchestrator.
 *
 * This module is the single source of truth for agent-service configuration. It
 * loads process environment variables, validates them with fail-fast
 * diagnostics, and exports a parsed object for the rest of the workspace.
 */

import "dotenv/config";

import { z } from "zod";

/**
 * Default model for OpenRouter-backed agent generation.
 */
export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o";

/**
 * Default token budget for a single generated room turn.
 */
export const DEFAULT_OPENROUTER_MAX_TOKENS = 300;

/**
 * Default timeout for one OpenRouter request.
 */
export const DEFAULT_OPENROUTER_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Canonical per-turn execution budget before the room should move on.
 */
export const DEFAULT_AGENT_TURN_DEADLINE_MS = 45_000;

/**
 * Builds a trimmed, required non-empty string validator for secret-like values.
 *
 * @param label - Human-readable variable name used in validation messages.
 * @returns A Zod string schema that rejects missing or whitespace-only values.
 */
export function requiredString(label: string): z.ZodType<string> {
  return z
    .string({
      required_error: `${label} is required.`,
      invalid_type_error: `${label} must be a string.`,
    })
    .transform((value) => value.trim())
    .pipe(z.string().min(1, `${label} cannot be empty.`));
}

/**
 * Builds a trimmed URL validator for connection strings and endpoint values.
 *
 * @param label - Human-readable variable name used in validation messages.
 * @returns A Zod schema that ensures the supplied value is a valid absolute URL.
 */
export function requiredUrl(label: string): z.ZodType<string> {
  return requiredString(label).refine((value) => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }, `${label} must be a valid URL.`);
}

/**
 * Builds an optional URL validator that treats missing or blank values as
 * intentionally disabled configuration.
 *
 * @param label - Human-readable variable name used in validation messages.
 * @returns A Zod schema that yields `undefined` when omitted or blank.
 */
export function optionalUrl(
  label: string,
): z.ZodType<string | undefined, z.ZodTypeDef, unknown> {
  return z.preprocess((value) => {
    if (value === undefined) {
      return undefined;
    }

    if (typeof value !== "string") {
      return value;
    }

    const trimmedValue = value.trim();

    return trimmedValue.length > 0 ? trimmedValue : undefined;
  }, z.union([
    z.undefined(),
    z.string().refine((value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }, `${label} must be a valid URL.`),
  ]));
}

/**
 * Builds an optional positive-integer validator with a numeric default.
 *
 * Environment variables arrive as strings, so this helper trims, parses, and
 * validates them into a number that downstream runtime code can consume
 * directly without repeating coercion logic.
 *
 * @param label - Human-readable variable name used in validation messages.
 * @param defaultValue - Numeric default applied when the variable is omitted.
 * @returns A Zod schema that yields a validated positive integer.
 */
export function optionalPositiveInteger(
  label: string,
  defaultValue: number,
): z.ZodType<number, z.ZodTypeDef, unknown> {
  return z.preprocess((value) => {
    if (value === undefined) {
      return defaultValue;
    }

    if (typeof value === "string") {
      const trimmedValue = value.trim();

      return trimmedValue.length > 0 ? Number(trimmedValue) : Number.NaN;
    }

    return value;
  }, z.number({
    invalid_type_error: `${label} must be a positive integer.`,
  }).int(`${label} must be a positive integer.`)
    .positive(`${label} must be a positive integer.`));
}

const AgentEnvSchema = z.object({
  DATABASE_URL: requiredUrl("DATABASE_URL"),
  REDIS_URL: requiredUrl("REDIS_URL"),
  LIVEKIT_API_KEY: requiredString("LIVEKIT_API_KEY"),
  LIVEKIT_API_SECRET: requiredString("LIVEKIT_API_SECRET"),
  LIVEKIT_URL: requiredUrl("LIVEKIT_URL"),
  CENTRIFUGO_API_URL: requiredUrl("CENTRIFUGO_API_URL"),
  CENTRIFUGO_API_KEY: requiredString("CENTRIFUGO_API_KEY"),
  OPENROUTER_API_KEY: requiredString("OPENROUTER_API_KEY"),
  OPENROUTER_DEFAULT_MODEL: z
    .string({
      invalid_type_error: "OPENROUTER_DEFAULT_MODEL must be a string.",
    })
    .transform((value) => value.trim())
    .pipe(
      z.string().min(1, "OPENROUTER_DEFAULT_MODEL cannot be empty."),
    )
    .default(DEFAULT_OPENROUTER_MODEL),
  OPENROUTER_DEFAULT_MAX_TOKENS: optionalPositiveInteger(
    "OPENROUTER_DEFAULT_MAX_TOKENS",
    DEFAULT_OPENROUTER_MAX_TOKENS,
  ),
  OPENROUTER_REQUEST_TIMEOUT_MS: optionalPositiveInteger(
    "OPENROUTER_REQUEST_TIMEOUT_MS",
    DEFAULT_OPENROUTER_REQUEST_TIMEOUT_MS,
  ),
  AGENT_TURN_DEADLINE_MS: optionalPositiveInteger(
    "AGENT_TURN_DEADLINE_MS",
    DEFAULT_AGENT_TURN_DEADLINE_MS,
  ),
  CARTESIA_API_KEY: requiredString("CARTESIA_API_KEY"),
  ELEVENLABS_API_KEY: requiredString("ELEVENLABS_API_KEY"),
  MISTRAL_API_KEY: requiredString("MISTRAL_API_KEY"),
  SENTRY_DSN: requiredUrl("SENTRY_DSN"),
});

/**
 * Parsed and validated runtime configuration for the agent orchestrator.
 */
export type AgentEnv = z.infer<typeof AgentEnvSchema>;

/**
 * Produces a single aggregated validation error so operators can fix every
 * invalid variable in one pass instead of failing key-by-key.
 *
 * @param error - The Zod validation error for the environment object.
 * @throws {Error} Always throws a formatted runtime error.
 */
export function throwEnvValidationError(error: z.ZodError): never {
  const issuesByKey = new Map<string, string[]>();

  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "environment";
    const keyIssues = issuesByKey.get(key) ?? [];
    keyIssues.push(issue.message);
    issuesByKey.set(key, keyIssues);
  }

  const lines = Array.from(issuesByKey.entries()).map(
    ([key, messages]) => `- ${key}: ${messages.join("; ")}`,
  );

  throw new Error(
    `Invalid agent environment configuration:\n${lines.join("\n")}\nUpdate your environment and restart the agent service.`,
  );
}

/**
 * Parses the agent environment and throws one aggregated error when one or
 * more configuration values are missing or invalid.
 *
 * @param environment - Environment variables to validate.
 * @returns The trimmed and validated agent environment.
 * @throws {Error} When any required setting is missing or invalid.
 */
export function parseAgentEnvironment(
  environment: NodeJS.ProcessEnv,
): AgentEnv {
  const parsedEnvironment = AgentEnvSchema.safeParse(environment);

  if (!parsedEnvironment.success) {
    throwEnvValidationError(parsedEnvironment.error);
  }

  return parsedEnvironment.data;
}

/**
 * Parsed and validated runtime configuration for the agent orchestrator.
 */
export const env = parseAgentEnvironment(process.env);

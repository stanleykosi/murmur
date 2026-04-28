/**
 * Runtime environment validation for the Murmur API service.
 *
 * This module is the single source of truth for API configuration. It loads
 * process environment variables, validates them with fail-fast diagnostics, and
 * exports a parsed object for all other modules to consume.
 */

import "dotenv/config";

import { z } from "zod";

const LOG_LEVELS = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
] as const;

const NODE_ENVS = ["development", "test", "production"] as const;

/**
 * Builds a trimmed, required non-empty string validator for secret-like values.
 *
 * @param label - Human-readable variable name used in validation messages.
 * @returns A Zod string schema that rejects missing or whitespace-only values.
 */
function requiredString(label: string): z.ZodType<string> {
  return z
    .string({
      required_error: `${label} is required.`,
      invalid_type_error: `${label} must be a string.`,
    })
    .transform((value) => value.trim())
    .pipe(z.string().min(1, `${label} cannot be empty.`));
}

/**
 * Builds a trimmed URL validator for connection strings and DSNs.
 *
 * @param label - Human-readable variable name used in validation messages.
 * @returns A Zod schema that ensures the supplied value is a valid absolute URL.
 */
function requiredUrl(label: string): z.ZodType<string> {
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
 * Builds a required comma-separated origin list validator for browser-facing
 * CORS configuration.
 *
 * Each entry must be an absolute URL with a scheme; values are normalized to
 * their URL origin so operators can supply either `https://example.com` or
 * `https://example.com/` without changing runtime behavior.
 *
 * @param label - Human-readable variable name used in validation messages.
 * @returns A Zod schema that yields a de-duplicated list of normalized origins.
 */
function requiredOriginList(label: string): z.ZodType<string[], z.ZodTypeDef, string> {
  return requiredString(label).transform((value, context) => {
    const rawEntries = value.split(",");
    let hasValidationIssue = false;

    if (rawEntries.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must include at least one origin.`,
      });
      hasValidationIssue = true;

      return z.NEVER;
    }

    const normalizedOrigins: string[] = [];

    for (const [index, rawEntry] of rawEntries.entries()) {
      const entry = rawEntry.trim();

      if (entry.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} contains an empty origin at position ${index + 1}.`,
        });
        hasValidationIssue = true;
        continue;
      }

      try {
        normalizedOrigins.push(new URL(entry).origin);
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} contains an invalid URL at position ${index + 1}: "${entry}".`,
        });
        hasValidationIssue = true;
      }
    }

    if (hasValidationIssue) {
      return z.NEVER;
    }

    return Array.from(new Set(normalizedOrigins));
  });
}

const ApiEnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default("development"),
  HOST: z
    .string()
    .trim()
    .min(1, "HOST cannot be empty.")
    .default("0.0.0.0"),
  PORT: z.coerce
    .number({
      invalid_type_error: "PORT must be a number.",
    })
    .int("PORT must be an integer.")
    .min(1, "PORT must be greater than 0.")
    .max(65535, "PORT must be less than or equal to 65535.")
    .default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  CORS_ALLOWED_ORIGINS: requiredOriginList("CORS_ALLOWED_ORIGINS"),
  DATABASE_URL: requiredUrl("DATABASE_URL"),
  REDIS_URL: requiredUrl("REDIS_URL"),
  CLERK_SECRET_KEY: requiredString("CLERK_SECRET_KEY"),
  CLERK_WEBHOOK_SECRET: requiredString("CLERK_WEBHOOK_SECRET"),
  LIVEKIT_API_KEY: requiredString("LIVEKIT_API_KEY"),
  LIVEKIT_API_SECRET: requiredString("LIVEKIT_API_SECRET"),
  LIVEKIT_URL: requiredUrl("LIVEKIT_URL"),
  CENTRIFUGO_API_URL: requiredUrl("CENTRIFUGO_API_URL"),
  CENTRIFUGO_API_KEY: requiredString("CENTRIFUGO_API_KEY"),
  CENTRIFUGO_TOKEN_SECRET: requiredString("CENTRIFUGO_TOKEN_SECRET"),
  SENTRY_DSN: requiredUrl("SENTRY_DSN"),
});

/**
 * Produces a single aggregated validation error so operators can fix every
 * invalid variable in one pass instead of failing key-by-key.
 *
 * @param error - The Zod validation error for the environment object.
 * @throws {Error} Always throws a formatted runtime error.
 */
function throwEnvValidationError(error: z.ZodError): never {
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
    `Invalid API environment configuration:\n${lines.join("\n")}\nUpdate your environment and restart the API.`,
  );
}

const parsedEnv = ApiEnvSchema.safeParse(process.env);

if (!parsedEnv.success) {
  throwEnvValidationError(parsedEnv.error);
}

/**
 * Parsed and validated runtime configuration for the API service.
 */
export const env = parsedEnv.data;

/**
 * Convenience type for strongly typing modules that depend on API runtime
 * configuration values.
 */
export type ApiEnv = typeof env;

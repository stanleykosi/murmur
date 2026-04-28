/**
 * Shared request-validation helpers for Murmur API routes.
 *
 * This module centralizes Zod-to-API error translation so every route emits
 * the same `ValidationError` payload shape for malformed params, queries, and
 * request bodies.
 */

import { z, type ZodType } from "zod";
import type { ValidationIssueDetail } from "@murmur/shared";

import { ValidationError } from "./errors.js";

/**
 * Serializes Zod issues into a stable payload shape for API error responses.
 *
 * @param issues - Validation issues emitted by Zod.
 * @returns Flat issue objects containing path and message details.
 */
export function mapZodIssues(
  issues: ReadonlyArray<z.ZodIssue>,
): ValidationIssueDetail[] {
  return issues.map((issue) => ({
    message: issue.message,
    path: issue.path.join("."),
  }));
}

/**
 * Parses untyped request input with Zod and converts failures into the API's
 * canonical validation error class.
 *
 * @param schema - Zod schema describing the expected request shape.
 * @param input - Raw request input to validate.
 * @param message - Client-facing validation failure message.
 * @returns The parsed and strongly typed input value.
 * @throws {ValidationError} When the payload does not match the schema.
 */
export function parseWithSchema<T>(
  schema: ZodType<T>,
  input: unknown,
  message: string,
): T {
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    throw new ValidationError(message, mapZodIssues(parsed.error.issues));
  }

  return parsed.data;
}

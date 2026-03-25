/**
 * Structured logging utilities for the Murmur API service.
 *
 * The API uses Pino for JSON logs so service events can be shipped directly to
 * Railway, Vercel, or other log collectors without custom formatting layers.
 */

import pino from "pino";

import { env } from "../config/env.js";

/**
 * Shared Pino logger instance used by Fastify and non-request modules.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: "api",
  },
  redact: {
    paths: ["req.headers.authorization"],
    remove: true,
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Creates a child logger with stable contextual bindings for a subsystem or
 * request-adjacent helper.
 *
 * @param bindings - Structured key/value pairs to attach to every log entry.
 * @returns A child logger derived from the shared API logger.
 */
export function createLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}

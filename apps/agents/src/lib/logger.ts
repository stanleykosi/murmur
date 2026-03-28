/**
 * Structured logging utilities for the Murmur agents service.
 *
 * The orchestrator, runners, repositories, and transport helpers all write
 * JSON logs through this module so runtime diagnostics stay consistent across
 * the service without importing logger state from another app.
 */

import pino from "pino";

const LOG_LEVEL = process.env.LOG_LEVEL?.trim() || "info";

/**
 * Shared Pino logger instance for the agents service.
 */
export const logger = pino({
  level: LOG_LEVEL,
  base: {
    service: "agents",
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Creates a child logger with stable bindings for a subsystem.
 *
 * @param bindings - Structured key/value context to attach to emitted logs.
 * @returns A child logger derived from the shared agents logger.
 */
export function createLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}

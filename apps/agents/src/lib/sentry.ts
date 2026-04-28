/**
 * Canonical Sentry bootstrap for the Murmur agents service.
 *
 * Railway hosts the orchestrator and agent runners, so runtime failures across
 * turn execution, floor control, and third-party AI calls should all converge
 * on one capture helper with stable room and agent metadata.
 */

import * as Sentry from "@sentry/node";

import { env } from "../config/env.js";

const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;
const AGENTS_SENTRY_INIT_KEY = Symbol.for("murmur.agents.sentry.initialized");

/**
 * Minimal logger surface required for runtime error capture.
 */
export interface RuntimeErrorLogger {
  error: (...args: unknown[]) => void;
}

/**
 * Structured runtime error metadata captured alongside the thrown error.
 */
export interface RuntimeErrorContext {
  stage: string;
  roomId?: string;
  agentId?: string;
  [key: string]: unknown;
}

/**
 * Normalizes an arbitrary thrown value into a concrete `Error`.
 *
 * @param value - Candidate thrown value from a dependency or caller.
 * @returns A concrete `Error` instance.
 */
export function normalizeError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  return new Error(`Unexpected non-Error value: ${String(value)}.`);
}

/**
 * Initializes the shared agents Sentry client once for the current process.
 */
function initializeSentry(): void {
  const globalState = globalThis as typeof globalThis & {
    [AGENTS_SENTRY_INIT_KEY]?: boolean;
  };

  if (globalState[AGENTS_SENTRY_INIT_KEY]) {
    return;
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 0.2,
    environment: process.env.NODE_ENV?.trim() || "development",
  });
  Sentry.setTag("service", "agents");
  globalState[AGENTS_SENTRY_INIT_KEY] = true;
}

initializeSentry();

export function captureRuntimeError(
  logger: RuntimeErrorLogger,
  error: unknown,
  context: RuntimeErrorContext,
): Error {
  const normalizedError = normalizeError(error);
  const { stage, roomId, agentId, ...extra } = context;

  logger.error(
    {
      ...context,
      err: normalizedError,
    },
    "Captured agents runtime error.",
  );

  Sentry.withScope((scope) => {
    scope.setTag("service", "agents");
    scope.setTag("stage", stage);

    if (roomId) {
      scope.setTag("roomId", roomId);
    }

    if (agentId) {
      scope.setTag("agentId", agentId);
    }

    for (const [key, value] of Object.entries(extra)) {
      scope.setExtra(key, value);
    }

    Sentry.captureException(normalizedError);
  });

  return normalizedError;
}

/**
 * Flushes pending Sentry envelopes before the service exits.
 *
 * @param timeoutMs - Maximum amount of time to wait for delivery.
 * @returns Whether the flush completed before the timeout elapsed.
 */
export async function flushSentry(
  timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
): Promise<boolean> {
  return await Sentry.flush(timeoutMs);
}

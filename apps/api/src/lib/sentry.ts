/**
 * Canonical Sentry bootstrap for the Murmur API service.
 *
 * Railway hosts this Fastify API, so server-side exceptions and crash paths
 * should be reported centrally through this module instead of ad-hoc SDK calls
 * scattered across routes and startup logic.
 */

import * as Sentry from "@sentry/node";

import { env } from "../config/env.js";

const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;
const API_SENTRY_INIT_KEY = Symbol.for("murmur.api.sentry.initialized");

/**
 * Structured capture metadata accepted by the API Sentry helper.
 */
export interface CaptureExceptionContext {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

/**
 * Normalizes arbitrary thrown values into concrete `Error` instances so the API
 * can always capture stack-bearing objects in Sentry.
 *
 * @param value - Unknown thrown value from application code.
 * @returns A concrete `Error` instance.
 */
function normalizeError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  return new Error(`Unexpected non-Error value: ${String(value)}.`);
}

/**
 * Initializes the shared Sentry client once for the API process.
 */
function initializeSentry(): void {
  const globalState = globalThis as typeof globalThis & {
    [API_SENTRY_INIT_KEY]?: boolean;
  };

  if (globalState[API_SENTRY_INIT_KEY]) {
    return;
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 0.2,
    environment: env.NODE_ENV,
  });
  Sentry.setTag("service", "api");
  globalState[API_SENTRY_INIT_KEY] = true;
}

initializeSentry();

/**
 * Captures one API exception with optional tags and structured extra context.
 *
 * @param error - Unknown throwable from request or process lifecycle code.
 * @param context - Optional Sentry tags and extra payload fields.
 * @returns The normalized `Error` instance for rethrowing or logging.
 */
export function captureException(
  error: unknown,
  context: CaptureExceptionContext = {},
): Error {
  const normalizedError = normalizeError(error);

  Sentry.withScope((scope) => {
    scope.setTag("service", "api");

    for (const [key, value] of Object.entries(context.tags ?? {})) {
      scope.setTag(key, value);
    }

    for (const [key, value] of Object.entries(context.extra ?? {})) {
      scope.setExtra(key, value);
    }

    Sentry.captureException(normalizedError);
  });

  return normalizedError;
}

/**
 * Flushes pending Sentry events before shutdown or process exit.
 *
 * @param timeoutMs - Maximum amount of time to wait for delivery.
 * @returns Whether the flush completed before the timeout elapsed.
 */
export async function flushSentry(
  timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
): Promise<boolean> {
  return await Sentry.flush(timeoutMs);
}

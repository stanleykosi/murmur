/**
 * Temporary runtime-error capture helper for the Murmur agents service.
 *
 * Step 35 will replace this with the real Sentry integration. For Step 34 we
 * keep one explicit error-reporting facade so the runner and orchestrator can
 * implement complete restart and shutdown behavior without scattering future
 * telemetry migration work across the codebase.
 */

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
 * Records one runtime error through the temporary Step 34 facade.
 *
 * @param logger - Structured logger used for the current subsystem.
 * @param error - Arbitrary thrown value that should be normalized and logged.
 * @param context - Structured metadata about the stage that failed.
 * @returns The normalized `Error` instance for rethrowing or emission.
 */
export function captureRuntimeError(
  logger: RuntimeErrorLogger,
  error: unknown,
  context: RuntimeErrorContext,
): Error {
  const normalizedError = normalizeError(error);

  logger.error(
    {
      ...context,
      err: normalizedError,
    },
    "Captured agents runtime error.",
  );

  return normalizedError;
}

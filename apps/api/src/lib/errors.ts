/**
 * Canonical application error types and response serialization helpers for the
 * Murmur API service.
 *
 * These classes keep HTTP status mapping, stable machine-readable codes, and
 * safe client-facing messages in one place so routes and services can fail
 * consistently as the API surface grows.
 */

import type { ApiErrorResponse } from "@murmur/shared";

/**
 * Construction options for application-specific error instances.
 */
export interface AppErrorOptions {
  code: string;
  statusCode: number;
  details?: unknown;
  expose?: boolean;
  cause?: unknown;
}

/**
 * Base error class for known, intentionally handled API failures.
 */
export class AppError extends Error {
  public readonly code: string;

  public readonly details?: unknown;

  public readonly expose: boolean;

  public readonly statusCode: number;

  /**
   * Creates a new handled application error.
   *
   * @param message - Human-readable error message.
   * @param options - Metadata that controls HTTP status and serialization.
   */
  public constructor(message: string, options: AppErrorOptions) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.details = options.details;
    this.expose = options.expose ?? options.statusCode < 500;

    Error.captureStackTrace?.(this, new.target);
  }
}

/**
 * Error raised when a requested resource or route cannot be found.
 */
export class NotFoundError extends AppError {
  public constructor(message = "Resource not found.", details?: unknown) {
    super(message, {
      code: "not_found",
      statusCode: 404,
      details,
      expose: true,
    });
  }
}

/**
 * Error raised when authentication is missing or invalid.
 */
export class UnauthorizedError extends AppError {
  public constructor(message = "Authentication is required.", details?: unknown) {
    super(message, {
      code: "unauthorized",
      statusCode: 401,
      details,
      expose: true,
    });
  }
}

/**
 * Error raised when an authenticated caller lacks the required permissions.
 */
export class ForbiddenError extends AppError {
  public constructor(message = "You do not have access to this resource.", details?: unknown) {
    super(message, {
      code: "forbidden",
      statusCode: 403,
      details,
      expose: true,
    });
  }
}

/**
 * Error raised for well-understood client input problems.
 */
export class ValidationError extends AppError {
  public constructor(message = "The request payload is invalid.", details?: unknown) {
    super(message, {
      code: "validation_error",
      statusCode: 400,
      details,
      expose: true,
    });
  }
}

/**
 * Error raised for unexpected internal failures.
 */
export class InternalServerError extends AppError {
  public constructor(message = "Internal server error.", details?: unknown, cause?: unknown) {
    super(message, {
      code: "internal_server_error",
      statusCode: 500,
      details,
      expose: false,
      cause,
    });
  }
}

/**
 * Narrowing helper for handled API errors.
 *
 * @param error - Unknown thrown value.
 * @returns True when the value is an AppError instance.
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Converts a thrown error into the standardized nested API error payload.
 *
 * @param error - Unknown thrown value from a route, hook, or service.
 * @param requestId - Fastify request identifier for correlating logs.
 * @returns A serialized error response safe to send to the client.
 */
export function serializeErrorResponse(
  error: unknown,
  requestId: string,
): ApiErrorResponse {
  const normalizedError = isAppError(error)
    ? error
    : new InternalServerError("Internal server error.", undefined, error);

  const response: ApiErrorResponse = {
    error: {
      code: normalizedError.code,
      message: normalizedError.expose ? normalizedError.message : "Internal server error.",
      statusCode: normalizedError.statusCode,
      requestId,
    },
  };

  if (normalizedError.expose && normalizedError.details !== undefined) {
    response.error.details = normalizedError.details;
  }

  return response;
}

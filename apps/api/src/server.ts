/**
 * Fastify bootstrap for the Murmur API service.
 *
 * This file wires together the API runtime scaffold: CORS, health checks,
 * structured error responses, Redis/database readiness checks, graceful
 * shutdown, and the canonical route registration for rooms, agents, admin
 * controls, and Clerk webhooks.
 */

import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { fileURLToPath } from "node:url";

import { env } from "./config/env.js";
import { closeDatabasePool, testDatabaseConnection } from "./db/client.js";
import {
  AppError,
  InternalServerError,
  NotFoundError,
  serializeErrorResponse,
} from "./lib/errors.js";
import { createLogger, logger } from "./lib/logger.js";
import { registerAuthDecorators } from "./middleware/auth.js";
import { closeRedis, connectRedis, pingRedis } from "./lib/redis.js";
import { captureException, flushSentry } from "./lib/sentry.js";
import { adminRoutes } from "./routes/admin.js";
import { agentsRoutes } from "./routes/agents.js";
import { roomsRoutes } from "./routes/rooms.js";
import { webhookRoutes } from "./routes/webhooks.js";

const serverLogger = createLogger({ component: "server" });

let registeredSignalHandlers = false;
let registeredProcessErrorHandlers = false;
let shutdownPromise: Promise<void> | null = null;

/**
 * Successful health check response shape for platform probes.
 */
interface HealthCheckResponse {
  status: "ok";
  service: "api";
  timestamp: string;
  uptimeSeconds: number;
  redis: {
    status: "ready";
  };
}

/**
 * Builds a Fastify server instance without starting the network listener.
 *
 * @returns A configured Fastify application ready for tests or startup.
 */
export function buildServer() {
  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: false,
  });
  const allowedOrigins = new Set(env.CORS_ALLOWED_ORIGINS);

  registerAuthDecorators(app);

  void app.register(cors, {
    origin(origin, callback) {
      // Browsers omit Origin for same-origin, server-to-server, and health-check
      // requests, so those calls should remain allowed.
      if (origin === undefined) {
        callback(null, true);
        return;
      }

      callback(null, allowedOrigins.has(origin));
    },
  });

  void app.register(sensible);
  void app.register(agentsRoutes, {
    prefix: "/api/agents",
  });
  void app.register(adminRoutes, {
    prefix: "/api/admin",
  });
  void app.register(roomsRoutes, {
    prefix: "/api/rooms",
  });
  void app.register(webhookRoutes, {
    prefix: "/api/webhooks",
  });

  app.get<{ Reply: HealthCheckResponse }>("/health", async () => {
    await pingRedis();

    return {
      status: "ok",
      service: "api",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Number(process.uptime().toFixed(3)),
      redis: {
        status: "ready",
      },
    };
  });

  app.setNotFoundHandler((request, reply) => {
    const error = new NotFoundError(`Route ${request.method} ${request.url} was not found.`);

    reply
      .status(error.statusCode)
      .send(serializeErrorResponse(error, String(request.id)));
  });

  app.setErrorHandler((error, request, reply) => {
    const normalizedError =
      error instanceof AppError ? error : new InternalServerError("Internal server error.", undefined, error);

    const logPayload = {
      err: error,
      code: normalizedError.code,
      method: request.method,
      requestId: request.id,
      statusCode: normalizedError.statusCode,
      url: request.url,
    };

    if (normalizedError.statusCode >= 500) {
      captureException(error, {
        tags: {
          code: normalizedError.code,
          statusCode: String(normalizedError.statusCode),
        },
        extra: {
          method: request.method,
          requestId: String(request.id),
          url: request.url,
        },
      });
      request.log.error(logPayload, "Unhandled request error.");
    } else {
      request.log.warn(logPayload, "Handled request error.");
    }

    if (!reply.sent) {
      reply
        .status(normalizedError.statusCode)
        .send(serializeErrorResponse(normalizedError, String(request.id)));
    }
  });

  return app;
}

/**
 * Registers one-time signal handlers so the API stops accepting traffic and
 * releases Redis cleanly when the process is terminated.
 *
 * @param app - The running Fastify instance.
 */
type ApiServer = ReturnType<typeof buildServer>;

/**
 * Executes the shared API shutdown path exactly once regardless of which
 * lifecycle event initiated termination.
 *
 * @param app - The running Fastify instance.
 * @param context - Structured metadata describing why shutdown began.
 * @returns A promise that settles when resource cleanup and Sentry flushes finish.
 */
async function shutdownApi(
  app: ApiServer,
  context: {
    cause: "fatal_error" | "signal" | "startup_failure";
    signal?: NodeJS.Signals;
    error?: Error;
    source?: "uncaughtException" | "unhandledRejection";
  },
): Promise<void> {
  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      serverLogger.info(
        {
          cause: context.cause,
          errorName: context.error?.name,
          signal: context.signal,
          source: context.source,
        },
        "API shutdown initiated.",
      );

      await Promise.allSettled([
        app.close(),
        closeDatabasePool(),
        closeRedis(),
      ]);

      await flushSentry();
    })().finally(() => {
      shutdownPromise = null;
    });
  }

  await shutdownPromise;
}

function registerSignalHandlers(app: ApiServer): void {
  if (registeredSignalHandlers) {
    return;
  }

  registeredSignalHandlers = true;

  const shutdown = async (signal: NodeJS.Signals) => {
    serverLogger.info({ signal }, "Received shutdown signal.");

    try {
      await shutdownApi(app, {
        cause: "signal",
        signal,
      });
      serverLogger.info({ signal }, "API shutdown complete.");
      process.exitCode = 0;
    } catch (error) {
      serverLogger.error({ err: error, signal }, "API shutdown failed.");
      process.exitCode = 1;
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }
}

/**
 * Registers one-time crash handlers for fatal process-level failures that sit
 * outside Fastify's request lifecycle.
 *
 * @param app - The running Fastify instance.
 */
function registerProcessErrorHandlers(app: ApiServer): void {
  if (registeredProcessErrorHandlers) {
    return;
  }

  registeredProcessErrorHandlers = true;

  const handleFatalProcessError = async (
    source: "uncaughtException" | "unhandledRejection",
    error: unknown,
  ) => {
    const normalizedError = captureException(error, {
      tags: {
        source,
      },
      extra: {
        processUptimeSeconds: Number(process.uptime().toFixed(3)),
      },
    });

    serverLogger.fatal(
      {
        err: normalizedError,
        source,
      },
      "API process encountered a fatal error.",
    );

    try {
      await shutdownApi(app, {
        cause: "fatal_error",
        error: normalizedError,
        source,
      });
    } catch (shutdownError) {
      serverLogger.error(
        {
          err: shutdownError,
          source,
        },
        "API fatal-error shutdown failed.",
      );
    }

  };

  process.once("uncaughtException", (error) => {
    void handleFatalProcessError("uncaughtException", error).finally(() => {
      process.exit(1);
    });
  });

  process.once("unhandledRejection", (reason) => {
    void handleFatalProcessError("unhandledRejection", reason).finally(() => {
      process.exit(1);
    });
  });
}

/**
 * Starts the HTTP listener after confirming Redis is reachable.
 *
 * @returns The running Fastify instance.
 */
export async function startServer(): Promise<ApiServer> {
  const app = buildServer();

  try {
    await connectRedis();
    await pingRedis();
    await testDatabaseConnection();

    await app.listen({
      host: env.HOST,
      port: env.PORT,
    });

    registerSignalHandlers(app);
    registerProcessErrorHandlers(app);

    serverLogger.info(
      {
        host: env.HOST,
        nodeEnv: env.NODE_ENV,
        port: env.PORT,
      },
      "Murmur API server started.",
    );

    return app;
  } catch (error) {
    const normalizedError = captureException(error, {
      tags: {
        stage: "startup",
      },
      extra: {
        host: env.HOST,
        port: env.PORT,
      },
    });

    serverLogger.error(
      { err: normalizedError },
      "Failed to start the Murmur API server.",
    );

    await shutdownApi(app, {
      cause: "startup_failure",
      error: normalizedError,
    }).catch(async () => {
      await flushSentry();
    });

    throw error;
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectExecution) {
  void startServer().catch((error) => {
    serverLogger.fatal({ err: error }, "API process exited during startup.");
    void flushSentry().finally(() => {
      process.exit(1);
    });
  });
}

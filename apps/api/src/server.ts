/**
 * Fastify bootstrap for the Murmur API service.
 *
 * This file wires together the API runtime scaffold: CORS, health checks,
 * structured error responses, Redis/database readiness checks, graceful
 * shutdown, and the canonical `/api/rooms` route registration.
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
import { roomsRoutes } from "./routes/rooms.js";

const serverLogger = createLogger({ component: "server" });
const allowedOrigins = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://murmur.app",
  "https://www.murmur.app",
]);

let registeredSignalHandlers = false;

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
  void app.register(roomsRoutes, {
    prefix: "/api/rooms",
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

function registerSignalHandlers(app: ApiServer): void {
  if (registeredSignalHandlers) {
    return;
  }

  registeredSignalHandlers = true;

  let shutdownPromise: Promise<void> | null = null;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      serverLogger.info({ signal }, "Received shutdown signal.");

      try {
        await app.close();
        await closeDatabasePool();
        await closeRedis();
        serverLogger.info({ signal }, "API shutdown complete.");
        process.exitCode = 0;
      } catch (error) {
        serverLogger.error({ err: error, signal }, "API shutdown failed.");
        process.exitCode = 1;
      }
    })();

    await shutdownPromise;
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }
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
    serverLogger.error({ err: error }, "Failed to start the Murmur API server.");

    await Promise.allSettled([app.close(), closeDatabasePool(), closeRedis()]);

    throw error;
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectExecution) {
  void startServer().catch((error) => {
    serverLogger.fatal({ err: error }, "API process exited during startup.");
    process.exit(1);
  });
}

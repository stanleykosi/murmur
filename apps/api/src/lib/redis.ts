/**
 * Redis client lifecycle management for the Murmur API service.
 *
 * Redis is a startup-critical dependency for listener presence, room state, and
 * other coordination primitives. This module exposes a shared singleton client
 * plus explicit connect/ping/close helpers so bootstrap and shutdown behavior
 * stay deterministic.
 */

import { Redis } from "ioredis";

import { env } from "../config/env.js";
import { createLogger } from "./logger.js";

const redisLogger = createLogger({ component: "redis" });
const REDIS_QUIT_TIMEOUT_MS = 5_000;

/**
 * Shared Redis client instance for the API service.
 */
export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});

let connectPromise: Promise<void> | null = null;

redis.on("connect", () => {
  redisLogger.info({ status: redis.status }, "Redis connection established.");
});

redis.on("ready", () => {
  redisLogger.info({ status: redis.status }, "Redis client is ready.");
});

redis.on("reconnecting", (delay: number) => {
  redisLogger.warn({ delay, status: redis.status }, "Redis client reconnecting.");
});

redis.on("error", (error: unknown) => {
  redisLogger.error({ err: error, status: redis.status }, "Redis client error.");
});

redis.on("end", () => {
  redisLogger.info({ status: redis.status }, "Redis connection ended.");
});

/**
 * Waits for the singleton Redis client to become ready after an in-flight
 * connection or reconnect attempt.
 *
 * @returns A promise that resolves once the client reports `ready`.
 */
function waitForReadyState(): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      redis.off("ready", handleReady);
      redis.off("error", handleError);
      redis.off("end", handleEnd);
    };

    const handleReady = () => {
      cleanup();
      resolve();
    };

    const handleError = (error: unknown) => {
      cleanup();
      reject(error);
    };

    const handleEnd = () => {
      cleanup();
      reject(new Error("Redis connection ended before becoming ready."));
    };

    redis.on("ready", handleReady);
    redis.on("error", handleError);
    redis.on("end", handleEnd);
  });
}

/**
 * Establishes the singleton Redis connection if it is not already ready.
 *
 * @returns A promise that resolves once Redis is ready for commands.
 */
export async function connectRedis(): Promise<void> {
  if (redis.status === "ready") {
    return;
  }

  if (connectPromise) {
    return connectPromise;
  }

  connectPromise = (async () => {
    if (redis.status === "end") {
      throw new Error("Redis client has been permanently closed.");
    }

    if (redis.status === "wait") {
      await redis.connect();
      return;
    }

    if (redis.status === "connecting" || redis.status === "connect" || redis.status === "reconnecting") {
      await waitForReadyState();
      return;
    }

    if (redis.status === "close") {
      await waitForReadyState();
      return;
    }

    throw new Error(`Redis client is in an unsupported state: ${redis.status}.`);
  })().finally(() => {
    connectPromise = null;
  });

  return connectPromise;
}

/**
 * Verifies that Redis is accepting commands and responding as expected.
 *
 * @returns A promise that resolves when Redis responds with `PONG`.
 */
export async function pingRedis(): Promise<void> {
  const response = await redis.ping();

  if (response !== "PONG") {
    throw new Error(`Unexpected Redis ping response: ${response}`);
  }
}

/**
 * Gracefully closes the Redis connection without hanging shutdown forever.
 *
 * @returns A promise that resolves once the client has stopped.
 */
export async function closeRedis(): Promise<void> {
  if (redis.status === "wait" || redis.status === "end") {
    return;
  }

  try {
    await Promise.race([
      redis.quit(),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Timed out waiting ${REDIS_QUIT_TIMEOUT_MS}ms for Redis to quit.`));
        }, REDIS_QUIT_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    // If graceful quit fails, force the socket closed so process shutdown can continue.
    redisLogger.warn({ err: error, status: redis.status }, "Forcing Redis disconnect during shutdown.");
    redis.disconnect();
  }
}

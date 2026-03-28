/**
 * Unit tests for Murmur's Redis-backed silence timer.
 *
 * These assertions pin the dead-air contract that Step 34 will rely on: empty
 * floors persist a silence window, the host is granted the floor after five
 * seconds of silence, and recovery races are handled without duplicate events.
 */

import {
  DEAD_AIR_TIMEOUT_MS,
  getFloorStateKey,
  getMutedAgentsKey,
  getRoomSilenceKey,
} from "@murmur/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FloorController,
  type FloorControllerLogger,
  type FloorRedisClient,
} from "./controller.js";
import {
  DEAD_AIR_PROMPT,
  SilenceTimer,
} from "./silence-timer.js";

const INCONSISTENT_FLOOR_STATE_ERROR =
  'Redis floor state is inconsistent. Both "holder" and "claimedAt" must be present together as non-empty values.';

/**
 * Creates a quiet logger double for timer and controller tests.
 *
 * @returns Logger methods backed by Vitest spies.
 */
function createLogger(): FloorControllerLogger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return {
    promise,
    reject,
    resolve,
  };
}

interface RedisFixture {
  client: FloorRedisClient;
  delMock: ReturnType<typeof vi.fn>;
  evalMock: ReturnType<typeof vi.fn>;
  getString(key: string): string | null;
  seedFloorHash(key: string, hash: Record<string, string>): void;
  seedString(key: string, value: string): void;
  setClaimHandler(
    handler: (
      args: {
        agentId: string;
        claimedAt: string;
        floorKey: string;
        mutedKey: string;
      },
      state: {
        hashes: Map<string, Record<string, string>>;
        sets: Map<string, Set<string>>;
        strings: Map<string, string>;
      },
    ) => Promise<unknown> | unknown,
  ): void;
}

/**
 * Creates a Redis double that emulates the floor controller's scripts while
 * allowing tests to inject claim-race behavior.
 *
 * @returns The Redis client plus test helpers for seeding and inspection.
 */
function createRedisFixture(): RedisFixture {
  const hashes = new Map<string, Record<string, string>>();
  const sets = new Map<string, Set<string>>();
  const strings = new Map<string, string>();
  let claimHandler:
    | ((
      args: {
        agentId: string;
        claimedAt: string;
        floorKey: string;
        mutedKey: string;
      },
      state: {
        hashes: Map<string, Record<string, string>>;
        sets: Map<string, Set<string>>;
        strings: Map<string, string>;
      },
    ) => Promise<unknown> | unknown)
    | null = null;

  const evalMock = vi.fn(
    async (
      _script: string,
      numKeys: number,
      ...args: Array<string | number>
    ): Promise<unknown> => {
      if (numKeys === 2 && args.length === 4) {
        const [floorKey, mutedKey, agentId, claimedAt] = args.map(String);

        if (claimHandler) {
          return await claimHandler(
            {
              agentId,
              claimedAt,
              floorKey,
              mutedKey,
            },
            {
              hashes,
              sets,
              strings,
            },
          );
        }

        const hash = hashes.get(floorKey) ?? {};
        const holder = hash.holder;
        const persistedClaimedAt = hash.claimedAt;

        if (
          holder === ""
          || persistedClaimedAt === ""
          || (holder === undefined) !== (persistedClaimedAt === undefined)
        ) {
          throw new Error(INCONSISTENT_FLOOR_STATE_ERROR);
        }

        if (sets.get(mutedKey)?.has(agentId) ?? false) {
          return 2;
        }

        if (holder === undefined) {
          hashes.set(floorKey, {
            claimedAt,
            holder: agentId,
          });
          return 1;
        }

        return 0;
      }

      if (numKeys === 1 && args.length === 2) {
        const [floorKey, agentId] = args.map(String);
        const hash = hashes.get(floorKey) ?? {};

        if (hash.holder === agentId) {
          hashes.delete(floorKey);
          return 1;
        }

        return 0;
      }

      throw new Error(
        `Unexpected eval call shape: numKeys=${numKeys} args=${args.length}.`,
      );
    },
  );
  const getMock = vi.fn(async (key: string) => strings.get(key) ?? null);
  const hgetallMock = vi.fn(async (key: string) => ({ ...(hashes.get(key) ?? {}) }));
  const delMock = vi.fn(async (...keys: string[]) => {
    let deletedCount = 0;

    for (const key of keys) {
      if (strings.delete(key)) {
        deletedCount += 1;
      }
    }

    return deletedCount;
  });
  const setMock = vi.fn(async (key: string, value: string) => {
    strings.set(key, value);
    return "OK";
  });
  const sismemberMock = vi.fn(
    async (key: string, member: string) => (sets.get(key)?.has(member) ?? false ? 1 : 0),
  );
  const client: FloorRedisClient = {
    del: delMock,
    eval: evalMock,
    get: getMock,
    hgetall: hgetallMock,
    set: setMock,
    sismember: sismemberMock,
  };

  return {
    client,
    delMock,
    evalMock,
    getString(key: string) {
      return strings.get(key) ?? null;
    },
    seedFloorHash(key: string, hash: Record<string, string>) {
      hashes.set(key, { ...hash });
    },
    seedString(key: string, value: string) {
      strings.set(key, value);
    },
    setClaimHandler(handler) {
      claimHandler = handler;
    },
  };
}

/**
 * Advances fake timers and lets any awaited poll promises settle.
 *
 * @param ms - Duration to advance the fake timers by.
 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SilenceTimer", () => {
  it("writes the silence-start timestamp once when the floor becomes empty", async () => {
    const roomId = "room-1";
    const hostAgentId = "agent-host";
    const logger = createLogger();
    const redis = createRedisFixture();
    const roomSilenceKey = getRoomSilenceKey(roomId);
    let now = 1_000;
    const controller = new FloorController(redis.client, roomId, {
      logger,
      now: () => now,
    });
    const timer = new SilenceTimer(controller, roomId, hostAgentId, {
      logger,
      now: () => now,
    });

    timer.start();
    await advance(0);

    expect(redis.getString(roomSilenceKey)).toBe("1000");

    now = 1_250;
    await advance(250);

    expect(redis.getString(roomSilenceKey)).toBe("1000");
  });

  it("clears an existing silence marker when another agent already holds the floor", async () => {
    const roomId = "room-1";
    const hostAgentId = "agent-host";
    const logger = createLogger();
    const redis = createRedisFixture();
    const floorStateKey = getFloorStateKey(roomId);
    const roomSilenceKey = getRoomSilenceKey(roomId);
    let now = 2_000;

    redis.seedFloorHash(floorStateKey, {
      claimedAt: "1500",
      holder: "agent-guest",
    });
    redis.seedString(roomSilenceKey, "1800");

    const controller = new FloorController(redis.client, roomId, {
      logger,
      now: () => now,
    });
    const timer = new SilenceTimer(controller, roomId, hostAgentId, {
      logger,
      now: () => now,
    });

    timer.start();
    await advance(0);

    expect(redis.getString(roomSilenceKey)).toBeNull();
  });

  it("claims the host floor after five seconds of dead air and emits exactly one event", async () => {
    const roomId = "room-1";
    const hostAgentId = "agent-host";
    const logger = createLogger();
    const redis = createRedisFixture();
    const floorStateKey = getFloorStateKey(roomId);
    let now = 10_000;
    const controller = new FloorController(redis.client, roomId, {
      logger,
      now: () => now,
    });
    const timer = new SilenceTimer(controller, roomId, hostAgentId, {
      logger,
      now: () => now,
    });
    const eventHandler = vi.fn();

    timer.on("deadAirDetected", eventHandler);
    timer.start();
    await advance(0);

    now += DEAD_AIR_TIMEOUT_MS;
    await advance(DEAD_AIR_TIMEOUT_MS);

    expect(eventHandler).toHaveBeenCalledTimes(1);
    expect(await controller.getCurrentHolder()).toBe(hostAgentId);
    expect(redis.getString(getRoomSilenceKey(roomId))).toBeNull();
    expect(redis.getString(getRoomSilenceKey(roomId))).toBeNull();

    now += 1_000;
    await advance(1_000);

    expect(eventHandler).toHaveBeenCalledTimes(1);
    expect(redis.evalMock).toHaveBeenCalledWith(
      expect.any(String),
      2,
      floorStateKey,
      getMutedAgentsKey(roomId),
      hostAgentId,
      String(15_000),
    );
  });

  it("emits the canonical dead-air payload and prompt after host recovery", async () => {
    const roomId = "room-1";
    const hostAgentId = "agent-host";
    const logger = createLogger();
    const redis = createRedisFixture();
    let now = 20_000;
    const controller = new FloorController(redis.client, roomId, {
      logger,
      now: () => now,
    });
    const timer = new SilenceTimer(controller, roomId, hostAgentId, {
      logger,
      now: () => now,
    });
    const payloads: Array<Parameters<typeof timer.emit>[1]> = [];

    timer.on("deadAirDetected", (payload) => {
      payloads.push(payload);
    });

    timer.start();
    await advance(0);

    now += DEAD_AIR_TIMEOUT_MS;
    await advance(DEAD_AIR_TIMEOUT_MS);

    expect(payloads).toEqual([
      {
        detectedAt: 25_000,
        hostAgentId,
        prompt: DEAD_AIR_PROMPT,
        roomId,
        silenceDurationMs: DEAD_AIR_TIMEOUT_MS,
        silenceStartedAt: 20_000,
      },
    ]);
  });

  it("does not emit dead-air recovery when another agent wins the claim race", async () => {
    const roomId = "room-1";
    const hostAgentId = "agent-host";
    const logger = createLogger();
    const redis = createRedisFixture();
    const floorStateKey = getFloorStateKey(roomId);
    let now = 30_000;

    redis.setClaimHandler(({ floorKey }) => {
      redis.seedFloorHash(floorKey, {
        claimedAt: "34999",
        holder: "agent-rival",
      });
      return 0;
    });

    const controller = new FloorController(redis.client, roomId, {
      logger,
      now: () => now,
    });
    const timer = new SilenceTimer(controller, roomId, hostAgentId, {
      logger,
      now: () => now,
    });
    const eventHandler = vi.fn();

    timer.on("deadAirDetected", eventHandler);
    timer.start();
    await advance(0);

    now += DEAD_AIR_TIMEOUT_MS;
    await advance(DEAD_AIR_TIMEOUT_MS);

    expect(eventHandler).not.toHaveBeenCalled();
    expect(await controller.getCurrentHolder()).toBe("agent-rival");
    expect(redis.getString(getRoomSilenceKey(roomId))).toBeNull();
    expect(redis.evalMock).toHaveBeenCalledWith(
      expect.any(String),
      2,
      floorStateKey,
      getMutedAgentsKey(roomId),
      hostAgentId,
      String(35_000),
    );
  });

  it("resets the silence window and retries later when the floor stays empty after a failed claim", async () => {
    const roomId = "room-1";
    const hostAgentId = "agent-host";
    const logger = createLogger();
    const redis = createRedisFixture();
    let now = 40_000;
    let claimAttempts = 0;

    redis.setClaimHandler(() => {
      claimAttempts += 1;
      return 0;
    });

    const controller = new FloorController(redis.client, roomId, {
      logger,
      now: () => now,
    });
    const timer = new SilenceTimer(controller, roomId, hostAgentId, {
      logger,
      now: () => now,
    });
    const eventHandler = vi.fn();

    timer.on("deadAirDetected", eventHandler);
    timer.start();
    await advance(0);

    now += DEAD_AIR_TIMEOUT_MS;
    await advance(DEAD_AIR_TIMEOUT_MS);

    expect(claimAttempts).toBe(1);
    expect(redis.getString(getRoomSilenceKey(roomId))).toBe("45000");
    expect(eventHandler).not.toHaveBeenCalled();

    now += DEAD_AIR_TIMEOUT_MS;
    await advance(DEAD_AIR_TIMEOUT_MS);

    expect(claimAttempts).toBe(2);
    expect(redis.getString(getRoomSilenceKey(roomId))).toBe("50000");
    expect(eventHandler).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hostAgentId,
        roomId,
        silenceDurationMs: DEAD_AIR_TIMEOUT_MS,
      }),
      "Dead-air recovery claim did not succeed while floor stayed empty; restarting the silence window.",
    );
  });

  it("emits an error when the persisted silence timestamp is malformed", async () => {
    const roomId = "room-1";
    const hostAgentId = "agent-host";
    const logger = createLogger();
    const redis = createRedisFixture();
    let now = 50_000;

    redis.seedString(getRoomSilenceKey(roomId), "invalid");

    const controller = new FloorController(redis.client, roomId, {
      logger,
      now: () => now,
    });
    const timer = new SilenceTimer(controller, roomId, hostAgentId, {
      logger,
      now: () => now,
    });
    const errorHandler = vi.fn();

    timer.on("error", errorHandler);
    timer.start();
    await advance(0);

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(errorHandler.mock.calls[0]?.[0]?.message).toBe(
      `room silence timestamp for room "${roomId}" must be stored as a non-negative integer string.`,
    );

    await advance(DEAD_AIR_TIMEOUT_MS);

    expect(timer.isRunning()).toBe(false);
    expect(errorHandler).toHaveBeenCalledTimes(1);
  });

  it("stops polling and emitting events after stop is called", async () => {
    const roomId = "room-1";
    const hostAgentId = "agent-host";
    const logger = createLogger();
    const redis = createRedisFixture();
    let now = 60_000;
    const controller = new FloorController(redis.client, roomId, {
      logger,
      now: () => now,
    });
    const timer = new SilenceTimer(controller, roomId, hostAgentId, {
      logger,
      now: () => now,
    });
    const eventHandler = vi.fn();

    timer.on("deadAirDetected", eventHandler);
    timer.start();
    await advance(0);
    timer.stop();

    now += DEAD_AIR_TIMEOUT_MS * 2;
    await advance(DEAD_AIR_TIMEOUT_MS * 2);

    expect(timer.isRunning()).toBe(false);
    expect(eventHandler).not.toHaveBeenCalled();
    expect(redis.getString(getRoomSilenceKey(roomId))).toBe("60000");
  });

  it("rolls back an in-flight host claim when stop is called mid-poll", async () => {
    const roomId = "room-1";
    const hostAgentId = "agent-host";
    const logger = createLogger();
    const redis = createRedisFixture();
    const claimGate = createDeferred<void>();
    let now = 70_000;
    const controller = new FloorController(redis.client, roomId, {
      logger,
      now: () => now,
    });
    const timer = new SilenceTimer(controller, roomId, hostAgentId, {
      logger,
      now: () => now,
    });
    const eventHandler = vi.fn();

    redis.setClaimHandler(async ({ agentId, claimedAt, floorKey }, state) => {
      await claimGate.promise;
      state.hashes.set(floorKey, {
        claimedAt,
        holder: agentId,
      });
      return 1;
    });

    timer.on("deadAirDetected", eventHandler);
    timer.start();
    await advance(0);

    now += DEAD_AIR_TIMEOUT_MS;
    await vi.advanceTimersByTimeAsync(DEAD_AIR_TIMEOUT_MS);
    await Promise.resolve();

    timer.stop();
    claimGate.resolve();
    await advance(0);

    expect(timer.isRunning()).toBe(false);
    expect(eventHandler).not.toHaveBeenCalled();
    expect(await controller.getCurrentHolder()).toBeNull();
    expect(redis.getString(getRoomSilenceKey(roomId))).toBe("70000");
  });
});

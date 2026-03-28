/**
 * Unit tests for the Redis-backed Murmur floor controller.
 *
 * These assertions pin the single-round-trip claim contract so future
 * refactors do not reintroduce mute races or silent repair of malformed Redis
 * floor hashes.
 */

import {
  getFloorStateKey,
  getMutedAgentsKey,
} from "@murmur/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FloorController,
  type FloorControllerLogger,
  type FloorRedisClient,
} from "./controller.js";

const INCONSISTENT_FLOOR_STATE_ERROR =
  'Redis floor state is inconsistent. Both "holder" and "claimedAt" must be present together as non-empty values.';

/**
 * Creates a quiet logger double for controller tests.
 *
 * @returns Logger methods backed by Vitest spies.
 */
function createLogger(): FloorControllerLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * Creates a Redis double that emulates the controller's current script
 * contracts while still exposing call spies for assertions.
 *
 * @returns The client plus helpers for seeding runtime Redis state.
 */
function createRedisFixture() {
  const hashes = new Map<string, Record<string, string>>();
  const sets = new Map<string, Set<string>>();
  const strings = new Map<string, string>();

  const evalMock = vi.fn(
    async (
      _script: string,
      numKeys: number,
      ...args: Array<string | number>
    ): Promise<unknown> => {
      if (numKeys === 2 && args.length === 4) {
        const [floorKey, mutedKey, agentId, claimedAt] = args.map(String);
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
            holder: agentId,
            claimedAt,
          });
          return 1;
        }

        return 0;
      }

      if (numKeys === 1 && args.length === 3) {
        const [floorKey, agentId, claimedAt] = args.map(String);
        const hash = hashes.get(floorKey) ?? {};
        const holder = hash.holder;

        if (holder === undefined || holder === "") {
          hashes.set(floorKey, {
            ...hash,
            holder: agentId,
            claimedAt,
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
  const setMock = vi.fn(async (key: string, value: string) => {
    strings.set(key, value);
    return "OK";
  });
  const sismemberMock = vi.fn(
    async (key: string, member: string) => (sets.get(key)?.has(member) ?? false ? 1 : 0),
  );
  const client: FloorRedisClient = {
    eval: evalMock,
    get: getMock,
    hgetall: hgetallMock,
    set: setMock,
    sismember: sismemberMock,
  };

  return {
    client,
    evalMock,
    sismemberMock,
    seedFloorHash(key: string, hash: Record<string, string>) {
      hashes.set(key, { ...hash });
    },
    seedMutedAgent(key: string, agentId: string) {
      const members = sets.get(key) ?? new Set<string>();
      members.add(agentId);
      sets.set(key, members);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FloorController", () => {
  it("checks mute membership inside the claim script instead of a preflight lookup", async () => {
    const roomId = "room-1";
    const agentId = "agent-a";
    const logger = createLogger();
    const redis = createRedisFixture();
    const mutedAgentsKey = getMutedAgentsKey(roomId);
    const floorStateKey = getFloorStateKey(roomId);

    redis.seedMutedAgent(mutedAgentsKey, agentId);

    const controller = new FloorController(redis.client, roomId, {
      logger,
      now: () => 123,
    });

    await expect(controller.claimFloor(agentId)).resolves.toBe(false);
    expect(redis.sismemberMock).not.toHaveBeenCalled();
    expect(redis.evalMock).toHaveBeenCalledWith(
      expect.any(String),
      2,
      floorStateKey,
      mutedAgentsKey,
      agentId,
      "123",
    );
  });

  it("rejects claims when the persisted floor hash is half-written", async () => {
    const roomId = "room-1";
    const agentId = "agent-a";
    const logger = createLogger();
    const redis = createRedisFixture();
    const floorStateKey = getFloorStateKey(roomId);

    redis.seedFloorHash(floorStateKey, {
      claimedAt: "123",
    });

    const controller = new FloorController(redis.client, roomId, {
      logger,
      now: () => 456,
    });

    await expect(controller.claimFloor(agentId)).rejects.toThrow(
      INCONSISTENT_FLOOR_STATE_ERROR,
    );
  });
});

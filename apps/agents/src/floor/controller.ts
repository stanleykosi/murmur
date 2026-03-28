/**
 * Redis-backed floor controller for Murmur agent turn-taking.
 *
 * This module owns the canonical atomic claim/release primitives plus the
 * mute-state and last-spoke helpers that later orchestrator work will compose
 * into full room coordination. The implementation deliberately fails fast on
 * malformed Redis state instead of attempting silent repair.
 */

import {
  getAgentLastSpokeKey,
  getFloorStateKey,
  getMutedAgentsKey,
  getRoomSilenceKey,
  type FloorState,
} from "@murmur/shared";
import pino from "pino";

/**
 * Minimal logger surface required by the floor controller.
 */
export interface FloorControllerLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Minimal Redis client surface required by the floor controller.
 */
export interface FloorRedisClient {
  del(...keys: string[]): Promise<unknown>;
  eval(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  set(key: string, value: string): Promise<unknown>;
  sismember(key: string, member: string): Promise<number>;
}

/**
 * Optional runtime hooks for deterministic controller behavior in tests.
 */
export interface FloorControllerOptions {
  logger?: FloorControllerLogger;
  now?: () => number;
}

const defaultFloorControllerLogger = pino({
  level: process.env.LOG_LEVEL?.trim() || "info",
  base: {
    service: "agents",
    component: "floor-controller",
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

const INCONSISTENT_FLOOR_STATE_ERROR =
  'Redis floor state is inconsistent. Both "holder" and "claimedAt" must be present together as non-empty values.';

type ClaimFloorResult = "claimed" | "muted" | "occupied";

const FLOOR_CLAIM_LUA = `
-- KEYS[1] = floor:{roomId}
-- KEYS[2] = room:{roomId}:muted
-- ARGV[1] = agentId
-- ARGV[2] = current timestamp
local holder = redis.call('HGET', KEYS[1], 'holder')
local claimedAt = redis.call('HGET', KEYS[1], 'claimedAt')
local hasHolder = holder ~= false and holder ~= nil
local hasClaimedAt = claimedAt ~= false and claimedAt ~= nil

if holder == '' or claimedAt == '' or hasHolder ~= hasClaimedAt then
  return redis.error_reply(${JSON.stringify(INCONSISTENT_FLOOR_STATE_ERROR)})
end

if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then
  return 2
end

if not hasHolder then
  redis.call('HSET', KEYS[1], 'holder', ARGV[1], 'claimedAt', ARGV[2])
  return 1
end
return 0
`;

const FLOOR_RELEASE_LUA = `
local holder = redis.call('HGET', KEYS[1], 'holder')
local claimedAt = redis.call('HGET', KEYS[1], 'claimedAt')
local hasHolder = holder ~= false and holder ~= nil
local hasClaimedAt = claimedAt ~= false and claimedAt ~= nil

if holder == '' or claimedAt == '' or hasHolder ~= hasClaimedAt then
  return redis.error_reply(${JSON.stringify(INCONSISTENT_FLOOR_STATE_ERROR)})
end

if holder == ARGV[1] then
  redis.call('HDEL', KEYS[1], 'holder', 'claimedAt')
  return 1
end
return 0
`;

/**
 * Validates and trims a required identifier string.
 *
 * @param value - Candidate identifier supplied by the caller.
 * @param label - Human-readable field name used in diagnostics.
 * @returns The trimmed identifier.
 * @throws {Error} When the identifier is not a string or is blank.
 */
function normalizeRequiredText(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return normalizedValue;
}

/**
 * Validates an epoch-millisecond timestamp.
 *
 * @param value - Candidate timestamp supplied by the caller.
 * @param label - Human-readable field name used in diagnostics.
 * @returns The validated timestamp.
 * @throws {Error} When the timestamp is invalid.
 */
function normalizeTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer timestamp.`);
  }

  return value;
}

/**
 * Parses a persisted Redis timestamp string into a validated number.
 *
 * @param value - Raw Redis string value.
 * @param label - Human-readable field name used in diagnostics.
 * @returns The parsed timestamp.
 * @throws {Error} When the value is blank or not a non-negative integer.
 */
function parseStoredTimestamp(value: string, label: string): number {
  const normalizedValue = normalizeRequiredText(value, label);

  if (!/^\d+$/u.test(normalizedValue)) {
    throw new Error(`${label} must be stored as a non-negative integer string.`);
  }

  return normalizeTimestamp(Number(normalizedValue), label);
}

/**
 * Normalizes a Redis membership result into a boolean.
 *
 * @param value - Raw `SISMEMBER` result from Redis.
 * @param label - Human-readable operation label used in diagnostics.
 * @returns `true` when the member is present, otherwise `false`.
 * @throws {Error} When Redis returns an unexpected value.
 */
function parseRedisBoolean(value: unknown, label: string): boolean {
  if (value === 1 || value === "1") {
    return true;
  }

  if (value === 0 || value === "0") {
    return false;
  }

  throw new Error(`${label} returned an unexpected Redis result: ${String(value)}.`);
}

/**
 * Normalizes the Redis result codes returned by the floor-claim Lua script.
 *
 * @param value - Raw `EVAL` result from Redis.
 * @returns The semantic claim outcome.
 * @throws {Error} When Redis returns an unexpected code.
 */
function parseClaimFloorResult(value: unknown): ClaimFloorResult {
  if (value === 1 || value === "1") {
    return "claimed";
  }

  if (value === 2 || value === "2") {
    return "muted";
  }

  if (value === 0 || value === "0") {
    return "occupied";
  }

  throw new Error(
    `claimFloor returned an unexpected Redis result: ${String(value)}.`,
  );
}

/**
 * Resolves the controller clock with fail-fast validation.
 *
 * @param now - Optional injected clock for deterministic tests.
 * @returns The current epoch-millisecond timestamp.
 * @throws {Error} When the clock is invalid.
 */
function getCurrentTimestamp(now: (() => number) | undefined): number {
  const clock = now ?? Date.now;

  if (typeof clock !== "function") {
    throw new Error("now must be a function.");
  }

  return normalizeTimestamp(clock(), "now()");
}

/**
 * Canonical Redis-backed floor controller used by Murmur agents.
 */
export class FloorController {
  private readonly floorStateKey: string;

  private readonly logger: FloorControllerLogger;

  private readonly mutedAgentsKey: string;

  private readonly now: () => number;

  private readonly roomId: string;

  private readonly roomSilenceKey: string;

  /**
   * Creates a floor controller scoped to one Murmur room.
   *
   * @param redis - Redis client used for atomic floor and agent-state commands.
   * @param roomId - Room identifier whose floor state should be managed.
   * @param options - Optional deterministic hooks for tests and orchestration.
   */
  public constructor(
    private readonly redis: FloorRedisClient,
    roomId: string,
    options: FloorControllerOptions = {},
  ) {
    if (!redis || typeof redis !== "object") {
      throw new Error("redis must be a Redis client object.");
    }

    this.roomId = normalizeRequiredText(roomId, "roomId");
    this.floorStateKey = getFloorStateKey(this.roomId);
    this.mutedAgentsKey = getMutedAgentsKey(this.roomId);
    this.roomSilenceKey = getRoomSilenceKey(this.roomId);
    this.logger = options.logger ?? defaultFloorControllerLogger;
    this.now = options.now ?? Date.now;
  }

  /**
   * Attempts to atomically grant the floor to the specified agent.
   *
   * Muted-agent membership and floor occupancy are checked in one Redis script
   * so claim evaluation cannot race with admin mute changes.
   *
   * @param agentId - Agent identifier attempting to claim the floor.
   * @returns `true` when the claim succeeds, otherwise `false`.
   */
  public async claimFloor(agentId: string): Promise<boolean> {
    const normalizedAgentId = normalizeRequiredText(agentId, "agentId");
    const claimResult = parseClaimFloorResult(
      await this.redis.eval(
        FLOOR_CLAIM_LUA,
        2,
        this.floorStateKey,
        this.mutedAgentsKey,
        normalizedAgentId,
        String(getCurrentTimestamp(this.now)),
      ),
    );

    if (claimResult === "muted") {
      this.logger.info(
        {
          agentId: normalizedAgentId,
          roomId: this.roomId,
        },
        "Rejected floor claim for muted agent.",
      );

      return false;
    }

    const claimed = claimResult === "claimed";

    this.logger.info(
      {
        agentId: normalizedAgentId,
        claimed,
        roomId: this.roomId,
      },
      claimed ? "Agent claimed floor." : "Floor claim rejected because the floor is occupied.",
    );

    return claimed;
  }

  /**
   * Releases the floor only when the requesting agent is the current holder.
   *
   * @param agentId - Agent identifier attempting to release the floor.
   * @returns `true` when the release succeeds, otherwise `false`.
   */
  public async releaseFloor(agentId: string): Promise<boolean> {
    const normalizedAgentId = normalizeRequiredText(agentId, "agentId");
    const released = parseRedisBoolean(
      await this.redis.eval(
        FLOOR_RELEASE_LUA,
        1,
        this.floorStateKey,
        normalizedAgentId,
      ),
      "releaseFloor",
    );

    this.logger.info(
      {
        agentId: normalizedAgentId,
        released,
        roomId: this.roomId,
      },
      released
        ? "Agent released floor."
        : "Floor release rejected because the agent does not hold the floor.",
    );

    return released;
  }

  /**
   * Reads the current floor holder for the room.
   *
   * @returns The current holder's agent ID, or `null` when the floor is empty.
   */
  public async getCurrentHolder(): Promise<string | null> {
    const floorState = await this.getFloorState();

    return floorState.currentHolder;
  }

  /**
   * Reads the canonical floor state for the room, including active silence
   * tracking derived from Redis.
   *
   * @returns The validated floor state for the room.
   */
  public async getFloorState(): Promise<FloorState> {
    return await this.readFloorState();
  }

  /**
   * Checks whether an agent is currently muted for this room.
   *
   * @param agentId - Agent identifier whose mute state should be checked.
   * @returns `true` when the agent is muted, otherwise `false`.
   */
  public async isAgentMuted(agentId: string): Promise<boolean> {
    const normalizedAgentId = normalizeRequiredText(agentId, "agentId");

    return parseRedisBoolean(
      await this.redis.sismember(this.mutedAgentsKey, normalizedAgentId),
      "isAgentMuted",
    );
  }

  /**
   * Reads the persisted last-spoke timestamp for an agent in this room.
   *
   * @param agentId - Agent identifier whose last-spoke timestamp should be read.
   * @returns The stored timestamp, or `null` when no speech has been recorded.
   */
  public async getAgentLastSpoke(agentId: string): Promise<number | null> {
    const normalizedAgentId = normalizeRequiredText(agentId, "agentId");
    const persistedTimestamp = await this.redis.get(
      getAgentLastSpokeKey(this.roomId, normalizedAgentId),
    );

    if (persistedTimestamp === null) {
      return null;
    }

    return parseStoredTimestamp(
      persistedTimestamp,
      `last-spoke timestamp for agent "${normalizedAgentId}"`,
    );
  }

  /**
   * Persists the most recent speaking timestamp for an agent in this room.
   *
   * @param agentId - Agent identifier whose timestamp should be updated.
   * @param timestamp - Epoch-millisecond timestamp to persist.
   */
  public async setAgentLastSpoke(
    agentId: string,
    timestamp: number,
  ): Promise<void> {
    const normalizedAgentId = normalizeRequiredText(agentId, "agentId");
    const normalizedTimestamp = normalizeTimestamp(timestamp, "timestamp");

    await this.redis.set(
      getAgentLastSpokeKey(this.roomId, normalizedAgentId),
      String(normalizedTimestamp),
    );

    this.logger.debug(
      {
        agentId: normalizedAgentId,
        roomId: this.roomId,
        timestamp: normalizedTimestamp,
      },
      "Persisted agent last-spoke timestamp.",
    );
  }

  /**
   * Persists the start of an empty-floor silence window for the room.
   *
   * @param timestamp - Epoch-millisecond timestamp marking when silence began.
   */
  public async setSilenceStart(timestamp: number): Promise<void> {
    const normalizedTimestamp = normalizeTimestamp(timestamp, "timestamp");

    await this.redis.set(this.roomSilenceKey, String(normalizedTimestamp));

    this.logger.debug(
      {
        roomId: this.roomId,
        timestamp: normalizedTimestamp,
      },
      "Persisted room silence-start timestamp.",
    );
  }

  /**
   * Clears any persisted empty-floor silence window for the room.
   */
  public async clearSilenceStart(): Promise<void> {
    await this.redis.del(this.roomSilenceKey);

    this.logger.debug(
      {
        roomId: this.roomId,
      },
      "Cleared room silence-start timestamp.",
    );
  }

  /**
   * Reads and validates the room's floor hash from Redis.
   *
   * Both `holder` and `claimedAt` must either exist together or be absent
   * together. Half-written floor hashes are treated as fatal state corruption so
   * the caller can surface the issue explicitly.
   *
   * @returns The canonical floor state for the room.
   */
  private async readFloorState(): Promise<FloorState> {
    const [floorHash, persistedSilenceStart] = await Promise.all([
      this.redis.hgetall(this.floorStateKey),
      this.redis.get(this.roomSilenceKey),
    ]);

    if (!floorHash || typeof floorHash !== "object") {
      throw new Error("Redis floor state must resolve to an object.");
    }

    const holder = floorHash.holder;
    const claimedAt = floorHash.claimedAt;

    if (holder === undefined && claimedAt === undefined) {
      return {
        roomId: this.roomId,
        currentHolder: null,
        claimedAt: null,
        lastSilenceStart:
          persistedSilenceStart === null
            ? null
            : parseStoredTimestamp(
              persistedSilenceStart,
              `room silence timestamp for room "${this.roomId}"`,
            ),
      };
    }

    if (holder === undefined || claimedAt === undefined) {
      throw new Error(
        `Redis floor state for room "${this.roomId}" is inconsistent. Both "holder" and "claimedAt" must be present together.`,
      );
    }

    return {
      roomId: this.roomId,
      currentHolder: normalizeRequiredText(holder, "floorState.holder"),
      claimedAt: parseStoredTimestamp(
        claimedAt,
        `floor claimedAt for room "${this.roomId}"`,
      ),
      lastSilenceStart:
        persistedSilenceStart === null
          ? null
          : parseStoredTimestamp(
            persistedSilenceStart,
            `room silence timestamp for room "${this.roomId}"`,
          ),
    };
  }
}

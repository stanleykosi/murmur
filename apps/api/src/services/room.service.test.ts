/**
 * Unit tests for room-service business rules that do not require live I/O.
 *
 * These tests pin the canonical room-assignment validation and Redis-key
 * format used by the room CRUD and listener membership flows.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const REQUIRED_API_ENV = {
  CENTRIFUGO_API_KEY: "centrifugo_api_key",
  CENTRIFUGO_API_URL: "http://centrifugo.internal:8000",
  CENTRIFUGO_TOKEN_SECRET: "centrifugo_token_secret",
  CLERK_SECRET_KEY: "sk_test_clerk_secret",
  DATABASE_URL: "postgresql://postgres:secret@example.com:5432/postgres",
  LIVEKIT_API_KEY: "livekit_api_key",
  LIVEKIT_API_SECRET: "livekit_api_secret",
  REDIS_URL: "redis://default:secret@example.com:6379",
  SENTRY_DSN: "https://public@example.ingest.sentry.io/12345",
} as const;

type RoomServiceModule = typeof import("./room.service.js");

let roomServiceModule: RoomServiceModule;
const originalEnv = { ...process.env };

/**
 * Restores the process environment after the tests complete.
 */
function restoreEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }

  Object.assign(process.env, originalEnv);
}

beforeAll(async () => {
  Object.assign(process.env, REQUIRED_API_ENV, {
    NODE_ENV: "test",
  });

  vi.resetModules();
  roomServiceModule = await import("./room.service.js");
});

afterAll(async () => {
  const [{ closeDatabasePool }, { closeRedis }] = await Promise.all([
    import("../db/client.js"),
    import("../lib/redis.js"),
  ]);

  await Promise.allSettled([closeDatabasePool(), closeRedis()]);

  restoreEnvironment();
  vi.resetModules();
});

describe("buildRoomListenersKey", () => {
  /**
   * Verifies listener presence always uses the canonical Redis namespace.
   */
  it("builds the room listener Redis key", () => {
    expect(
      roomServiceModule.buildRoomListenersKey(
        "  8d2e1f5c-1d17-4db4-a42d-f62c20ca2c55  ",
      ),
    ).toBe("room:8d2e1f5c-1d17-4db4-a42d-f62c20ca2c55:listeners");
  });

  /**
   * Rejects blank room IDs instead of silently creating malformed Redis keys.
   */
  it("throws for blank room ids", () => {
    expect(() => roomServiceModule.buildRoomListenersKey("   ")).toThrow(
      /roomId must be a non-empty string/i,
    );
  });
});

describe("assertValidRoomAssignments", () => {
  /**
   * Accepts the canonical MVP structure of one host plus one or two
   * participants.
   */
  it("accepts a valid 3-agent room assignment", () => {
    expect(() =>
      roomServiceModule.assertValidRoomAssignments([
        {
          agentId: "agent-1",
          role: "host",
        },
        {
          agentId: "agent-2",
          role: "participant",
        },
        {
          agentId: "agent-3",
          role: "participant",
        },
      ]),
    ).not.toThrow();
  });

  /**
   * Prevents duplicate agent IDs from being assigned multiple roles in the
   * same room.
   */
  it("rejects duplicate agent assignments", () => {
    expect(() =>
      roomServiceModule.assertValidRoomAssignments([
        {
          agentId: "agent-1",
          role: "host",
        },
        {
          agentId: "agent-1",
          role: "participant",
        },
      ]),
    ).toThrow(/must not contain duplicate agents/i);
  });

  /**
   * Requires exactly one host so room-stage ordering and dead-air recovery have
   * a single authoritative host agent.
   */
  it("rejects assignments without exactly one host", () => {
    expect(() =>
      roomServiceModule.assertValidRoomAssignments([
        {
          agentId: "agent-1",
          role: "participant",
        },
        {
          agentId: "agent-2",
          role: "participant",
        },
      ]),
    ).toThrow(/exactly one host/i);
  });

  /**
   * Enforces the MVP room-size constraint of 2-3 assigned agents.
   */
  it("rejects room sizes outside the supported range", () => {
    expect(() =>
      roomServiceModule.assertValidRoomAssignments([
        {
          agentId: "agent-1",
          role: "host",
        },
      ]),
    ).toThrow(/between 2 and 3 agents/i);
  });
});

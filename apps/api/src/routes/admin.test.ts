/**
 * Route-contract tests for the Murmur admin endpoints.
 *
 * These tests verify authorization wiring, room lifecycle controls, and Redis/
 * transport side effects without depending on live infrastructure.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const REQUIRED_API_ENV = {
  CORS_ALLOWED_ORIGINS: "http://localhost:3000,https://app.example.com",
  CENTRIFUGO_API_KEY: "centrifugo_api_key",
  CENTRIFUGO_API_URL: "http://centrifugo.internal:8000",
  CENTRIFUGO_TOKEN_SECRET: "centrifugo_token_secret",
  CLERK_SECRET_KEY: "sk_test_clerk_secret",
  CLERK_WEBHOOK_SECRET: "whsec_test_secret",
  DATABASE_URL: "postgresql://postgres:secret@example.com:5432/postgres",
  LIVEKIT_API_KEY: "livekit_api_key",
  LIVEKIT_API_SECRET: "livekit_api_secret",
  LIVEKIT_URL: "https://murmur-test.livekit.cloud",
  REDIS_URL: "redis://default:secret@example.com:6379",
  SENTRY_DSN: "https://public@example.ingest.sentry.io/12345",
} as const;

const authContext = {
  userId: "clerk_user_admin",
  userRole: "admin" as const,
};

const listAdminRoomsMock = vi.fn();
const getRoomByIdMock = vi.fn();
const endRoomMock = vi.fn();
const deleteRoomMock = vi.fn();
const publishRoomEndedMock = vi.fn();
const redisSaddMock = vi.fn();
const redisSremMock = vi.fn();
const redisDelMock = vi.fn();

vi.mock("../middleware/auth.js", () => ({
  authPreHandler: async (request: {
    userId: string | null;
    userRole: "admin" | "listener" | null;
  }) => {
    request.userId = authContext.userId;
    request.userRole = authContext.userRole;
  },
  registerAuthDecorators: (app: {
    decorateRequest: (property: string | symbol, value?: unknown) => unknown;
    hasRequestDecorator: (property: string | symbol) => boolean;
  }) => {
    if (!app.hasRequestDecorator("userId")) {
      app.decorateRequest("userId", null);
    }

    if (!app.hasRequestDecorator("userRole")) {
      app.decorateRequest("userRole", null);
    }
  },
}));

vi.mock("../services/room.service.js", () => ({
  endRoom: endRoomMock,
  getRoomById: getRoomByIdMock,
  listAdminRooms: listAdminRoomsMock,
}));

vi.mock("../services/livekit.service.js", () => ({
  deleteRoom: deleteRoomMock,
}));

vi.mock("../services/centrifugo.service.js", () => ({
  publishRoomEnded: publishRoomEndedMock,
}));

vi.mock("../lib/redis.js", () => ({
  closeRedis: async () => undefined,
  connectRedis: async () => undefined,
  pingRedis: async () => undefined,
  redis: {
    del: redisDelMock,
    sadd: redisSaddMock,
    srem: redisSremMock,
  },
}));

type ServerModule = typeof import("../server.js");

let buildServer: ServerModule["buildServer"];
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

/**
 * Creates a representative room payload returned by the room service.
 *
 * @param status - Room lifecycle status for the fixture.
 * @param listenerCount - Listener count to embed in the fixture.
 * @returns A deterministic room fixture for admin route tests.
 */
function createRoomFixture(
  status: "live" | "ended" = "live",
  listenerCount = 12,
) {
  return {
    agents: [
      {
        accentColor: "#00D4FF",
        avatarUrl: "/agents/nova.png",
        id: "05f69d1e-bfac-4a45-97e5-7e765a823f4c",
        name: "Nova",
        role: "host" as const,
      },
      {
        accentColor: "#FF6B35",
        avatarUrl: "/agents/rex.png",
        id: "9353f880-3777-4cc2-9d34-13c5cd82d53d",
        name: "Rex",
        role: "participant" as const,
      },
    ],
    createdAt: "2026-03-25T12:00:00.000Z",
    createdBy: "user-123",
    endedAt: status === "ended" ? "2026-03-25T12:30:00.000Z" : null,
    format: "moderated" as const,
    id: "8d2e1f5c-1d17-4db4-a42d-f62c20ca2c55",
    listenerCount,
    status,
    title: "Is AGI 5 Years Away?",
    topic: "Debating the timeline and implications of artificial general intelligence",
  };
}

/**
 * Creates the admin-room fixture returned by the room-list endpoint, including
 * per-agent muted state derived from Redis.
 *
 * @param status - Room lifecycle status for the fixture.
 * @param listenerCount - Listener count to embed in the fixture.
 * @param mutedAgentIds - Agent IDs that should be marked muted in the fixture.
 * @returns A deterministic admin room fixture for room-list tests.
 */
function createAdminRoomFixture(
  status: "live" | "ended" = "live",
  listenerCount = 12,
  mutedAgentIds: ReadonlyArray<string> = [],
) {
  const room = createRoomFixture(status, listenerCount);
  const mutedSet = new Set(mutedAgentIds);

  return {
    ...room,
    agents: room.agents.map((agent) => ({
      ...agent,
      muted: mutedSet.has(agent.id),
    })),
  };
}

beforeAll(async () => {
  Object.assign(process.env, REQUIRED_API_ENV, {
    NODE_ENV: "test",
  });

  vi.resetModules();
  ({ buildServer } = await import("../server.js"));
});

afterAll(async () => {
  const [{ closeDatabasePool }] = await Promise.all([
    import("../db/client.js"),
  ]);

  await Promise.allSettled([closeDatabasePool()]);

  restoreEnvironment();
  vi.resetModules();
});

beforeEach(() => {
  authContext.userId = "clerk_user_admin";
  authContext.userRole = "admin";

  deleteRoomMock.mockReset();
  endRoomMock.mockReset();
  getRoomByIdMock.mockReset();
  listAdminRoomsMock.mockReset();
  publishRoomEndedMock.mockReset();
  redisDelMock.mockReset();
  redisSaddMock.mockReset();
  redisSremMock.mockReset();
});

describe("adminRoutes", () => {
  /**
   * Verifies admin-only room listing delegates to the room service.
   */
  it("lists all rooms for an admin", async () => {
    const app = buildServer();
    const liveRoom = createAdminRoomFixture("live", 12, [
      "9353f880-3777-4cc2-9d34-13c5cd82d53d",
    ]);
    const endedRoom = createAdminRoomFixture("ended", 0);

    listAdminRoomsMock.mockResolvedValue([liveRoom, endedRoom]);

    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/rooms",
    });

    expect(response.statusCode).toBe(200);
    expect(listAdminRoomsMock).toHaveBeenCalledTimes(1);
    expect(response.json()).toEqual({
      rooms: [liveRoom, endedRoom],
    });

    await app.close();
  });

  /**
   * Non-admin callers are rejected before the room service is touched.
   */
  it("rejects non-admin callers", async () => {
    const app = buildServer();

    authContext.userRole = "listener";

    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/rooms",
    });

    expect(response.statusCode).toBe(403);
    expect(listAdminRoomsMock).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      error: {
        code: "forbidden",
      },
    });

    await app.close();
  });

  /**
   * Muting an assigned agent updates Redis and returns whether the set changed.
   */
  it("mutes an assigned live-room agent", async () => {
    const app = buildServer();
    const room = createRoomFixture("live");

    getRoomByIdMock.mockResolvedValue(room);
    redisSaddMock.mockResolvedValue(1);

    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/rooms/${room.id}/agents/${room.agents[0].id}/mute`,
    });

    expect(response.statusCode).toBe(200);
    expect(getRoomByIdMock).toHaveBeenCalledWith(room.id);
    expect(redisSaddMock).toHaveBeenCalledWith(
      `room:${room.id}:muted`,
      room.agents[0].id,
    );
    expect(response.json()).toEqual({
      agentId: room.agents[0].id,
      changed: true,
      muted: true,
      roomId: room.id,
    });

    await app.close();
  });

  /**
   * Unmute calls remain idempotent when the agent was not muted in Redis.
   */
  it("returns changed=false when unmuting an already-unmuted agent", async () => {
    const app = buildServer();
    const room = createRoomFixture("live");

    getRoomByIdMock.mockResolvedValue(room);
    redisSremMock.mockResolvedValue(0);

    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/rooms/${room.id}/agents/${room.agents[1].id}/unmute`,
    });

    expect(response.statusCode).toBe(200);
    expect(redisSremMock).toHaveBeenCalledWith(
      `room:${room.id}:muted`,
      room.agents[1].id,
    );
    expect(response.json()).toEqual({
      agentId: room.agents[1].id,
      changed: false,
      muted: false,
      roomId: room.id,
    });

    await app.close();
  });

  /**
   * Mute controls fail fast when the room is no longer live.
   */
  it("rejects mute controls for non-live rooms", async () => {
    const app = buildServer();
    const room = createRoomFixture("ended", 0);

    getRoomByIdMock.mockResolvedValue(room);

    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/rooms/${room.id}/agents/${room.agents[0].id}/mute`,
    });

    expect(response.statusCode).toBe(400);
    expect(redisSaddMock).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      error: {
        code: "validation_error",
      },
    });

    await app.close();
  });

  /**
   * Ending a room persists the end state, clears runtime keys, tears down
   * LiveKit, and broadcasts a `room_ended` event before responding.
   */
  it("ends a room and performs the full teardown flow", async () => {
    const app = buildServer();
    const endedRoom = createRoomFixture("ended", 7);
    const refreshedRoom = {
      ...endedRoom,
      listenerCount: 0,
    };

    endRoomMock.mockResolvedValue({
      alreadyEnded: false,
      room: endedRoom,
    });
    getRoomByIdMock.mockResolvedValue(refreshedRoom);
    redisDelMock.mockResolvedValue(6);
    deleteRoomMock.mockResolvedValue(undefined);
    publishRoomEndedMock.mockResolvedValue({
      endedAt: "2026-03-25T12:30:00.000Z",
      roomId: endedRoom.id,
      type: "room_ended",
    });

    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/rooms/${endedRoom.id}/end`,
    });

    expect(response.statusCode).toBe(200);
    expect(endRoomMock).toHaveBeenCalledWith(endedRoom.id);
    expect(redisDelMock).toHaveBeenCalledWith(
      `room:${endedRoom.id}:listeners`,
      `room:${endedRoom.id}:muted`,
      `floor:${endedRoom.id}`,
      `room:${endedRoom.id}:silence`,
      `room:${endedRoom.id}:agent:${endedRoom.agents[0].id}:lastSpoke`,
      `room:${endedRoom.id}:agent:${endedRoom.agents[1].id}:lastSpoke`,
    );
    expect(deleteRoomMock).toHaveBeenCalledWith(endedRoom.id);
    expect(publishRoomEndedMock).toHaveBeenCalledWith(endedRoom.id);
    expect(getRoomByIdMock).toHaveBeenCalledWith(endedRoom.id);
    expect(response.json()).toEqual({
      alreadyEnded: false,
      room: refreshedRoom,
    });

    await app.close();
  });

  /**
   * LiveKit teardown failures must not suppress the room-ended notification.
   */
  it("still publishes room_ended when LiveKit teardown fails", async () => {
    const app = buildServer();
    const endedRoom = createRoomFixture("ended", 7);

    endRoomMock.mockResolvedValue({
      alreadyEnded: false,
      room: endedRoom,
    });
    redisDelMock.mockResolvedValue(6);
    deleteRoomMock.mockRejectedValue(new Error("LiveKit admin API timeout"));
    publishRoomEndedMock.mockResolvedValue({
      endedAt: "2026-03-25T12:30:00.000Z",
      roomId: endedRoom.id,
      type: "room_ended",
    });

    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/rooms/${endedRoom.id}/end`,
    });

    expect(response.statusCode).toBe(500);
    expect(deleteRoomMock).toHaveBeenCalledWith(endedRoom.id);
    expect(publishRoomEndedMock).toHaveBeenCalledWith(endedRoom.id);
    expect(getRoomByIdMock).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      error: {
        code: "room_end_cleanup_failed",
        message:
          "Room ended and listeners were notified, but LiveKit teardown failed. Retry the end-room request to finish cleanup.",
      },
    });

    await app.close();
  });
});

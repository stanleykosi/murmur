/**
 * Route-contract tests for the Murmur room endpoints.
 *
 * These tests verify request validation, auth wiring, and route-to-service
 * delegation without depending on a live PostgreSQL or Redis instance.
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
  userId: "clerk_user_test",
  userRole: "admin" as const,
};

const listRoomsMock = vi.fn();
const getRoomByIdMock = vi.fn();
const createRoomMock = vi.fn();
const endRoomMock = vi.fn();
const joinRoomMock = vi.fn();
const leaveRoomMock = vi.fn();
const createListenerTokenMock = vi.fn();
const createClientTokenMock = vi.fn();
const deleteLiveKitRoomMock = vi.fn();
const publishRoomEndedMock = vi.fn();

vi.mock("../middleware/auth.js", () => ({
  authPreHandler: async (request: { userId: string | null; userRole: "admin" | "listener" | null }) => {
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
  createRoom: createRoomMock,
  endRoom: endRoomMock,
  getRoomById: getRoomByIdMock,
  joinRoom: joinRoomMock,
  leaveRoom: leaveRoomMock,
  listRooms: listRoomsMock,
}));

vi.mock("../services/livekit.service.js", () => ({
  createListenerToken: createListenerTokenMock,
  deleteRoom: deleteLiveKitRoomMock,
}));

vi.mock("../services/centrifugo.service.js", () => ({
  createClientToken: createClientTokenMock,
  publishRoomEnded: publishRoomEndedMock,
}));

type ServerModule = typeof import("../server.js");

let buildServer: ServerModule["buildServer"];
const originalEnv = { ...process.env };

/**
 * Restores the process environment to its original state once the test file
 * finishes so API config does not leak across test boundaries.
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
 * Creates a representative room payload used by the route responses.
 *
 * @returns A deterministic room fixture.
 */
function createRoomFixture() {
  return {
    agents: [
      {
        accentColor: "#00D4FF",
        avatarUrl: "/agents/nova.png",
        id: "agent-nova",
        name: "Nova",
        role: "host" as const,
      },
      {
        accentColor: "#FF6B35",
        avatarUrl: "/agents/rex.png",
        id: "agent-rex",
        name: "Rex",
        role: "participant" as const,
      },
    ],
    createdAt: "2026-03-25T12:00:00.000Z",
    createdBy: "user-123",
    endedAt: null,
    format: "moderated" as const,
    id: "8d2e1f5c-1d17-4db4-a42d-f62c20ca2c55",
    listenerCount: 12,
    status: "live" as const,
    title: "Is AGI 5 Years Away?",
    topic: "Debating the timeline and implications of artificial general intelligence",
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
  const [{ closeDatabasePool }, { closeRedis }] = await Promise.all([
    import("../db/client.js"),
    import("../lib/redis.js"),
  ]);

  await Promise.allSettled([closeDatabasePool(), closeRedis()]);

  restoreEnvironment();
  vi.resetModules();
});

beforeEach(() => {
  authContext.userId = "clerk_user_test";
  authContext.userRole = "admin";

  listRoomsMock.mockReset();
  getRoomByIdMock.mockReset();
  createRoomMock.mockReset();
  endRoomMock.mockReset();
  joinRoomMock.mockReset();
  leaveRoomMock.mockReset();
  createListenerTokenMock.mockReset();
  createClientTokenMock.mockReset();
  deleteLiveKitRoomMock.mockReset();
  publishRoomEndedMock.mockReset();
});

describe("roomsRoutes", () => {
  /**
   * Confirms the public room-list endpoint forwards the optional status filter
   * to the service and returns the service payload unchanged.
   */
  it("lists rooms with an optional status filter", async () => {
    const fixture = createRoomFixture();
    const app = buildServer();

    listRoomsMock.mockResolvedValue([fixture]);

    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/rooms?status=live",
    });

    expect(response.statusCode).toBe(200);
    expect(listRoomsMock).toHaveBeenCalledWith("live");
    expect(response.json()).toEqual({
      rooms: [fixture],
    });

    await app.close();
  });

  /**
   * Rejects unsupported room-status query values before the service is called.
   */
  it("returns a validation error for an unsupported status filter", async () => {
    const app = buildServer();

    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/rooms?status=archived",
    });

    expect(response.statusCode).toBe(400);
    expect(listRoomsMock).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: "Invalid room list query parameters.",
      },
    });

    await app.close();
  });

  /**
   * Verifies the room-detail route validates the room ID and delegates the
   * lookup to the service.
   */
  it("loads a room by id", async () => {
    const fixture = createRoomFixture();
    const app = buildServer();

    getRoomByIdMock.mockResolvedValue(fixture);

    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: `/api/rooms/${fixture.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(getRoomByIdMock).toHaveBeenCalledWith(fixture.id);
    expect(response.json()).toEqual({
      room: fixture,
    });

    await app.close();
  });

  /**
   * Confirms admins can create rooms and that the route injects the Clerk user
   * ID from the auth middleware into the service payload.
   */
  it("creates a room for an authenticated admin", async () => {
    const fixture = createRoomFixture();
    const app = buildServer();

    createRoomMock.mockResolvedValue(fixture);

    await app.ready();

    const response = await app.inject({
      method: "POST",
      payload: {
        agents: [
          {
            agentId: "05f69d1e-bfac-4a45-97e5-7e765a823f4c",
            role: "host",
          },
          {
            agentId: "9353f880-3777-4cc2-9d34-13c5cd82d53d",
            role: "participant",
          },
        ],
        format: "moderated",
        title: "Future of Work",
        topic: "How AI will change remote work norms",
      },
      url: "/api/rooms",
    });

    expect(response.statusCode).toBe(200);
    expect(createRoomMock).toHaveBeenCalledWith({
      agents: [
        {
          agentId: "05f69d1e-bfac-4a45-97e5-7e765a823f4c",
          role: "host",
        },
        {
          agentId: "9353f880-3777-4cc2-9d34-13c5cd82d53d",
          role: "participant",
        },
      ],
      createdByClerkUserId: authContext.userId,
      format: "moderated",
      status: "live",
      title: "Future of Work",
      topic: "How AI will change remote work norms",
    });
    expect(response.json()).toEqual({
      room: fixture,
    });

    await app.close();
  });

  /**
   * Ensures the join route uses the authenticated Clerk user ID rather than
   * trusting any client-supplied identifier.
   */
  it("joins a room for the authenticated caller", async () => {
    const fixture = createRoomFixture();
    const app = buildServer();
    const listenerUserId = "4b4b92d1-7f55-4d5d-95f4-48da7a6fd6f5";

    joinRoomMock.mockResolvedValue({
      listenerUserId,
      presenceAdded: true,
      room: fixture,
    });
    createListenerTokenMock.mockResolvedValue("livekit-token");
    createClientTokenMock.mockReturnValue("centrifugo-token");

    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/api/rooms/${fixture.id}/join`,
    });

    expect(response.statusCode).toBe(200);
    expect(joinRoomMock).toHaveBeenCalledWith(fixture.id, authContext.userId);
    expect(createListenerTokenMock).toHaveBeenCalledWith(fixture.id, listenerUserId);
    expect(createClientTokenMock).toHaveBeenCalledWith(listenerUserId);
    expect(response.json()).toEqual({
      agents: fixture.agents,
      centrifugoToken: "centrifugo-token",
      livekitToken: "livekit-token",
      room: fixture,
    });

    await app.close();
  });

  /**
   * Ensures token-generation failures do not leave behind a newly-created room
   * presence entry that would inflate listener counts.
   */
  it("rolls back a newly created join when token generation fails", async () => {
    const fixture = createRoomFixture();
    const app = buildServer();
    const listenerUserId = "4b4b92d1-7f55-4d5d-95f4-48da7a6fd6f5";

    joinRoomMock.mockResolvedValue({
      listenerUserId,
      presenceAdded: true,
      room: fixture,
    });
    createListenerTokenMock.mockRejectedValue(
      new Error("LiveKit token service is unavailable."),
    );

    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/api/rooms/${fixture.id}/join`,
    });

    expect(response.statusCode).toBe(500);
    expect(leaveRoomMock).toHaveBeenCalledWith(fixture.id, authContext.userId);
    expect(response.json()).toMatchObject({
      error: {
        code: "internal_server_error",
        message: "Internal server error.",
        statusCode: 500,
      },
    });

    await app.close();
  });

  /**
   * Confirms the leave route returns the service result after validating the
   * room ID and authenticating the caller.
   */
  it("leaves a room for the authenticated caller", async () => {
    const fixture = createRoomFixture();
    const app = buildServer();

    leaveRoomMock.mockResolvedValue({
      listenerCount: 11,
      roomId: fixture.id,
    });

    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/api/rooms/${fixture.id}/leave`,
    });

    expect(response.statusCode).toBe(200);
    expect(leaveRoomMock).toHaveBeenCalledWith(fixture.id, authContext.userId);
    expect(response.json()).toEqual({
      listenerCount: 11,
      roomId: fixture.id,
    });

    await app.close();
  });
});

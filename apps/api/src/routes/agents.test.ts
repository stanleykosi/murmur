/**
 * Route-contract tests for the Murmur agent endpoints.
 *
 * These tests verify public agent reads, request validation, and route-to-
 * service delegation without depending on a live database.
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

const listAgentsMock = vi.fn();
const getAgentByIdMock = vi.fn();

vi.mock("../middleware/auth.js", () => ({
  authPreHandler: async () => undefined,
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

vi.mock("../services/agent.service.js", () => ({
  getAgentById: getAgentByIdMock,
  listAgents: listAgentsMock,
}));

vi.mock("../lib/sentry.js", () => ({
  captureException: (error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  flushSentry: async () => true,
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
 * Creates a representative agent payload returned by the public agent routes.
 *
 * @returns A deterministic active agent fixture.
 */
function createAgentFixture() {
  return {
    accentColor: "#00D4FF",
    avatarUrl: "/agents/nova.png",
    createdAt: "2026-03-25T12:00:00.000Z",
    id: "05f69d1e-bfac-4a45-97e5-7e765a823f4c",
    isActive: true,
    name: "Nova",
    personality: "Curious and optimistic.",
    ttsProvider: "cartesia" as const,
    voiceId: "voice-nova",
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
  getAgentByIdMock.mockReset();
  listAgentsMock.mockReset();
});

describe("agentsRoutes", () => {
  /**
   * Confirms the public agent-list endpoint returns the active-agent catalog
   * exactly as supplied by the service layer.
   */
  it("lists active agents", async () => {
    const fixture = createAgentFixture();
    const app = buildServer();

    listAgentsMock.mockResolvedValue([fixture]);

    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/agents",
    });

    expect(response.statusCode).toBe(200);
    expect(listAgentsMock).toHaveBeenCalledTimes(1);
    expect(response.json()).toEqual({
      agents: [fixture],
    });

    await app.close();
  });

  /**
   * Applies the configured browser-origin allowlist to public API responses so
   * deployed frontends can call the API without relying on hardcoded domains.
   */
  it("adds CORS headers for configured frontend origins", async () => {
    const fixture = createAgentFixture();
    const app = buildServer();

    listAgentsMock.mockResolvedValue([fixture]);

    await app.ready();

    const response = await app.inject({
      headers: {
        origin: "https://app.example.com",
      },
      method: "GET",
      url: "/api/agents",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://app.example.com",
    );

    await app.close();
  });

  /**
   * Omits browser CORS headers for origins outside the configured allowlist.
   */
  it("does not add CORS headers for unconfigured origins", async () => {
    const fixture = createAgentFixture();
    const app = buildServer();

    listAgentsMock.mockResolvedValue([fixture]);

    await app.ready();

    const response = await app.inject({
      headers: {
        origin: "https://blocked.example.com",
      },
      method: "GET",
      url: "/api/agents",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();

    await app.close();
  });

  /**
   * Rejects malformed agent IDs before the agent service is called.
   */
  it("returns a validation error for an invalid agent id", async () => {
    const app = buildServer();

    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/agents/not-a-uuid",
    });

    expect(response.statusCode).toBe(400);
    expect(getAgentByIdMock).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: "Invalid agent id.",
      },
    });

    await app.close();
  });

  /**
   * Surfaces service-layer not-found errors for missing or inactive agents.
   */
  it("returns 404 when the requested active agent does not exist", async () => {
    const { NotFoundError } = await import("../lib/errors.js");
    const fixture = createAgentFixture();
    const app = buildServer();

    getAgentByIdMock.mockRejectedValue(
      new NotFoundError(`Active agent "${fixture.id}" was not found.`),
    );

    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: `/api/agents/${fixture.id}`,
    });

    expect(response.statusCode).toBe(404);
    expect(getAgentByIdMock).toHaveBeenCalledWith(fixture.id);
    expect(response.json()).toMatchObject({
      error: {
        code: "not_found",
      },
    });

    await app.close();
  });
});

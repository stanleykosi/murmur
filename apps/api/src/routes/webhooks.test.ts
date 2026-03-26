/**
 * Route-contract tests for the Clerk webhook endpoint.
 *
 * These tests verify signature handling and event dispatch without depending
 * on the real Clerk backend or PostgreSQL.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const REQUIRED_API_ENV = {
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

const verifyWebhookMock = vi.fn();
const upsertUserMock = vi.fn();
const deleteUserMock = vi.fn();

vi.mock("@clerk/backend/webhooks", () => ({
  verifyWebhook: verifyWebhookMock,
}));

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

vi.mock("../services/auth.service.js", () => ({
  deleteUser: deleteUserMock,
  upsertUser: upsertUserMock,
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
 * Shared webhook request headers used by the test inject calls.
 *
 * @returns The minimum SVIX-like headers required by the endpoint.
 */
function createWebhookHeaders() {
  return {
    "content-type": "application/json",
    "svix-id": "msg_test_123",
    "svix-signature": "v1,testsignature",
    "svix-timestamp": "1711363200",
  };
}

/**
 * Creates a representative Clerk user payload fixture.
 *
 * @returns A minimal Clerk webhook user payload used by the tests.
 */
function createClerkUserPayload() {
  return {
    email_addresses: [
      {
        email_address: "nova@example.com",
        id: "email_123",
      },
    ],
    first_name: "Nova",
    id: "user_123",
    image_url: "https://img.example.com/nova.png",
    last_name: "Prime",
    primary_email_address_id: "email_123",
    public_metadata: {
      role: "listener",
    },
    username: "nova-prime",
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
  deleteUserMock.mockReset();
  upsertUserMock.mockReset();
  verifyWebhookMock.mockReset();
});

describe("webhookRoutes", () => {
  /**
   * Verifies `user.created` events are dispatched into the upsert flow.
   */
  it("handles Clerk user.created events", async () => {
    const app = buildServer();
    const userPayload = createClerkUserPayload();

    verifyWebhookMock.mockResolvedValue({
      data: userPayload,
      type: "user.created",
    });

    await app.ready();

    const response = await app.inject({
      headers: createWebhookHeaders(),
      method: "POST",
      payload: JSON.stringify({
        object: "event",
      }),
      url: "/api/webhooks/clerk",
    });

    expect(response.statusCode).toBe(200);
    expect(verifyWebhookMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        signingSecret: REQUIRED_API_ENV.CLERK_WEBHOOK_SECRET,
      }),
    );
    expect(upsertUserMock).toHaveBeenCalledWith(userPayload);
    expect(response.json()).toEqual({
      handled: true,
      type: "user.created",
    });

    await app.close();
  });

  /**
   * Verifies `user.updated` events reuse the same upsert flow.
   */
  it("handles Clerk user.updated events", async () => {
    const app = buildServer();
    const userPayload = createClerkUserPayload();

    verifyWebhookMock.mockResolvedValue({
      data: userPayload,
      type: "user.updated",
    });

    await app.ready();

    const response = await app.inject({
      headers: createWebhookHeaders(),
      method: "POST",
      payload: JSON.stringify({
        object: "event",
      }),
      url: "/api/webhooks/clerk",
    });

    expect(response.statusCode).toBe(200);
    expect(upsertUserMock).toHaveBeenCalledWith(userPayload);
    expect(response.json()).toEqual({
      handled: true,
      type: "user.updated",
    });

    await app.close();
  });

  /**
   * Verifies `user.deleted` events dispatch into the delete flow.
   */
  it("handles Clerk user.deleted events", async () => {
    const app = buildServer();

    verifyWebhookMock.mockResolvedValue({
      data: {
        id: "user_123",
      },
      type: "user.deleted",
    });

    await app.ready();

    const response = await app.inject({
      headers: createWebhookHeaders(),
      method: "POST",
      payload: JSON.stringify({
        object: "event",
      }),
      url: "/api/webhooks/clerk",
    });

    expect(response.statusCode).toBe(200);
    expect(deleteUserMock).toHaveBeenCalledWith("user_123");
    expect(response.json()).toEqual({
      handled: true,
      type: "user.deleted",
    });

    await app.close();
  });

  /**
   * Invalid webhook signatures are surfaced as the API's canonical 401 error.
   */
  it("returns 401 when Clerk signature verification fails", async () => {
    const app = buildServer();

    verifyWebhookMock.mockRejectedValue(new Error("signature invalid"));

    await app.ready();

    const response = await app.inject({
      headers: createWebhookHeaders(),
      method: "POST",
      payload: JSON.stringify({
        object: "event",
      }),
      url: "/api/webhooks/clerk",
    });

    expect(response.statusCode).toBe(401);
    expect(upsertUserMock).not.toHaveBeenCalled();
    expect(deleteUserMock).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      error: {
        code: "unauthorized",
        message: "Invalid Clerk webhook signature.",
      },
    });

    await app.close();
  });

  /**
   * Unsupported event types are rejected so Clerk configuration drift is
   * surfaced immediately.
   */
  it("returns 400 for unsupported Clerk event types", async () => {
    const app = buildServer();

    verifyWebhookMock.mockResolvedValue({
      data: {
        id: "session_123",
      },
      type: "session.created",
    });

    await app.ready();

    const response = await app.inject({
      headers: createWebhookHeaders(),
      method: "POST",
      payload: JSON.stringify({
        object: "event",
      }),
      url: "/api/webhooks/clerk",
    });

    expect(response.statusCode).toBe(400);
    expect(upsertUserMock).not.toHaveBeenCalled();
    expect(deleteUserMock).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      error: {
        code: "validation_error",
      },
    });

    await app.close();
  });
});

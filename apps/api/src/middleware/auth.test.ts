/**
 * Unit tests for the Fastify authentication middleware.
 *
 * These tests focus on the canonical Murmur auth contract: Bearer-token
 * parsing, Clerk payload normalization, and request decoration updates after a
 * successful session-token verification.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const verifyTokenMock = vi.fn();

vi.mock("@clerk/backend", () => ({
  verifyToken: verifyTokenMock,
}));

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

type AuthModule = typeof import("./auth.js");

let authModule: AuthModule;
const originalEnv = { ...process.env };

/**
 * Restores the process environment to its pre-test state so the auth module
 * does not leak configuration into other test files.
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
  authModule = await import("./auth.js");
});

afterAll(() => {
  restoreEnvironment();
  vi.resetModules();
});

beforeEach(() => {
  verifyTokenMock.mockReset();
});

describe("extractBearerToken", () => {
  /**
   * Accepts a valid Bearer header and returns the token payload without extra
   * surrounding whitespace.
   */
  it("extracts the token from a valid Bearer header", () => {
    expect(authModule.extractBearerToken("Bearer   session-token   ")).toBe("session-token");
  });

  /**
   * Rejects malformed authorization headers instead of silently accepting an
   * ambiguous auth scheme.
   */
  it("throws when the Authorization header is malformed", () => {
    expect(() => authModule.extractBearerToken("Token abc123")).toThrow(/Bearer scheme/i);
  });
});

describe("normalizeAuthContext", () => {
  /**
   * Defaults to the listener role when the Clerk token does not include Murmur
   * role metadata.
   */
  it("defaults missing role metadata to listener", () => {
    expect(
      authModule.normalizeAuthContext({
        sub: " user_123 ",
      }),
    ).toEqual({
      userId: "user_123",
      userRole: "listener",
    });
  });

  /**
   * Rejects unsupported role claims so the API never proceeds with an unknown
   * authorization level.
   */
  it("throws when the role claim is not a supported Murmur role", () => {
    expect(() =>
      authModule.normalizeAuthContext({
        metadata: {
          role: "moderator",
        },
        sub: "user_123",
      }),
    ).toThrow(/not supported/);
  });
});

describe("authPreHandler", () => {
  /**
   * Persists the normalized Murmur auth context onto the Fastify request after
   * Clerk verifies the incoming session token.
   */
  it("attaches userId and userRole to the request after verification", async () => {
    verifyTokenMock.mockResolvedValue({
      metadata: {
        role: "admin",
      },
      sub: "user_abc",
    });

    const request = {
      headers: {
        authorization: "Bearer test-session-token",
      },
      userId: null,
      userRole: null,
    } as unknown as FastifyRequest;

    await authModule.authPreHandler(request, {} as FastifyReply);

    expect(verifyTokenMock).toHaveBeenCalledWith("test-session-token", {
      secretKey: REQUIRED_API_ENV.CLERK_SECRET_KEY,
    });
    expect(request.userId).toBe("user_abc");
    expect(request.userRole).toBe("admin");
  });

  /**
   * Converts Clerk verification failures into the API's canonical unauthorized
   * error so downstream routes see a stable failure mode.
   */
  it("throws UnauthorizedError when Clerk verification fails", async () => {
    verifyTokenMock.mockRejectedValue(new Error("signature invalid"));

    const request = {
      headers: {
        authorization: "Bearer test-session-token",
      },
      userId: null,
      userRole: null,
    } as unknown as FastifyRequest;

    await expect(
      authModule.authPreHandler(request, {} as FastifyReply),
    ).rejects.toThrow(/Invalid or expired authentication token/);
  });
});

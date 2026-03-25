/**
 * Unit tests for the LiveKit token helpers.
 *
 * These tests verify the canonical listener and agent grants so downstream
 * media connections use the exact permission model defined in the Murmur spec.
 */

import { TokenVerifier } from "livekit-server-sdk";
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

type LivekitServiceModule = typeof import("./livekit.service.js");

let livekitServiceModule: LivekitServiceModule;
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
  livekitServiceModule = await import("./livekit.service.js");
});

afterAll(async () => {
  restoreEnvironment();
  vi.resetModules();
});

describe("createListenerToken", () => {
  /**
   * Ensures listeners receive a strict subscribe-only grant set with a 24-hour
   * lifetime and the canonical `listener_{userId}` identity format.
   */
  it("creates a listener token with subscribe-only permissions", async () => {
    const token = await livekitServiceModule.createListenerToken(
      "room-123",
      "user-123",
    );
    const verifier = new TokenVerifier(
      REQUIRED_API_ENV.LIVEKIT_API_KEY,
      REQUIRED_API_ENV.LIVEKIT_API_SECRET,
    );
    const claims = await verifier.verify(token);

    expect(claims.sub).toBe("listener_user-123");
    expect(claims.video).toMatchObject({
      room: "room-123",
      roomJoin: true,
      canPublish: false,
      canPublishData: false,
      canSubscribe: true,
    });
    expect(typeof claims.exp).toBe("number");
    expect(claims.exp).toBeGreaterThanOrEqual(
      Math.floor(Date.now() / 1000) + 86_000,
    );
  });
});

describe("createAgentToken", () => {
  /**
   * Ensures agents receive publish-and-subscribe permissions with the canonical
   * `agent_{agentId}` identity format.
   */
  it("creates an agent token with publish permissions", async () => {
    const token = await livekitServiceModule.createAgentToken(
      "room-123",
      "agent-123",
    );
    const verifier = new TokenVerifier(
      REQUIRED_API_ENV.LIVEKIT_API_KEY,
      REQUIRED_API_ENV.LIVEKIT_API_SECRET,
    );
    const claims = await verifier.verify(token);

    expect(claims.sub).toBe("agent_agent-123");
    expect(claims.video).toMatchObject({
      room: "room-123",
      roomJoin: true,
      canPublish: true,
      canPublishData: true,
      canSubscribe: true,
    });
    expect(typeof claims.exp).toBe("number");
    expect(claims.exp).toBeGreaterThanOrEqual(
      Math.floor(Date.now() / 1000) + 86_000,
    );
  });
});

/**
 * Unit tests for the Centrifugo integration helpers.
 *
 * These tests verify client-token signing and the canonical transcript-channel
 * publish contract used by the Murmur API.
 */

import type { TranscriptEvent } from "@murmur/shared";
import jwt, { type JwtPayload } from "jsonwebtoken";
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

type CentrifugoServiceModule = typeof import("./centrifugo.service.js");

let centrifugoServiceModule: CentrifugoServiceModule;
let fetchMock: ReturnType<typeof vi.fn>;
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
 * Creates a representative transcript event payload for publish tests.
 *
 * @returns A deterministic transcript event fixture.
 */
function createTranscriptEventFixture(): TranscriptEvent {
  return {
    accentColor: "#00D4FF",
    agentId: "agent-123",
    agentName: "Nova",
    content: "We should define intelligence before arguing about AGI timelines.",
    id: "transcript-123",
    roomId: "room-123",
    timestamp: "2026-03-25T12:00:00.000Z",
    type: "transcript",
    wasFiltered: false,
  };
}

beforeAll(async () => {
  Object.assign(process.env, REQUIRED_API_ENV, {
    NODE_ENV: "test",
  });

  vi.resetModules();
  centrifugoServiceModule = await import("./centrifugo.service.js");
});

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  restoreEnvironment();
  vi.resetModules();
});

describe("createClientToken", () => {
  /**
   * Ensures Centrifugo tokens carry the canonical user ID in `sub` and expire
   * after 24 hours.
   */
  it("creates a signed client token with a 24-hour ttl", () => {
    const token = centrifugoServiceModule.createClientToken("user-123");
    const payload = jwt.verify(
      token,
      REQUIRED_API_ENV.CENTRIFUGO_TOKEN_SECRET,
    ) as JwtPayload;

    expect(payload.sub).toBe("user-123");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(payload.exp).toBe(payload.iat! + 86_400);
  });
});

describe("publishTranscript", () => {
  /**
   * Verifies transcript events are published to the canonical room transcript
   * channel with the expected Centrifugo API authorization header.
   */
  it("publishes transcript events to the room transcript channel", async () => {
    const event = createTranscriptEventFixture();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ result: {} }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    }));

    await centrifugoServiceModule.publishTranscript(event.roomId, event);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://centrifugo.internal:8000/api/publish",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "apikey centrifugo_api_key",
          "Content-Type": "application/json",
        },
      }),
    );

    const [, options] = fetchMock.mock.calls[0] ?? [];
    const payload = JSON.parse(String(options?.body)) as {
      channel: string;
      data: TranscriptEvent;
    };

    expect(payload).toEqual({
      channel: "room:room-123:transcript",
      data: event,
    });
  });

  /**
   * Fails fast when Centrifugo rejects a publish request instead of silently
   * pretending the transcript reached listeners.
   */
  it("throws when the Centrifugo publish endpoint rejects the request", async () => {
    fetchMock.mockResolvedValue(
      new Response("upstream unavailable", {
        status: 503,
      }),
    );

    await expect(
      centrifugoServiceModule.publishTranscript(
        "room-123",
        createTranscriptEventFixture(),
      ),
    ).rejects.toThrow(/Centrifugo rejected the publish request/i);
  });
});

describe("publishRoomEnded", () => {
  /**
   * Verifies room-ended broadcasts reuse the transcript channel so the live
   * room UI can receive lifecycle events on a single subscription.
   */
  it("publishes a room-ended event to the transcript channel", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ result: {} }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    }));

    const event = await centrifugoServiceModule.publishRoomEnded("room-123");

    const [, options] = fetchMock.mock.calls[0] ?? [];
    const payload = JSON.parse(String(options?.body)) as {
      channel: string;
      data: {
        endedAt: string;
        roomId: string;
        type: string;
      };
    };

    expect(payload.channel).toBe("room:room-123:transcript");
    expect(payload.data).toEqual(event);
    expect(event).toMatchObject({
      roomId: "room-123",
      type: "room_ended",
    });
  });
});

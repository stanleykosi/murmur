/**
 * Unit tests for the canonical database seed helpers.
 *
 * These tests validate the deterministic pieces of the seed flow without
 * requiring a live PostgreSQL instance, keeping the package test run fast and
 * reliable.
 */

import { describe, expect, it } from "vitest";

import {
  DEMO_ROOM_SEED,
  buildDemoRoomAssignments,
  parseSeedEnvironment,
} from "./seed.js";

describe("parseSeedEnvironment", () => {
  /**
   * Confirms the seed command only depends on PostgreSQL connectivity and
   * trims surrounding whitespace before returning the value.
   */
  it("accepts a valid DATABASE_URL without unrelated runtime secrets", () => {
    expect(
      parseSeedEnvironment({
        DATABASE_URL: "  postgresql://postgres:secret@example.com:5432/postgres  ",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      DATABASE_URL: "postgresql://postgres:secret@example.com:5432/postgres",
    });
  });

  /**
   * Ensures operators receive a focused error when the database URL is absent.
   */
  it("fails fast when DATABASE_URL is missing", () => {
    expect(() => parseSeedEnvironment({} as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL/,
    );
  });
});

describe("buildDemoRoomAssignments", () => {
  /**
   * Verifies the helper always makes Nova the host while leaving Rex and Sage
   * as participants in the canonical demo room.
   */
  it("creates the canonical assignment layout for the demo room", () => {
    expect(
      buildDemoRoomAssignments("room-1", [
        { id: "agent-nova", name: "Nova" },
        { id: "agent-rex", name: "Rex" },
        { id: "agent-sage", name: "Sage" },
      ]),
    ).toEqual([
      {
        agentId: "agent-nova",
        role: "host",
        roomId: "room-1",
      },
      {
        agentId: "agent-rex",
        role: "participant",
        roomId: "room-1",
      },
      {
        agentId: "agent-sage",
        role: "participant",
        roomId: "room-1",
      },
    ]);
  });

  /**
   * Ensures the seed flow stops instead of creating a partially configured demo
   * room when a required built-in agent failed to persist.
   */
  it("throws when a canonical house agent is missing", () => {
    expect(() =>
      buildDemoRoomAssignments("room-1", [
        { id: "agent-nova", name: "Nova" },
        { id: "agent-rex", name: "Rex" },
      ]),
    ).toThrow(/Sage/);
  });
});

describe("DEMO_ROOM_SEED", () => {
  /**
   * Pins the MVP demo-room metadata to the specification example used by the
   * lobby and join-flow API responses.
   */
  it("matches the canonical MVP demo room", () => {
    expect(DEMO_ROOM_SEED).toEqual({
      format: "moderated",
      status: "live",
      title: "Is AGI 5 Years Away?",
      topic: "Debating the timeline and implications of artificial general intelligence",
    });
  });
});

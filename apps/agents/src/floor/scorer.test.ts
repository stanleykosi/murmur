/**
 * Unit tests for the Murmur floor-priority scorer.
 *
 * These assertions pin the canonical engagement-debt and tie-breaking rules so
 * floor selection remains deterministic and fail-fast as orchestration logic
 * evolves.
 */

import {
  ENGAGEMENT_DEBT_CAP,
  HOST_ROLE_BONUS,
} from "@murmur/shared";
import { describe, expect, it } from "vitest";

import {
  computeScore,
  selectNextSpeaker,
  type SpeakerCandidate,
} from "./scorer.js";

/**
 * Creates a valid candidate fixture with optional overrides.
 *
 * @param overrides - Partial candidate overrides for one test case.
 * @returns A complete speaker candidate.
 */
function createCandidate(
  overrides: Partial<SpeakerCandidate> = {},
): SpeakerCandidate {
  return {
    id: overrides.id ?? "agent-nova",
    role: overrides.role ?? "participant",
    lastSpokeAt: overrides.lastSpokeAt === undefined ? 0 : overrides.lastSpokeAt,
  };
}

describe("computeScore", () => {
  it("returns engagement debt in seconds from the last-spoke timestamp", () => {
    const now = 20_000;
    const candidate = createCandidate({
      lastSpokeAt: 12_000,
    });

    expect(
      computeScore(candidate, {
        now: () => now,
      }),
    ).toBe(8);
  });

  it("applies the host role bonus exactly once", () => {
    const now = 30_000;
    const candidate = createCandidate({
      role: "host",
      lastSpokeAt: 25_000,
    });

    expect(
      computeScore(candidate, {
        now: () => now,
      }),
    ).toBe(5 + HOST_ROLE_BONUS);
  });

  it("caps engagement debt at the shared maximum", () => {
    const now = (ENGAGEMENT_DEBT_CAP + 120) * 1000;
    const candidate = createCandidate({
      lastSpokeAt: 0,
    });

    expect(
      computeScore(candidate, {
        now: () => now,
      }),
    ).toBe(ENGAGEMENT_DEBT_CAP);
  });

  it("gives agents that never spoke the full engagement-debt cap", () => {
    const candidate = createCandidate({
      lastSpokeAt: null,
    });

    expect(
      computeScore(candidate, {
        now: () => 42_000,
      }),
    ).toBe(ENGAGEMENT_DEBT_CAP);
  });

  it("clamps future-dated last-spoke timestamps to zero debt", () => {
    const now = 10_000;
    const candidate = createCandidate({
      lastSpokeAt: 12_000,
    });

    expect(
      computeScore(candidate, {
        now: () => now,
      }),
    ).toBe(0);
  });
});

describe("selectNextSpeaker", () => {
  it("returns null when no candidates are available", () => {
    expect(
      selectNextSpeaker([], {
        now: () => 10_000,
        random: () => 0,
      }),
    ).toBeNull();
  });

  it("returns the highest-scoring candidate", () => {
    const now = 70_000;
    const selected = selectNextSpeaker(
      [
        createCandidate({
          id: "agent-recent-host",
          role: "host",
          lastSpokeAt: 68_000,
        }),
        createCandidate({
          id: "agent-overdue-participant",
          role: "participant",
          lastSpokeAt: 20_000,
        }),
        createCandidate({
          id: "agent-fresh-participant",
          role: "participant",
          lastSpokeAt: 69_000,
        }),
      ],
      {
        now: () => now,
        random: () => 0,
      },
    );

    expect(selected?.id).toBe("agent-overdue-participant");
  });

  it("uses deterministic random tie-breaking only among tied candidates", () => {
    const now = 50_000;
    const selected = selectNextSpeaker(
      [
        createCandidate({
          id: "agent-a",
          lastSpokeAt: 30_000,
        }),
        createCandidate({
          id: "agent-b",
          lastSpokeAt: 30_000,
        }),
        createCandidate({
          id: "agent-c",
          lastSpokeAt: 45_000,
        }),
      ],
      {
        now: () => now,
        random: () => 0.75,
      },
    );

    expect(selected?.id).toBe("agent-b");
  });

  it("fails fast when duplicate candidate ids are provided", () => {
    expect(() =>
      selectNextSpeaker(
        [
          createCandidate({
            id: "duplicate-id",
            lastSpokeAt: 0,
          }),
          createCandidate({
            id: "duplicate-id",
            lastSpokeAt: 1_000,
          }),
        ],
        {
          now: () => 10_000,
          random: () => 0,
        },
      ),
    ).toThrowError(/duplicate id/i);
  });
});

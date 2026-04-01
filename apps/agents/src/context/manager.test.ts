/**
 * Unit tests for the Murmur rolling transcript context manager.
 *
 * These assertions pin the prompt-formatting and window-pruning behavior so
 * later graph nodes can depend on one deterministic context contract.
 */

import { describe, expect, it } from "vitest";

import {
  ContextManager,
  DEFAULT_CONTEXT_WINDOW_MS,
} from "./manager.js";

describe("ContextManager", () => {
  /**
   * A brand-new manager should expose no prompt context.
   */
  it("returns an empty string before any transcript entries are added", () => {
    const manager = new ContextManager();

    expect(manager.getContext()).toBe("");
  });

  /**
   * Verifies the manager retains only entries inside the rolling window and
   * formats them in chronological `[Agent]: content` order.
   */
  it("formats a pruned rolling window in chronological order", () => {
    let currentTime = DEFAULT_CONTEXT_WINDOW_MS + 30_000;
    const manager = new ContextManager({
      now: () => currentTime,
    });

    manager.addEntry({
      agentName: "Nova",
      content: "This one is too old to keep.",
      timestamp: 0,
    });
    manager.addEntry({
      agentName: "Sage",
      content: "We should define the problem clearly.",
      timestamp: 55_000,
    });
    manager.addEntry({
      agentName: "Rex",
      content: "Optimism is not a forecast.",
      timestamp: 40_000,
    });

    expect(manager.getContext()).toBe(
      "[Rex]: Optimism is not a forecast.\n[Sage]: We should define the problem clearly.",
    );

    currentTime += 10_001;

    expect(manager.getContext()).toBe(
      "[Sage]: We should define the problem clearly.",
    );
  });

  /**
   * Ensures entries that land exactly on the cutoff boundary are still treated
   * as part of the last 60 seconds.
   */
  it("keeps entries that are exactly on the window boundary", () => {
    const now = DEFAULT_CONTEXT_WINDOW_MS + 5_000;
    const manager = new ContextManager({
      now: () => now,
    });

    manager.addEntry({
      agentName: "Nova",
      content: "Boundary entries still matter.",
      timestamp: 5_000,
    });

    expect(manager.getContext()).toBe("[Nova]: Boundary entries still matter.");
  });

  /**
   * Ensures clock-skewed entries are withheld from the prompt until the local
   * wall clock reaches their timestamp instead of appearing early.
   */
  it("withholds future-dated entries until the clock catches up", () => {
    let currentTime = DEFAULT_CONTEXT_WINDOW_MS;
    const manager = new ContextManager({
      now: () => currentTime,
    });

    manager.addEntry({
      agentName: "Nova",
      content: "This already happened.",
      timestamp: currentTime - 5_000,
    });
    manager.addEntry({
      agentName: "Sage",
      content: "This came from a fast clock.",
      timestamp: currentTime + 1_000,
    });

    expect(manager.getContext()).toBe("[Nova]: This already happened.");

    currentTime += 1_000;

    expect(manager.getContext()).toBe(
      "[Nova]: This already happened.\n[Sage]: This came from a fast clock.",
    );
  });

  /**
   * Confirms clearing the manager removes all retained transcript state.
   */
  it("clears all retained context entries", () => {
    const manager = new ContextManager();

    manager.addEntry({
      agentName: "Sage",
      content: "We can reset the room memory.",
      timestamp: Date.now(),
    });

    manager.clear();

    expect(manager.getContext()).toBe("");
  });

  /**
   * Fails fast when callers provide malformed transcript input instead of
   * silently storing unusable prompt context.
   */
  it("rejects blank text and invalid timestamps", () => {
    const manager = new ContextManager();

    expect(() =>
      manager.addEntry({
        agentName: " ",
        content: "Valid content",
        timestamp: Date.now(),
      }),
    ).toThrowError(/agentName/i);

    expect(() =>
      manager.addEntry({
        agentName: "Nova",
        content: "   ",
        timestamp: Date.now(),
      }),
    ).toThrowError(/content/i);

    expect(() =>
      manager.addEntry({
        agentName: "Nova",
        content: "Valid content",
        timestamp: "not-a-date",
      }),
    ).toThrowError(/timestamp/i);
  });

  /**
   * Verifies each transcript turn stays on one prompt line even when the raw
   * utterance contains paragraph breaks.
   */
  it("collapses multiline transcript content into a single prompt line", () => {
    const now = DEFAULT_CONTEXT_WINDOW_MS;
    const manager = new ContextManager({
      now: () => now,
    });

    manager.addEntry({
      agentName: "Nova",
      content: "First line.\n\n  Second line.\r\nThird line.",
      timestamp: now,
    });

    expect(manager.getContext()).toBe(
      "[Nova]: First line. Second line. Third line.",
    );
  });

  /**
   * Ensures an invalid injected clock fails fast instead of silently clearing
   * the transcript window.
   */
  it("throws when the injected clock returns an invalid timestamp", () => {
    const manager = new ContextManager({
      now: () => Number.NaN,
    });

    expect(() =>
      manager.addEntry({
        agentName: "Nova",
        content: "Valid content",
        timestamp: 1,
      }),
    ).toThrowError(/now must return/i);
  });
});

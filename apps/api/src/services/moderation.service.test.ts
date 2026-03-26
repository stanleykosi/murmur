/**
 * Unit tests for the Murmur moderation filter.
 *
 * These tests pin the starter blocklist behavior so blocked phrases are
 * replaced deterministically while clean text passes through unchanged.
 */

import { describe, expect, it } from "vitest";

import { filterContent } from "./moderation.service.js";

describe("filterContent", () => {
  /**
   * Blocked words are replaced with the canonical `[filtered]` token.
   */
  it("filters blocked words", () => {
    const result = filterContent("This contains a fuck here.");

    expect(result.wasFiltered).toBe(true);
    expect(result.clean).toBe("This contains a [filtered] here.");
  });

  /**
   * Clean content should remain unchanged.
   */
  it("passes clean content through unchanged", () => {
    const cleanText = "This is a perfectly fine statement about technology.";
    const result = filterContent(cleanText);

    expect(result.wasFiltered).toBe(false);
    expect(result.clean).toBe(cleanText);
  });

  /**
   * Multiple blocked words in one message should all be replaced.
   */
  it("handles multiple violations in one message", () => {
    const result = filterContent("fuck some text shit");

    expect(result.wasFiltered).toBe(true);
    expect(result.clean).toBe("[filtered] some text [filtered]");
  });
});

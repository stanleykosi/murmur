/**
 * Unit tests for the canonical house-agent catalog.
 *
 * These tests pin the API seed definitions to the product specification so the
 * launch roster does not drift silently as the codebase evolves.
 */

import { describe, expect, it } from "vitest";

import { HOUSE_AGENTS, HOUSE_AGENT_IDS, getHouseAgentById } from "./agents.js";

describe("HOUSE_AGENTS", () => {
  /**
   * Confirms the API exposes the exact three built-in agents required by the
   * specification, with stable provider and styling metadata.
   */
  it("defines the three canonical Murmur house agents", () => {
    expect(HOUSE_AGENT_IDS).toEqual(["nova", "rex", "sage"]);
    expect(
      HOUSE_AGENTS.map((agent) => ({
        accentColor: agent.accentColor,
        avatarUrl: agent.avatarUrl,
        id: agent.id,
        name: agent.name,
        ttsProvider: agent.ttsProvider,
        voiceId: agent.voiceId,
      })),
    ).toEqual([
      {
        accentColor: "#00D4FF",
        avatarUrl: "/agents/nova.png",
        id: "nova",
        name: "Nova",
        ttsProvider: "cartesia",
        voiceId: "cartesia_voice_id_nova",
      },
      {
        accentColor: "#FF6B35",
        avatarUrl: "/agents/rex.png",
        id: "rex",
        name: "Rex",
        ttsProvider: "elevenlabs",
        voiceId: "elevenlabs_voice_id_rex",
      },
      {
        accentColor: "#A855F7",
        avatarUrl: "/agents/sage.png",
        id: "sage",
        name: "Sage",
        ttsProvider: "cartesia",
        voiceId: "cartesia_voice_id_sage",
      },
    ]);
  });

  /**
   * Verifies the catalog lookup helper returns the expected definition for a
   * stable built-in agent key.
   */
  it("supports deterministic lookup by house-agent ID", () => {
    expect(getHouseAgentById("nova")).toMatchObject({
      accentColor: "#00D4FF",
      id: "nova",
      name: "Nova",
      ttsProvider: "cartesia",
    });
  });
});

/**
 * Unit tests for the Murmur production system-prompt builder.
 *
 * These assertions pin the section ordering, role/format guidance, dead-air
 * override behavior, and fail-fast validation rules for Step 34 prompting.
 */

import { describe, expect, it } from "vitest";

import type { AgentRuntimeProfile } from "../runtime/agent-profile.js";
import {
  buildAgentSystemPrompt,
  type BuildAgentSystemPromptInput,
} from "./system.js";

/**
 * Canonical host fixture used by prompt-builder tests.
 */
const HOST_AGENT: AgentRuntimeProfile = {
  id: "agent-nova",
  name: "Nova",
  personality: "Optimistic, incisive, and quick to sharpen the core issue.",
  voiceId: "voice-nova",
  ttsProvider: "cartesia",
  accentColor: "#00D4FF",
  avatarUrl: "/agents/nova.png",
  role: "host",
};

/**
 * Canonical participant fixture used by prompt-builder tests.
 */
const PARTICIPANT_AGENT: AgentRuntimeProfile = {
  id: "agent-rex",
  name: "Rex",
  personality: "Skeptical, analytical, and blunt without being sloppy.",
  voiceId: "voice-rex",
  ttsProvider: "elevenlabs",
  accentColor: "#FF6B35",
  avatarUrl: "/agents/rex.png",
  role: "participant",
};

/**
 * Builds a complete prompt-builder input object with lightweight overrides.
 *
 * @param overrides - Per-test overrides for the default prompt input.
 * @returns A fully populated system-prompt input.
 */
function createPromptInput(
  overrides: Partial<BuildAgentSystemPromptInput> = {},
): BuildAgentSystemPromptInput {
  return {
    roomTitle: overrides.roomTitle ?? "Is AGI Five Years Away?",
    roomTopic: overrides.roomTopic ?? "Whether near-term AGI timelines are credible.",
    roomFormat: overrides.roomFormat ?? "moderated",
    agent: overrides.agent ?? HOST_AGENT,
    peers: overrides.peers ?? [PARTICIPANT_AGENT],
    turnOverride: overrides.turnOverride,
  };
}

describe("buildAgentSystemPrompt", () => {
  /**
   * Ensures the canonical section ordering never drifts.
   */
  it("renders the required sections in the exact production order", () => {
    const prompt = buildAgentSystemPrompt(createPromptInput());
    const expectedTitles = [
      "Identity",
      "Room Brief",
      "Role Rules",
      "Format Rules",
      "Conversation Quality Bar",
      "Output Contract",
      "Safety Guardrails",
      "Turn Override",
    ];
    const titleIndexes = expectedTitles.map((title) => prompt.indexOf(`${title}\n`));

    for (const index of titleIndexes) {
      expect(index).toBeGreaterThanOrEqual(0);
    }

    expect(titleIndexes).toEqual([...titleIndexes].sort((left, right) => left - right));
  });

  /**
   * Host and participant prompts must carry distinct control surfaces so the
   * room behaves correctly at runtime.
   */
  it("uses different role rules for hosts and participants", () => {
    const hostPrompt = buildAgentSystemPrompt(
      createPromptInput({
        agent: HOST_AGENT,
        peers: [PARTICIPANT_AGENT],
      }),
    );
    const participantPrompt = buildAgentSystemPrompt(
      createPromptInput({
        agent: PARTICIPANT_AGENT,
        peers: [HOST_AGENT],
      }),
    );

    expect(hostPrompt).toContain("You are the host for this room.");
    expect(hostPrompt).toContain("Invite other agents in by name");
    expect(hostPrompt).toContain("treated as a real handoff to that agent");
    expect(hostPrompt).toContain("Lean toward possibility, momentum, and frontier implications");
    expect(participantPrompt).toContain("You are a participant, not the moderator.");
    expect(participantPrompt).toContain("If the host explicitly calls on you by name");
    expect(participantPrompt).toContain("If the host clearly calls on another participant by name");
    expect(participantPrompt).toContain("do not try to run the room");
    expect(participantPrompt).toContain("Act as the pressure-tester for weak assumptions");
  });

  /**
   * Moderated and free-for-all rooms intentionally steer turns differently.
   */
  it("uses different format rules for moderated and free-for-all rooms", () => {
    const moderatedPrompt = buildAgentSystemPrompt(
      createPromptInput({
        roomFormat: "moderated",
      }),
    );
    const freeForAllPrompt = buildAgentSystemPrompt(
      createPromptInput({
        roomFormat: "free_for_all",
      }),
    );

    expect(moderatedPrompt).toContain("This is a moderated room.");
    expect(moderatedPrompt).toContain("Do not abruptly pivot away");
    expect(moderatedPrompt).toContain("A clear host handoff to one named agent should dominate");
    expect(freeForAllPrompt).toContain("This is a free-for-all room.");
    expect(freeForAllPrompt).toContain("Lateral topic pressure is allowed");
  });

  /**
   * Dead-air prompting must add explicit restart guidance instead of simply
   * pasting raw operator text.
   */
  it("wraps dead-air overrides in explicit recovery instructions", () => {
    const prompt = buildAgentSystemPrompt(
      createPromptInput({
        turnOverride:
          "The room went quiet. Force the discussion back into a real disagreement.",
      }),
    );

    expect(prompt).toContain("Dead-air recovery is active for this turn.");
    expect(prompt).toContain("Restart momentum with a fresh but relevant angle");
    expect(prompt).toContain("Do not open with a generic greeting");
    expect(prompt).toContain(
      "Additional turn-specific instruction: The room went quiet. Force the discussion back into a real disagreement.",
    );
  });

  /**
   * The prompt must keep the output contract explicit so downstream speech
   * generation receives one clean spoken turn.
   */
  it("includes the production output prohibitions and quality bar", () => {
    const prompt = buildAgentSystemPrompt(createPromptInput());

    expect(prompt).toContain("Make one net-new contribution in this turn.");
    expect(prompt).toContain("Do not use markdown, bullet points, numbered lists, emojis");
    expect(prompt).toContain("Avoid slurs, explicit profanity, hateful language");
    expect(prompt).toContain("Use 1-3 sentences total.");
  });

  /**
   * Missing prompt inputs should fail fast instead of degrading into a vague or
   * malformed system prompt.
   */
  it("throws on missing or malformed inputs", () => {
    expect(() =>
      buildAgentSystemPrompt(
        createPromptInput({
          roomTitle: "   ",
        }),
      ),
    ).toThrowError(/roomTitle/i);

    expect(() =>
      buildAgentSystemPrompt(
        createPromptInput({
          peers: [HOST_AGENT],
        }),
      ),
    ).toThrowError(/must not include the active speaking agent/i);

    expect(() =>
      buildAgentSystemPrompt(
        createPromptInput({
          turnOverride: "   ",
        }),
      ),
    ).toThrowError(/turnOverride/i);
  });
});

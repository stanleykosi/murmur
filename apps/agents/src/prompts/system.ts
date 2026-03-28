/**
 * Canonical production-grade system-prompt builder for Murmur agents.
 *
 * Every generated turn must be grounded in the room, the assigned role, and
 * the active conversation format. This module assembles one strict prompt shape
 * with ordered sections so agents behave consistently across rooms and turns.
 */

import { ROOM_FORMATS, type RoomFormat } from "@murmur/shared";

import {
  normalizeAgentRuntimeProfile,
  sortAgentRuntimeProfiles,
  type AgentRuntimeProfile,
} from "../runtime/agent-profile.js";

/**
 * Input contract required to compose one agent system prompt.
 */
export interface BuildAgentSystemPromptInput {
  roomTitle: string;
  roomTopic: string;
  roomFormat: RoomFormat;
  agent: AgentRuntimeProfile;
  peers: ReadonlyArray<AgentRuntimeProfile>;
  turnOverride?: string | null;
}

/**
 * Validates and trims a required string input.
 *
 * @param value - Candidate string value.
 * @param label - Human-readable field label for diagnostics.
 * @returns The trimmed string value.
 * @throws {Error} When the value is blank or not a string.
 */
function normalizeRequiredText(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return normalizedValue;
}

/**
 * Validates a Murmur room format literal.
 *
 * @param value - Candidate room format.
 * @returns The validated room format.
 * @throws {Error} When the format is unsupported.
 */
function normalizeRoomFormat(value: RoomFormat): RoomFormat {
  if (!ROOM_FORMATS.includes(value)) {
    throw new Error(`roomFormat must be one of: ${ROOM_FORMATS.join(", ")}.`);
  }

  return value;
}

/**
 * Normalizes the optional single-turn override text.
 *
 * @param value - Optional override string.
 * @returns The trimmed override or `null` when omitted.
 * @throws {Error} When a provided override is blank.
 */
function normalizeOptionalOverride(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return normalizeRequiredText(value, "turnOverride");
}

/**
 * Validates the peer roster and ensures the speaking agent is not included.
 *
 * @param agent - Current speaker profile.
 * @param peers - Peer roster supplied by the caller.
 * @returns A validated, stably sorted peer roster.
 * @throws {Error} When the roster is malformed.
 */
function normalizePeers(
  agent: AgentRuntimeProfile,
  peers: ReadonlyArray<AgentRuntimeProfile>,
): AgentRuntimeProfile[] {
  if (!Array.isArray(peers)) {
    throw new Error("peers must be an array.");
  }

  const sortedPeers = sortAgentRuntimeProfiles(peers);
  const seenPeerIds = new Set<string>();

  for (const peer of sortedPeers) {
    if (peer.id === agent.id) {
      throw new Error("peers must not include the active speaking agent.");
    }

    if (seenPeerIds.has(peer.id)) {
      throw new Error(`peers must contain unique ids. Duplicate "${peer.id}" was provided.`);
    }

    seenPeerIds.add(peer.id);
  }

  return sortedPeers;
}

/**
 * Formats the room roster as speakable runtime context for the system prompt.
 *
 * @param peers - Other room participants besides the current speaker.
 * @returns A human-readable roster string.
 */
function formatPeerRoster(peers: ReadonlyArray<AgentRuntimeProfile>): string {
  if (peers.length === 0) {
    return "No other active agents are currently assigned to this room.";
  }

  return peers
    .map((peer) => `- ${peer.name} (${peer.role})`)
    .join("\n");
}

/**
 * Returns role-specific prompt instructions for the active speaker.
 *
 * @param agent - Current speaker profile.
 * @returns A multi-line rule block for the speaker's room role.
 */
function buildRoleRules(agent: AgentRuntimeProfile): string {
  if (agent.role === "host") {
    return [
      "- You are the host for this room.",
      "- Keep the conversation moving with intention and urgency.",
      "- Sharpen disagreements when they are interesting, but keep them productive.",
      "- Invite other agents in by name when doing so will improve the discussion.",
      "- Prevent stalls, dead ends, and circular re-statements.",
    ].join("\n");
  }

  return [
    "- You are a participant, not the moderator.",
    "- Respond directly to the strongest recent claim, question, or disagreement.",
    "- Add genuine new substance instead of echoing the room's framing.",
    "- Push back when warranted, but do not try to run the room.",
    "- Let the host control the flow unless the format naturally invites interruption.",
  ].join("\n");
}

/**
 * Returns format-specific prompt instructions for the active room.
 *
 * @param roomFormat - Current room format.
 * @returns A multi-line rule block for the room format.
 */
function buildFormatRules(roomFormat: RoomFormat): string {
  if (roomFormat === "moderated") {
    return [
      "- This is a moderated room.",
      "- Prefer answering the host's latest framing or the most recent direct prompt.",
      "- Do not abruptly pivot away from the active line of discussion.",
      "- Keep your reply legible inside a moderated back-and-forth.",
    ].join("\n");
  }

  return [
    "- This is a free-for-all room.",
    "- You may challenge, rebut, or pressure-test other agents more aggressively.",
    "- Lateral topic pressure is allowed, but remain recognizably on-topic.",
    "- Do not turn the room into chaos; keep the discussion coherent for listeners.",
  ].join("\n");
}

/**
 * Builds the canonical production-grade system prompt for one turn.
 *
 * @param input - Room, role, roster, and optional override context for the turn.
 * @returns The fully composed system prompt with ordered sections.
 * @throws {Error} When any input is missing or malformed.
 */
export function buildAgentSystemPrompt(
  input: BuildAgentSystemPromptInput,
): string {
  if (!input || typeof input !== "object") {
    throw new Error("input must be an object.");
  }

  const agent = normalizeAgentRuntimeProfile(input.agent, "agent");
  const roomTitle = normalizeRequiredText(input.roomTitle, "roomTitle");
  const roomTopic = normalizeRequiredText(input.roomTopic, "roomTopic");
  const roomFormat = normalizeRoomFormat(input.roomFormat);
  const peers = normalizePeers(agent, input.peers);
  const turnOverride = normalizeOptionalOverride(input.turnOverride);

  const sections = [
    [
      "Identity",
      [
        `You are ${agent.name}, speaking live in a Murmur audio room.`,
        "Stay fully in character for this turn and sound like natural spoken English rather than written prose.",
        "Do not narrate your behavior or describe tone explicitly; simply embody it.",
        "Core personality and speaking style:",
        agent.personality,
      ].join("\n"),
    ],
    [
      "Room Brief",
      [
        `Room title: ${roomTitle}`,
        `Room topic: ${roomTopic}`,
        `Room format: ${roomFormat}`,
        `Your role: ${agent.role}`,
        "Other active agents:",
        formatPeerRoster(peers),
      ].join("\n"),
    ],
    [
      "Role Rules",
      buildRoleRules(agent),
    ],
    [
      "Format Rules",
      buildFormatRules(roomFormat),
    ],
    [
      "Conversation Quality Bar",
      [
        "- Make one net-new contribution in this turn.",
        "- When recent transcript context exists, ground your response in a concrete recent claim, question, or disagreement.",
        "- Do not repeat your own recent point unless you are refining it, rebutting a challenge, or tightening it into a sharper claim.",
        "- Favor specific, speakable language over filler, vagueness, or abstract hand-waving.",
        "- Keep the room interesting for listeners: clarity, momentum, and strong substance matter more than sounding polite.",
      ].join("\n"),
    ],
    [
      "Output Contract",
      [
        "- Produce exactly one spoken turn.",
        "- Use 1-3 sentences total.",
        "- Use natural spoken English.",
        "- Do not use markdown, bullet points, numbered lists, emojis, speaker labels, quoted script formatting, parenthetical stage directions, or meta commentary about what you are doing.",
      ].join("\n"),
    ],
    [
      "Safety Guardrails",
      [
        "- Avoid slurs, explicit profanity, hateful language, harassment, or other policy-breaking content.",
        "- If a sharper point can be made cleanly, prefer the clean version.",
        "- The system will still moderate output, but you should not rely on that fallback.",
      ].join("\n"),
    ],
    [
      "Turn Override",
      turnOverride
        ? [
          "Dead-air recovery is active for this turn.",
          "- Restart momentum with a fresh but relevant angle on the room topic.",
          "- Prefer one provocative but on-topic question or claim if that will get the room moving again.",
          "- Do not open with a generic greeting or throat-clearing filler.",
          `- Additional turn-specific instruction: ${turnOverride}`,
        ].join("\n")
        : "No special override is active for this turn. Continue the conversation under the rules above.",
    ],
  ] as const;

  return sections
    .map(([title, body]) => `${title}\n${body}`)
    .join("\n\n");
}

/**
 * Priority scoring helpers for Murmur floor selection.
 *
 * This module keeps the next-speaker scoring logic pure and deterministic apart
 * from an explicitly injected random tie-breaker. The orchestrator can reuse
 * these helpers without bringing along any Redis or room-lifecycle state.
 */

import {
  AGENT_ROLES,
  ENGAGEMENT_DEBT_CAP,
  HOST_ROLE_BONUS,
  type AgentRole,
} from "@murmur/shared";

/**
 * Candidate speaker data required to score an agent for the next turn.
 */
export interface SpeakerCandidate {
  id: string;
  role: AgentRole;
  lastSpokeAt: number | null;
}

/**
 * Optional runtime hooks for deterministic score calculation in tests.
 */
export interface ComputeScoreOptions {
  now?: () => number;
}

/**
 * Optional runtime hooks for deterministic speaker selection in tests.
 */
export interface SelectNextSpeakerOptions extends ComputeScoreOptions {
  random?: () => number;
}

/**
 * Validates and trims a required candidate field.
 *
 * @param value - Raw string value from a caller.
 * @param label - Human-readable field name used in diagnostics.
 * @returns The trimmed string.
 * @throws {Error} When the value is not a string or is blank.
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
 * Validates a room-role literal used for scoring.
 *
 * @param value - Candidate agent role.
 * @returns The validated role.
 * @throws {Error} When the role is unsupported.
 */
function normalizeAgentRole(value: AgentRole): AgentRole {
  if (!AGENT_ROLES.includes(value)) {
    throw new Error(`role must be one of: ${AGENT_ROLES.join(", ")}.`);
  }

  return value;
}

/**
 * Validates a timestamp-like number in epoch milliseconds.
 *
 * @param value - Candidate timestamp or `null` for agents that never spoke.
 * @param label - Human-readable field name used in diagnostics.
 * @returns A validated timestamp or `null`.
 * @throws {Error} When the timestamp is neither `null` nor a finite number.
 */
function normalizeOptionalTimestamp(
  value: number | null,
  label: string,
): number | null {
  if (value === null) {
    return null;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be null or a non-negative finite number.`);
  }

  return value;
}

/**
 * Validates an injected clock implementation and returns the current time.
 *
 * @param now - Optional injected clock for deterministic tests.
 * @returns The current epoch timestamp in milliseconds.
 * @throws {Error} When the clock is not a function or returns an invalid value.
 */
function getCurrentTimestamp(now: (() => number) | undefined): number {
  const clock = now ?? Date.now;

  if (typeof clock !== "function") {
    throw new Error("now must be a function.");
  }

  const timestamp = clock();

  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new Error("now() must return a non-negative finite number.");
  }

  return timestamp;
}

/**
 * Validates a random-number implementation used for tie-breaking.
 *
 * @param random - Optional injected random generator.
 * @returns A floating-point value in the range `[0, 1)`.
 * @throws {Error} When the generator is not a function or returns an invalid value.
 */
function getRandomValue(random: (() => number) | undefined): number {
  const randomSource = random ?? Math.random;

  if (typeof randomSource !== "function") {
    throw new Error("random must be a function.");
  }

  const value = randomSource();

  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error("random() must return a finite number in the range [0, 1).");
  }

  return value;
}

/**
 * Validates the candidate shape before scoring or selection.
 *
 * @param candidate - Candidate speaker supplied by the caller.
 * @returns The normalized candidate object.
 * @throws {Error} When one or more fields are malformed.
 */
function normalizeCandidate(candidate: SpeakerCandidate): SpeakerCandidate {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("candidate must be an object.");
  }

  return {
    id: normalizeRequiredText(candidate.id, "candidate.id"),
    role: normalizeAgentRole(candidate.role),
    lastSpokeAt: normalizeOptionalTimestamp(
      candidate.lastSpokeAt,
      "candidate.lastSpokeAt",
    ),
  };
}

/**
 * Computes the engagement-debt component of a speaker score.
 *
 * Agents that never spoke receive the full debt cap. Future-dated timestamps
 * are clamped to zero debt so clock skew never yields negative scores.
 *
 * @param lastSpokeAt - Most recent speaking timestamp or `null`.
 * @param now - Current clock value in milliseconds.
 * @returns Engagement debt in seconds, capped to Murmur's configured maximum.
 */
function computeEngagementDebt(
  lastSpokeAt: number | null,
  now: number,
): number {
  if (lastSpokeAt === null) {
    return ENGAGEMENT_DEBT_CAP;
  }

  return Math.min(
    Math.max((now - lastSpokeAt) / 1000, 0),
    ENGAGEMENT_DEBT_CAP,
  );
}

/**
 * Computes the canonical Murmur priority score for one speaker candidate.
 *
 * @param candidate - Candidate speaker to evaluate.
 * @param options - Optional deterministic clock override for tests.
 * @returns The total speaker score.
 */
export function computeScore(
  candidate: SpeakerCandidate,
  options: ComputeScoreOptions = {},
): number {
  const normalizedCandidate = normalizeCandidate(candidate);
  const now = getCurrentTimestamp(options.now);
  const engagementDebt = computeEngagementDebt(
    normalizedCandidate.lastSpokeAt,
    now,
  );
  const roleBonus =
    normalizedCandidate.role === "host" ? HOST_ROLE_BONUS : 0;

  return engagementDebt + roleBonus;
}

/**
 * Selects the next speaker from a candidate list using Murmur's priority score.
 *
 * Every candidate is scored exactly once. When multiple agents share the
 * highest score, selection falls back to one random choice among only the tied
 * candidates.
 *
 * @param candidates - Agents eligible to claim the floor.
 * @param options - Optional deterministic hooks for clock and randomness.
 * @returns The selected speaker, or `null` when no candidates are available.
 */
export function selectNextSpeaker(
  candidates: ReadonlyArray<SpeakerCandidate>,
  options: SelectNextSpeakerOptions = {},
): SpeakerCandidate | null {
  if (!Array.isArray(candidates)) {
    throw new Error("candidates must be an array.");
  }

  if (candidates.length === 0) {
    return null;
  }

  const now = getCurrentTimestamp(options.now);
  const seenIds = new Set<string>();
  const scoredCandidates = candidates.map((candidate) => {
    const normalizedCandidate = normalizeCandidate(candidate);

    if (seenIds.has(normalizedCandidate.id)) {
      throw new Error(
        `candidates must contain unique ids. Duplicate id "${normalizedCandidate.id}" was provided.`,
      );
    }

    seenIds.add(normalizedCandidate.id);

    return {
      candidate: normalizedCandidate,
      score: computeScore(normalizedCandidate, {
        now: () => now,
      }),
    };
  });
  const highestScore = Math.max(
    ...scoredCandidates.map((entry) => entry.score),
  );
  const tiedCandidates = scoredCandidates
    .filter((entry) => entry.score === highestScore)
    .map((entry) => entry.candidate);

  if (tiedCandidates.length === 1) {
    return tiedCandidates[0] ?? null;
  }

  const randomValue = getRandomValue(options.random);
  const selectedIndex = Math.floor(randomValue * tiedCandidates.length);

  return tiedCandidates[selectedIndex] ?? null;
}

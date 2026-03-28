/**
 * Runtime-facing agent profile contracts for the Murmur orchestrator.
 *
 * The database stores canonical agent rows while room assignments add the
 * per-room `role`. This module combines those concerns into one validated
 * runtime shape that the graph, prompts, runner, and orchestrator can all
 * share without depending on room-repository row formats.
 */

import {
  AGENT_ROLES,
  TTS_PROVIDERS,
  type AgentRole,
  type TtsProvider,
} from "@murmur/shared";

/**
 * Fully resolved agent configuration required at runtime for one room.
 */
export interface AgentRuntimeProfile {
  id: string;
  name: string;
  personality: string;
  voiceId: string;
  ttsProvider: TtsProvider;
  accentColor: string;
  avatarUrl: string;
  role: AgentRole;
}

/**
 * Validates and trims a required string field.
 *
 * @param value - Candidate caller-supplied string.
 * @param label - Human-readable field label for diagnostics.
 * @returns The trimmed string value.
 * @throws {Error} When the field is not a non-empty string.
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
 * Validates a Murmur room-agent role value.
 *
 * @param value - Candidate room role.
 * @param label - Human-readable field label for diagnostics.
 * @returns The validated role.
 * @throws {Error} When the role is unsupported.
 */
function normalizeAgentRole(value: AgentRole, label: string): AgentRole {
  if (!AGENT_ROLES.includes(value)) {
    throw new Error(`${label} must be one of: ${AGENT_ROLES.join(", ")}.`);
  }

  return value;
}

/**
 * Validates a Murmur text-to-speech provider identifier.
 *
 * @param value - Candidate provider identifier.
 * @param label - Human-readable field label for diagnostics.
 * @returns The validated provider value.
 * @throws {Error} When the provider is unsupported.
 */
function normalizeTtsProvider(value: TtsProvider, label: string): TtsProvider {
  if (!TTS_PROVIDERS.includes(value)) {
    throw new Error(`${label} must be one of: ${TTS_PROVIDERS.join(", ")}.`);
  }

  return value;
}

/**
 * Validates one runtime profile and returns a normalized copy.
 *
 * @param profile - Candidate runtime profile from a repository or caller.
 * @param label - Prefix used for validation messages.
 * @returns A normalized runtime profile.
 * @throws {Error} When the profile is malformed.
 */
export function normalizeAgentRuntimeProfile(
  profile: AgentRuntimeProfile,
  label = "agent",
): AgentRuntimeProfile {
  if (!profile || typeof profile !== "object") {
    throw new Error(`${label} must be an object.`);
  }

  return {
    id: normalizeRequiredText(profile.id, `${label}.id`),
    name: normalizeRequiredText(profile.name, `${label}.name`),
    personality: normalizeRequiredText(
      profile.personality,
      `${label}.personality`,
    ),
    voiceId: normalizeRequiredText(profile.voiceId, `${label}.voiceId`),
    ttsProvider: normalizeTtsProvider(
      profile.ttsProvider,
      `${label}.ttsProvider`,
    ),
    accentColor: normalizeRequiredText(
      profile.accentColor,
      `${label}.accentColor`,
    ),
    avatarUrl: normalizeRequiredText(profile.avatarUrl, `${label}.avatarUrl`),
    role: normalizeAgentRole(profile.role, `${label}.role`),
  };
}

/**
 * Returns a stable room-stage ordering with the host first, then
 * alphabetically by name, then by identifier as a deterministic tiebreaker.
 *
 * @param profiles - Runtime profiles to sort.
 * @returns A new sorted array without mutating the caller's input.
 */
export function sortAgentRuntimeProfiles(
  profiles: ReadonlyArray<AgentRuntimeProfile>,
): AgentRuntimeProfile[] {
  return [...profiles]
    .map((profile, index) => ({
      profile: normalizeAgentRuntimeProfile(profile, `profiles[${index}]`),
      index,
    }))
    .sort((left, right) => {
      if (left.profile.role !== right.profile.role) {
        return left.profile.role === "host" ? -1 : 1;
      }

      const nameComparison = left.profile.name.localeCompare(right.profile.name);

      if (nameComparison !== 0) {
        return nameComparison;
      }

      return left.profile.id.localeCompare(right.profile.id);
    })
    .map(({ profile }) => profile);
}

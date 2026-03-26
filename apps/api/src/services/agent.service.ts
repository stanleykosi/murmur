/**
 * Agent-domain service layer for the Murmur API.
 *
 * This module exposes the canonical read and update operations for persisted
 * agent records. Public routes only use the active-agent reads, while admin
 * tooling can reuse the update function in later steps without introducing a
 * parallel write path.
 */

import { TTS_PROVIDERS, type Agent, type TtsProvider } from "@murmur/shared";
import { and, asc, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { agents, type AgentRecord } from "../db/schema.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";

const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/**
 * Partial update payload accepted by the canonical agent update flow.
 */
export interface UpdateAgentInput {
  accentColor?: string;
  avatarUrl?: string;
  isActive?: boolean;
  name?: string;
  personality?: string;
  ttsProvider?: TtsProvider;
  voiceId?: string;
}

/**
 * Maps a persisted agent row into the shared transport shape used across the
 * API, frontend, and agent orchestrator workspaces.
 *
 * @param agentRecord - Persisted database row for an agent.
 * @returns The serialized shared agent payload.
 */
function mapAgentRecordToAgent(agentRecord: AgentRecord): Agent {
  return {
    accentColor: agentRecord.accentColor,
    avatarUrl: agentRecord.avatarUrl,
    createdAt: agentRecord.createdAt,
    id: agentRecord.id,
    isActive: agentRecord.isActive,
    name: agentRecord.name,
    personality: agentRecord.personality,
    ttsProvider: agentRecord.ttsProvider,
    voiceId: agentRecord.voiceId,
  };
}

/**
 * Trims and validates a required string field supplied in an agent update.
 *
 * @param value - Candidate string value supplied by the caller.
 * @param label - Human-readable field name for error messages.
 * @returns The trimmed non-empty string value.
 * @throws {ValidationError} When the field is blank after trimming.
 */
function normalizeRequiredString(value: string, label: string): string {
  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new ValidationError(`${label} cannot be empty.`);
  }

  return normalizedValue;
}

/**
 * Validates and normalizes an agent update payload before persistence.
 *
 * @param input - Partial update payload supplied by a caller.
 * @returns A sanitized update payload ready for Drizzle's `set()` clause.
 * @throws {ValidationError} When no valid update fields are supplied.
 */
function sanitizeUpdateInput(input: UpdateAgentInput): Partial<typeof agents.$inferInsert> {
  const sanitizedInput: Partial<typeof agents.$inferInsert> = {};

  if (input.name !== undefined) {
    sanitizedInput.name = normalizeRequiredString(input.name, "name");
  }

  if (input.personality !== undefined) {
    sanitizedInput.personality = normalizeRequiredString(
      input.personality,
      "personality",
    );
  }

  if (input.voiceId !== undefined) {
    sanitizedInput.voiceId = normalizeRequiredString(input.voiceId, "voiceId");
  }

  if (input.avatarUrl !== undefined) {
    sanitizedInput.avatarUrl = normalizeRequiredString(
      input.avatarUrl,
      "avatarUrl",
    );
  }

  if (input.accentColor !== undefined) {
    const normalizedAccentColor = normalizeRequiredString(
      input.accentColor,
      "accentColor",
    );

    if (!HEX_COLOR_PATTERN.test(normalizedAccentColor)) {
      throw new ValidationError(
        "accentColor must be a valid 6-digit hex color such as #00D4FF.",
      );
    }

    sanitizedInput.accentColor = normalizedAccentColor;
  }

  if (input.ttsProvider !== undefined) {
    if (!TTS_PROVIDERS.includes(input.ttsProvider)) {
      throw new ValidationError(
        `ttsProvider must be one of: ${TTS_PROVIDERS.join(", ")}.`,
      );
    }

    sanitizedInput.ttsProvider = input.ttsProvider;
  }

  if (input.isActive !== undefined) {
    sanitizedInput.isActive = input.isActive;
  }

  if (Object.keys(sanitizedInput).length === 0) {
    throw new ValidationError("At least one updatable agent field is required.");
  }

  return sanitizedInput;
}

/**
 * Lists all active agents in deterministic alphabetical order.
 *
 * @returns The active agent catalog used by public clients.
 */
export async function listAgents(): Promise<Agent[]> {
  const agentRecords = await db.query.agents.findMany({
    orderBy: [asc(agents.name)],
    where: eq(agents.isActive, true),
  });

  return agentRecords.map(mapAgentRecordToAgent);
}

/**
 * Loads a single active agent for public API consumers.
 *
 * Inactive agents are intentionally hidden from public reads so the API
 * exposes one canonical active-agent catalog.
 *
 * @param agentId - UUID of the agent to load.
 * @returns The requested active agent.
 * @throws {NotFoundError} When the agent does not exist or is inactive.
 */
export async function getAgentById(agentId: string): Promise<Agent> {
  const agentRecord = await db.query.agents.findFirst({
    where: and(eq(agents.id, agentId), eq(agents.isActive, true)),
  });

  if (!agentRecord) {
    throw new NotFoundError(`Active agent "${agentId}" was not found.`);
  }

  return mapAgentRecordToAgent(agentRecord);
}

/**
 * Updates a persisted agent row with validated canonical fields.
 *
 * @param agentId - UUID of the agent to update.
 * @param input - Partial update payload containing supported mutable fields.
 * @returns The updated agent record.
 * @throws {ValidationError} When the payload is empty or malformed.
 * @throws {NotFoundError} When the target agent does not exist.
 */
export async function updateAgent(
  agentId: string,
  input: UpdateAgentInput,
): Promise<Agent> {
  const sanitizedInput = sanitizeUpdateInput(input);
  const [updatedAgent] = await db
    .update(agents)
    .set(sanitizedInput)
    .where(eq(agents.id, agentId))
    .returning();

  if (!updatedAgent) {
    throw new NotFoundError(`Agent "${agentId}" was not found.`);
  }

  return mapAgentRecordToAgent(updatedAgent);
}

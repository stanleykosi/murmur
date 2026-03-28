/**
 * PostgreSQL-backed active-room repository for the Murmur agents service.
 *
 * The orchestrator's canonical source of truth for room lifecycle and
 * assignments is PostgreSQL. This module loads the current live-room set and
 * resolves fully validated runtime agent profiles for each room.
 */

import {
  AGENT_ROLES,
  ROOM_FORMATS,
  type AgentRole,
  type RoomFormat,
} from "@murmur/shared";
import type { Pool } from "pg";

import { pool } from "../db/client.js";
import { createLogger } from "../lib/logger.js";
import {
  normalizeAgentRuntimeProfile,
  sortAgentRuntimeProfiles,
  type AgentRuntimeProfile,
} from "../runtime/agent-profile.js";

const roomRepositoryLogger = createLogger({ component: "room-repository" });

/**
 * Fully resolved room definition consumed by the orchestrator runtime.
 */
export interface ActiveRoomRecord {
  id: string;
  title: string;
  topic: string;
  format: RoomFormat;
  agents: AgentRuntimeProfile[];
  hostAgentId: string;
  fingerprint: string;
}

interface ActiveRoomRow {
  room_id: string;
  room_title: string;
  room_topic: string;
  room_format: RoomFormat;
  agent_id: string;
  agent_name: string;
  agent_personality: string;
  agent_voice_id: string;
  agent_tts_provider: AgentRuntimeProfile["ttsProvider"];
  agent_avatar_url: string;
  agent_accent_color: string;
  assignment_role: AgentRole;
}

/**
 * Validates and trims a required string field.
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
 * Validates a room format loaded from PostgreSQL.
 *
 * @param value - Candidate room format.
 * @returns The validated room format.
 * @throws {Error} When the format is unsupported.
 */
function normalizeRoomFormat(value: RoomFormat): RoomFormat {
  if (!ROOM_FORMATS.includes(value)) {
    throw new Error(`room.format must be one of: ${ROOM_FORMATS.join(", ")}.`);
  }

  return value;
}

/**
 * Validates a room-agent role loaded from PostgreSQL.
 *
 * @param value - Candidate role value.
 * @returns The validated role.
 * @throws {Error} When the role is unsupported.
 */
function normalizeAgentRole(value: AgentRole): AgentRole {
  if (!AGENT_ROLES.includes(value)) {
    throw new Error(`agent.role must be one of: ${AGENT_ROLES.join(", ")}.`);
  }

  return value;
}

/**
 * Builds a stable fingerprint for one active room definition.
 *
 * The orchestrator uses this value to determine when a room runtime must be
 * restarted because assignments or room metadata changed in PostgreSQL.
 *
 * @param room - Active room definition to fingerprint.
 * @returns A stable JSON fingerprint string.
 */
export function buildRoomFingerprint(room: Omit<ActiveRoomRecord, "fingerprint">): string {
  return JSON.stringify({
    id: room.id,
    title: room.title,
    topic: room.topic,
    format: room.format,
    agents: room.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      personality: agent.personality,
      voiceId: agent.voiceId,
      ttsProvider: agent.ttsProvider,
      accentColor: agent.accentColor,
      avatarUrl: agent.avatarUrl,
      role: agent.role,
    })),
  });
}

/**
 * PostgreSQL-backed room repository.
 */
export class RoomRepository {
  /**
   * Creates a repository backed by the shared agents database pool.
   *
   * @param client - PostgreSQL client or pool used for queries.
   */
  public constructor(
    private readonly client: Pick<Pool, "query"> = pool,
  ) {}

  /**
   * Loads all currently live rooms with their active agent assignments.
   *
   * @returns Fully validated active room definitions.
   * @throws {Error} When PostgreSQL returns malformed or inconsistent room data.
   */
  public async listActiveRooms(): Promise<ActiveRoomRecord[]> {
    const result = await this.client.query<ActiveRoomRow>(`
      select
        r.id as room_id,
        r.title as room_title,
        r.topic as room_topic,
        r.format as room_format,
        a.id as agent_id,
        a.name as agent_name,
        a.personality as agent_personality,
        a.voice_id as agent_voice_id,
        a.tts_provider as agent_tts_provider,
        a.avatar_url as agent_avatar_url,
        a.accent_color as agent_accent_color,
        ra.role as assignment_role
      from rooms r
      inner join room_agents ra
        on ra.room_id = r.id
      inner join agents a
        on a.id = ra.agent_id
      where r.status = 'live'
        and a.is_active = true
      order by r.created_at asc, ra.role asc, a.name asc, a.id asc
    `);

    const roomsById = new Map<string, Omit<ActiveRoomRecord, "fingerprint">>();

    for (const [rowIndex, row] of result.rows.entries()) {
      const roomId = normalizeRequiredText(row.room_id, `rows[${rowIndex}].room_id`);
      const existingRoom = roomsById.get(roomId);
      const roomRecord = existingRoom ?? {
        id: roomId,
        title: normalizeRequiredText(row.room_title, `rows[${rowIndex}].room_title`),
        topic: normalizeRequiredText(row.room_topic, `rows[${rowIndex}].room_topic`),
        format: normalizeRoomFormat(row.room_format),
        agents: [],
        hostAgentId: "",
      };
      const runtimeProfile = normalizeAgentRuntimeProfile({
        id: normalizeRequiredText(row.agent_id, `rows[${rowIndex}].agent_id`),
        name: normalizeRequiredText(row.agent_name, `rows[${rowIndex}].agent_name`),
        personality: normalizeRequiredText(
          row.agent_personality,
          `rows[${rowIndex}].agent_personality`,
        ),
        voiceId: normalizeRequiredText(
          row.agent_voice_id,
          `rows[${rowIndex}].agent_voice_id`,
        ),
        ttsProvider: row.agent_tts_provider,
        accentColor: normalizeRequiredText(
          row.agent_accent_color,
          `rows[${rowIndex}].agent_accent_color`,
        ),
        avatarUrl: normalizeRequiredText(
          row.agent_avatar_url,
          `rows[${rowIndex}].agent_avatar_url`,
        ),
        role: normalizeAgentRole(row.assignment_role),
      }, `rows[${rowIndex}]`);

      if (roomRecord.agents.some((agent) => agent.id === runtimeProfile.id)) {
        throw new Error(
          `Room "${roomId}" contains duplicate active agent assignment "${runtimeProfile.id}".`,
        );
      }

      roomRecord.agents.push(runtimeProfile);

      if (runtimeProfile.role === "host") {
        if (roomRecord.hostAgentId.length > 0) {
          throw new Error(`Room "${roomId}" must have exactly one host agent assignment.`);
        }

        roomRecord.hostAgentId = runtimeProfile.id;
      }

      roomsById.set(roomId, roomRecord);
    }

    const activeRooms = Array.from(roomsById.values()).map((room) => {
      if (room.agents.length < 2 || room.agents.length > 3) {
        throw new Error(
          `Room "${room.id}" must have between 2 and 3 active agents. Found ${room.agents.length}.`,
        );
      }

      if (room.hostAgentId.length === 0) {
        throw new Error(`Room "${room.id}" must have exactly one host agent.`);
      }

      const sortedAgents = sortAgentRuntimeProfiles(room.agents);
      const normalizedRoom = {
        ...room,
        agents: sortedAgents,
      };

      return {
        ...normalizedRoom,
        fingerprint: buildRoomFingerprint(normalizedRoom),
      };
    });

    roomRepositoryLogger.debug(
      {
        roomCount: activeRooms.length,
      },
      "Loaded active rooms for orchestrator synchronization.",
    );

    return activeRooms;
  }
}

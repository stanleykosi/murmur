/**
 * PostgreSQL-backed transcript repository for the Murmur agents service.
 *
 * Agent runners persist every spoken utterance and hydrate room-local rolling
 * transcript state from PostgreSQL on startup. This module keeps those query
 * and insert paths typed, validated, and independent from API-app imports.
 */

import { ROLLING_WINDOW_SECONDS, type TranscriptEntry, type TranscriptEvent } from "@murmur/shared";
import type { Pool } from "pg";

import { pool } from "../db/client.js";
import { createLogger } from "../lib/logger.js";

const transcriptRepositoryLogger = createLogger({
  component: "transcript-repository",
});

interface TranscriptHistoryRow {
  transcript_id: string;
  room_id: string;
  agent_id: string;
  agent_name: string;
  content: string;
  timestamp: string;
  accent_color: string;
  was_filtered: boolean;
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
 * Validates a persisted transcript timestamp string.
 *
 * @param value - Candidate timestamp string from PostgreSQL.
 * @param label - Human-readable field label for diagnostics.
 * @returns The original timestamp when it parses as a valid date.
 * @throws {Error} When the timestamp is invalid.
 */
function normalizeIsoTimestamp(value: string, label: string): string {
  const normalizedValue = normalizeRequiredText(value, label);
  const parsedValue = Date.parse(normalizedValue);

  if (!Number.isFinite(parsedValue)) {
    throw new Error(`${label} must be a valid ISO date string.`);
  }

  return normalizedValue;
}

/**
 * Repository interface consumed by the runner and orchestrator.
 */
export interface TranscriptRepository {
  listRecentByRoomId(roomId: string): Promise<TranscriptEntry[]>;
  insertTranscriptEvent(event: TranscriptEvent): Promise<void>;
}

/**
 * PostgreSQL-backed transcript repository implementation.
 */
export class PostgresTranscriptRepository implements TranscriptRepository {
  /**
   * Creates a transcript repository backed by the shared agents database pool.
   *
   * @param client - PostgreSQL client or pool used for queries.
   */
  public constructor(
    private readonly client: Pick<Pool, "query"> = pool,
  ) {}

  /**
   * Loads the most recent rolling transcript window for one room.
   *
   * @param roomId - Murmur room identifier whose transcript should be loaded.
   * @returns Chronologically ordered transcript entries from the last 60 seconds.
   */
  public async listRecentByRoomId(roomId: string): Promise<TranscriptEntry[]> {
    const normalizedRoomId = normalizeRequiredText(roomId, "roomId");
    const result = await this.client.query<TranscriptHistoryRow>(
      `
        select
          t.id as transcript_id,
          t.room_id,
          t.agent_id,
          a.name as agent_name,
          t.content,
          t.created_at::text as timestamp,
          a.accent_color,
          t.was_filtered
        from transcripts t
        inner join agents a
          on a.id = t.agent_id
        where t.room_id = $1
          and t.created_at >= (now() - ($2::int * interval '1 second'))
        order by t.created_at asc, t.id asc
      `,
      [normalizedRoomId, ROLLING_WINDOW_SECONDS],
    );

    return result.rows.map((row, rowIndex) => ({
      id: normalizeRequiredText(row.transcript_id, `rows[${rowIndex}].transcript_id`),
      roomId: normalizeRequiredText(row.room_id, `rows[${rowIndex}].room_id`),
      agentId: normalizeRequiredText(row.agent_id, `rows[${rowIndex}].agent_id`),
      agentName: normalizeRequiredText(row.agent_name, `rows[${rowIndex}].agent_name`),
      content: normalizeRequiredText(row.content, `rows[${rowIndex}].content`),
      timestamp: normalizeIsoTimestamp(row.timestamp, `rows[${rowIndex}].timestamp`),
      accentColor: normalizeRequiredText(
        row.accent_color,
        `rows[${rowIndex}].accent_color`,
      ),
      wasFiltered: row.was_filtered,
    }));
  }

  /**
   * Persists one spoken transcript event into PostgreSQL.
   *
   * @param event - Transcript event emitted by the graph speak node.
   */
  public async insertTranscriptEvent(event: TranscriptEvent): Promise<void> {
    await this.client.query(
      `
        insert into transcripts (
          id,
          room_id,
          agent_id,
          content,
          was_filtered
        )
        values ($1, $2, $3, $4, $5)
      `,
      [
        normalizeRequiredText(event.id, "event.id"),
        normalizeRequiredText(event.roomId, "event.roomId"),
        normalizeRequiredText(event.agentId, "event.agentId"),
        normalizeRequiredText(event.content, "event.content"),
        event.wasFiltered,
      ],
    );

    transcriptRepositoryLogger.debug(
      {
        agentId: event.agentId,
        roomId: event.roomId,
        transcriptId: event.id,
      },
      "Persisted transcript event to PostgreSQL.",
    );
  }
}

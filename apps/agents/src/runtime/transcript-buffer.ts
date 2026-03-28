/**
 * In-memory rolling transcript buffer for one Murmur room runtime.
 *
 * The orchestrator seeds this buffer from PostgreSQL once on room startup and
 * then keeps it current with newly spoken transcript events. Runners consume it
 * as the canonical transcript snapshot source for prompt context.
 */

import { ROLLING_WINDOW_SECONDS, type TranscriptEntry } from "@murmur/shared";

/**
 * Optional runtime hooks for deterministic transcript-buffer behavior.
 */
export interface TranscriptBufferOptions {
  now?: () => number;
  windowSeconds?: number;
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
 * Validates a transcript timestamp and returns its parsed epoch-millisecond value.
 *
 * @param value - Candidate ISO timestamp string.
 * @param label - Human-readable field label for diagnostics.
 * @returns Parsed epoch-millisecond timestamp.
 * @throws {Error} When the timestamp is invalid.
 */
function parseTimestamp(value: string, label: string): number {
  const normalizedValue = normalizeRequiredText(value, label);
  const parsedValue = Date.parse(normalizedValue);

  if (!Number.isFinite(parsedValue)) {
    throw new Error(`${label} must be a valid ISO date string.`);
  }

  return parsedValue;
}

/**
 * Validates a positive rolling-window duration.
 *
 * @param value - Candidate duration in seconds.
 * @returns The validated duration.
 * @throws {Error} When the value is not a positive finite number.
 */
function normalizeWindowSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("windowSeconds must be a positive finite number.");
  }

  return value;
}

/**
 * In-memory rolling transcript buffer for a single room.
 */
export class TranscriptBuffer {
  private readonly entries = new Map<string, TranscriptEntry>();

  private readonly now: () => number;

  private readonly roomId: string;

  private readonly windowSeconds: number;

  /**
   * Creates a transcript buffer scoped to one room.
   *
   * @param roomId - Room identifier whose transcript window is being tracked.
   * @param options - Optional deterministic clock and window overrides.
   */
  public constructor(
    roomId: string,
    options: TranscriptBufferOptions = {},
  ) {
    const now = options.now ?? Date.now;

    if (typeof now !== "function") {
      throw new Error("now must be a function.");
    }

    this.roomId = normalizeRequiredText(roomId, "roomId");
    this.now = now;
    this.windowSeconds = normalizeWindowSeconds(
      options.windowSeconds ?? ROLLING_WINDOW_SECONDS,
    );
  }

  /**
   * Replaces the buffer contents with one validated snapshot.
   *
   * @param snapshot - Seed snapshot loaded from durable storage.
   */
  public seed(snapshot: ReadonlyArray<TranscriptEntry>): void {
    if (!Array.isArray(snapshot)) {
      throw new Error("snapshot must be an array.");
    }

    this.entries.clear();

    for (const [index, entry] of snapshot.entries()) {
      this.insertValidatedEntry(entry, `snapshot[${index}]`);
    }

    this.pruneExpiredEntries();
  }

  /**
   * Adds one transcript entry to the rolling window.
   *
   * @param entry - Newly spoken transcript entry.
   */
  public addEntry(entry: TranscriptEntry): void {
    this.insertValidatedEntry(entry, "entry");
    this.pruneExpiredEntries();
  }

  /**
   * Returns the current rolling transcript snapshot in chronological order.
   *
   * @returns A cloned transcript snapshot for the active rolling window.
   */
  public getSnapshot(): TranscriptEntry[] {
    this.pruneExpiredEntries();

    return Array.from(this.entries.values())
      .sort((left, right) => {
        const leftTimestamp = Date.parse(left.timestamp);
        const rightTimestamp = Date.parse(right.timestamp);

        if (leftTimestamp === rightTimestamp) {
          return left.id.localeCompare(right.id);
        }

        return leftTimestamp - rightTimestamp;
      })
      .map((entry) => ({ ...entry }));
  }

  /**
   * Clears all buffered transcript entries.
   */
  public clear(): void {
    this.entries.clear();
  }

  /**
   * Inserts one validated transcript entry into the internal map.
   *
   * @param entry - Candidate transcript entry.
   * @param label - Field label prefix for diagnostics.
   * @throws {Error} When the entry is malformed or targets another room.
   */
  private insertValidatedEntry(entry: TranscriptEntry, label: string): void {
    if (!entry || typeof entry !== "object") {
      throw new Error(`${label} must be an object.`);
    }

    const normalizedEntry: TranscriptEntry = {
      id: normalizeRequiredText(entry.id, `${label}.id`),
      roomId: normalizeRequiredText(entry.roomId, `${label}.roomId`),
      agentId: normalizeRequiredText(entry.agentId, `${label}.agentId`),
      agentName: normalizeRequiredText(entry.agentName, `${label}.agentName`),
      content: normalizeRequiredText(entry.content, `${label}.content`),
      timestamp: new Date(
        parseTimestamp(entry.timestamp, `${label}.timestamp`),
      ).toISOString(),
      accentColor: normalizeRequiredText(
        entry.accentColor,
        `${label}.accentColor`,
      ),
      wasFiltered: entry.wasFiltered,
    };

    if (normalizedEntry.roomId !== this.roomId) {
      throw new Error(
        `${label}.roomId must match the buffer room "${this.roomId}". Received "${normalizedEntry.roomId}".`,
      );
    }

    if (typeof normalizedEntry.wasFiltered !== "boolean") {
      throw new Error(`${label}.wasFiltered must be a boolean.`);
    }

    if (this.entries.has(normalizedEntry.id)) {
      throw new Error(
        `TranscriptBuffer already contains entry "${normalizedEntry.id}" for room "${this.roomId}".`,
      );
    }

    this.entries.set(normalizedEntry.id, normalizedEntry);
  }

  /**
   * Prunes transcript entries older than the configured rolling window.
   */
  private pruneExpiredEntries(): void {
    const cutoffTimestamp = this.now() - (this.windowSeconds * 1000);

    for (const [entryId, entry] of this.entries.entries()) {
      if (Date.parse(entry.timestamp) < cutoffTimestamp) {
        this.entries.delete(entryId);
      }
    }
  }
}

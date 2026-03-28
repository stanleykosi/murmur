/**
 * Rolling transcript context manager for Murmur agent prompts.
 *
 * This module is the canonical in-memory context window used by the agent
 * orchestrator to keep only the most recent conversation turns for LLM prompt
 * construction. It depends on the shared rolling-window constant from
 * `@murmur/shared` and deliberately fails fast on malformed transcript input so
 * later graph nodes can rely on one validated code path.
 */

import { ROLLING_WINDOW_SECONDS } from "@murmur/shared";

/**
 * Default transcript retention window expressed in milliseconds.
 */
export const DEFAULT_CONTEXT_WINDOW_MS = ROLLING_WINDOW_SECONDS * 1000;

/**
 * Raw transcript entry shape accepted by the context manager.
 */
export interface ContextEntryInput {
  agentName: string;
  content: string;
  timestamp: Date | number | string;
}

/**
 * Optional runtime configuration for a context-manager instance.
 */
export interface ContextManagerOptions {
  windowDurationMs?: number;
  now?: () => number;
}

interface NormalizedContextEntry {
  agentName: string;
  content: string;
  timestampMs: number;
  sequence: number;
}

interface ContextWindowBounds {
  cutoffTimestamp: number;
  currentTimestamp: number;
}

/**
 * Validates a required transcript field and returns its trimmed value.
 *
 * @param value - Raw field value supplied by the caller.
 * @param label - Human-readable field name used in error messages.
 * @returns The trimmed, non-empty string value.
 * @throws {Error} When the field is not a string or is blank after trimming.
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
 * Normalizes transcript content into a single prompt line.
 *
 * Model responses may contain paragraph breaks, but the context window formats
 * one speaker turn per line. Embedded newlines are therefore collapsed into
 * single spaces while preserving the surrounding text.
 *
 * @param content - Raw transcript content supplied by the caller.
 * @returns A trimmed single-line transcript turn.
 */
function normalizeContextContent(content: string): string {
  const normalizedContent = normalizeRequiredText(content, "content");

  return normalizedContent.replace(/\s*[\r\n]+\s*/gu, " ");
}

/**
 * Validates and normalizes a transcript timestamp into epoch milliseconds.
 *
 * @param timestamp - Timestamp supplied by the caller.
 * @returns A finite epoch-millisecond value.
 * @throws {Error} When the timestamp cannot be parsed into a valid instant.
 */
function normalizeTimestamp(timestamp: Date | number | string): number {
  if (timestamp instanceof Date) {
    const timestampMs = timestamp.getTime();

    if (!Number.isFinite(timestampMs)) {
      throw new Error("timestamp must be a valid Date.");
    }

    return timestampMs;
  }

  if (typeof timestamp === "number") {
    if (!Number.isFinite(timestamp)) {
      throw new Error("timestamp must be a finite number.");
    }

    return timestamp;
  }

  if (typeof timestamp === "string") {
    const normalizedTimestamp = timestamp.trim();

    if (normalizedTimestamp.length === 0) {
      throw new Error("timestamp must be a non-empty string.");
    }

    const parsedTimestamp = Date.parse(normalizedTimestamp);

    if (!Number.isFinite(parsedTimestamp)) {
      throw new Error("timestamp must be a valid date string.");
    }

    return parsedTimestamp;
  }

  throw new Error("timestamp must be a Date, number, or ISO date string.");
}

/**
 * Validates runtime options for a context-manager instance.
 *
 * @param options - Optional instance configuration.
 * @returns Fully normalized options with defaults applied.
 * @throws {Error} When the window duration or clock implementation is invalid.
 */
function normalizeOptions(
  options: ContextManagerOptions = {},
): Required<ContextManagerOptions> {
  const windowDurationMs =
    options.windowDurationMs ?? DEFAULT_CONTEXT_WINDOW_MS;

  if (!Number.isInteger(windowDurationMs) || windowDurationMs <= 0) {
    throw new Error("windowDurationMs must be a positive integer.");
  }

  const now = options.now ?? Date.now;

  if (typeof now !== "function") {
    throw new Error("now must be a function.");
  }

  return {
    windowDurationMs,
    now,
  };
}

/**
 * Formats a normalized transcript entry for LLM prompt injection.
 *
 * @param entry - Normalized transcript entry.
 * @returns A single `[Agent]: content` prompt line.
 */
function formatContextEntry(entry: NormalizedContextEntry): string {
  return `[${entry.agentName}]: ${entry.content}`;
}

/**
 * Canonical rolling transcript manager used by Murmur agents.
 *
 * The implementation uses synchronous copy-on-write updates so callers never
 * receive mutable internal state and every read sees a fully pruned snapshot of
 * the transcript window.
 */
export class ContextManager {
  private readonly windowDurationMs: number;

  private readonly now: () => number;

  private entries: NormalizedContextEntry[] = [];

  private nextSequence = 0;

  /**
   * Creates a context manager with a configurable retention window and clock.
   *
   * @param options - Optional retention-window and test-clock overrides.
   */
  public constructor(options: ContextManagerOptions = {}) {
    const normalizedOptions = normalizeOptions(options);

    this.windowDurationMs = normalizedOptions.windowDurationMs;
    this.now = normalizedOptions.now;
  }

  /**
   * Adds one transcript entry to the rolling context window.
   *
   * @param entry - Agent transcript line to retain for prompt construction.
   * @throws {Error} When the entry contains blank text or an invalid timestamp.
   */
  public addEntry(entry: ContextEntryInput): void {
    const agentName = normalizeRequiredText(entry.agentName, "agentName");
    const content = normalizeContextContent(entry.content);
    const timestampMs = normalizeTimestamp(entry.timestamp);
    const windowBounds = this.getWindowBounds();
    const nextEntries = this.pruneExpiredEntries(this.entries, windowBounds);

    if (timestampMs >= windowBounds.cutoffTimestamp) {
      nextEntries.push({
        agentName,
        content,
        timestampMs,
        sequence: this.nextSequence,
      });
      this.nextSequence += 1;
    }

    nextEntries.sort((left, right) => {
      if (left.timestampMs === right.timestampMs) {
        return left.sequence - right.sequence;
      }

      return left.timestampMs - right.timestampMs;
    });

    this.entries = nextEntries;
  }

  /**
   * Returns the current rolling context window formatted for an LLM prompt.
   *
   * Entries older than the configured retention window are pruned before the
   * snapshot is formatted so callers always receive the canonical live context.
   *
   * @returns Newline-delimited `[Agent]: content` lines for recent transcript entries.
   */
  public getContext(): string {
    const windowBounds = this.getWindowBounds();
    const retainedEntries = this.pruneExpiredEntries(this.entries, windowBounds);

    this.entries = retainedEntries;

    return this.selectVisibleEntries(retainedEntries, windowBounds)
      .map(formatContextEntry)
      .join("\n");
  }

  /**
   * Clears all retained transcript entries for the current room context.
   */
  public clear(): void {
    this.entries = [];
    this.nextSequence = 0;
  }

  /**
   * Removes entries that are older than the configured rolling window.
   *
   * @param entries - Snapshot of transcript entries to prune.
   * @param windowBounds - Current lower and upper window timestamps.
   * @returns A new array containing only entries that are not expired.
   */
  private pruneExpiredEntries(
    entries: readonly NormalizedContextEntry[],
    windowBounds: ContextWindowBounds,
  ): NormalizedContextEntry[] {
    return entries.filter(
      (entry) => entry.timestampMs >= windowBounds.cutoffTimestamp,
    );
  }

  /**
   * Returns the entries that belong in the prompt for the current wall clock.
   *
   * Future-dated entries remain buffered in memory so minor cross-host clock
   * skew does not permanently discard them, but they are withheld from the
   * prompt until local time catches up.
   *
   * @param entries - Retained transcript entries that have not expired.
   * @param windowBounds - Current lower and upper window timestamps.
   * @returns A new array containing only entries visible in the live window.
   */
  private selectVisibleEntries(
    entries: readonly NormalizedContextEntry[],
    windowBounds: ContextWindowBounds,
  ): NormalizedContextEntry[] {
    // Inclusive upper bound keeps entries that land exactly at the current time.
    return entries.filter(
      (entry) => entry.timestampMs <= windowBounds.currentTimestamp,
    );
  }

  /**
   * Computes the current inclusive rolling-window bounds.
   *
   * @returns The lower and upper timestamps for the live context window.
   */
  private getWindowBounds(): ContextWindowBounds {
    const currentTimestamp = this.getCurrentTimestamp();

    return {
      currentTimestamp,
      cutoffTimestamp: currentTimestamp - this.windowDurationMs,
    };
  }

  /**
   * Reads the current clock value and fails fast when the injected clock does
   * not return a usable epoch-millisecond number.
   *
   * @returns The current epoch time in milliseconds.
   * @throws {Error} When the configured clock returns a non-finite value.
   */
  private getCurrentTimestamp(): number {
    const currentTimestamp = this.now();

    if (!Number.isFinite(currentTimestamp)) {
      throw new Error("now must return a finite timestamp in milliseconds.");
    }

    return currentTimestamp;
  }
}

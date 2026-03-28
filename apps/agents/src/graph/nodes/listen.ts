/**
 * LangGraph listen node for the Murmur agent loop.
 *
 * The listen node synchronizes the latest transcript snapshot and current floor
 * status into graph state, rebuilds the rolling prompt context, and leaves
 * routing to the graph's conditional edge.
 */

import type { TranscriptEntry } from "@murmur/shared";

import type { AgentGraphBindings, AgentGraphState } from "../state.js";
import { normalizeRequiredText } from "../state.js";

/**
 * Validates one transcript entry from the caller-provided room snapshot.
 *
 * @param entry - Candidate transcript entry.
 * @param index - Snapshot index used in validation messages.
 * @param roomId - Expected room identifier for the snapshot.
 * @returns A normalized transcript entry.
 * @throws {Error} When the entry is malformed or targets the wrong room.
 */
function normalizeTranscriptEntry(
  entry: TranscriptEntry,
  index: number,
  roomId: string,
): TranscriptEntry {
  if (!entry || typeof entry !== "object") {
    throw new Error(`Transcript entry ${index} must be an object.`);
  }

  const normalizedRoomId = normalizeRequiredText(entry.roomId, `transcript[${index}].roomId`);

  if (normalizedRoomId !== roomId) {
    throw new Error(
      `Transcript entry ${index} roomId "${normalizedRoomId}" does not match the current room "${roomId}".`,
    );
  }

  const normalizedTimestamp = normalizeRequiredText(
    entry.timestamp,
    `transcript[${index}].timestamp`,
  );
  const parsedTimestamp = Date.parse(normalizedTimestamp);

  if (!Number.isFinite(parsedTimestamp)) {
    throw new Error(`transcript[${index}].timestamp must be a valid ISO date string.`);
  }

  if (typeof entry.wasFiltered !== "boolean") {
    throw new Error(`transcript[${index}].wasFiltered must be a boolean.`);
  }

  return {
    id: normalizeRequiredText(entry.id, `transcript[${index}].id`),
    roomId: normalizedRoomId,
    agentId: normalizeRequiredText(entry.agentId, `transcript[${index}].agentId`),
    agentName: normalizeRequiredText(
      entry.agentName,
      `transcript[${index}].agentName`,
    ),
    content: normalizeRequiredText(entry.content, `transcript[${index}].content`),
    timestamp: normalizedTimestamp,
    accentColor: normalizeRequiredText(
      entry.accentColor,
      `transcript[${index}].accentColor`,
    ),
    wasFiltered: entry.wasFiltered,
  };
}

/**
 * Normalizes a transcript snapshot, sorts it chronologically, and deduplicates
 * entries by stable transcript identifier.
 *
 * @param snapshot - Raw transcript snapshot supplied by the caller.
 * @param roomId - Expected room identifier for all entries.
 * @returns A chronological, de-duplicated transcript snapshot.
 * @throws {Error} When the snapshot is not an array or contains malformed entries.
 */
export function normalizeTranscriptSnapshot(
  snapshot: TranscriptEntry[],
  roomId: string,
): TranscriptEntry[] {
  if (!Array.isArray(snapshot)) {
    throw new Error("Transcript snapshot must be an array.");
  }

  const normalizedEntries = snapshot
    .map((entry, index) => ({
      entry: normalizeTranscriptEntry(entry, index, roomId),
      snapshotIndex: index,
    }))
    .sort((left, right) => {
      const leftTimestamp = Date.parse(left.entry.timestamp);
      const rightTimestamp = Date.parse(right.entry.timestamp);

      if (leftTimestamp === rightTimestamp) {
        return left.snapshotIndex - right.snapshotIndex;
      }

      return leftTimestamp - rightTimestamp;
    });

  const seenIds = new Set<string>();
  const deduplicatedEntries: TranscriptEntry[] = [];

  for (const { entry } of normalizedEntries) {
    if (seenIds.has(entry.id)) {
      continue;
    }

    seenIds.add(entry.id);
    deduplicatedEntries.push(entry);
  }

  return deduplicatedEntries;
}

/**
 * Rebuilds the rolling context manager from a normalized transcript snapshot.
 *
 * @param bindings - Graph bindings that hold the reusable context manager.
 * @param transcript - Normalized transcript snapshot for the current room.
 */
export function rebuildContextManager(
  bindings: AgentGraphBindings,
  transcript: TranscriptEntry[],
): void {
  bindings.contextManager.clear();

  for (const entry of transcript) {
    bindings.contextManager.addEntry({
      agentName: entry.agentName,
      content: entry.content,
      timestamp: entry.timestamp,
    });
  }
}

/**
 * Creates the `listen` node with the supplied runtime bindings.
 *
 * @param bindings - Caller-owned dependencies for graph side effects.
 * @returns A LangGraph node that synchronizes transcript and floor state.
 */
export function createListenNode(bindings: AgentGraphBindings) {
  return async function listenNode(
    state: AgentGraphState,
  ): Promise<Partial<AgentGraphState>> {
    const roomId = normalizeRequiredText(state.roomId, "state.roomId");

    if (roomId !== bindings.roomId) {
      throw new Error(
        `Graph state roomId "${roomId}" does not match bindings.roomId "${bindings.roomId}".`,
      );
    }

    const [floorStatus, transcriptSnapshot] = await Promise.all([
      bindings.getFloorStatus(),
      bindings.getTranscriptSnapshot(),
    ]);

    if (
      !floorStatus
      || typeof floorStatus !== "object"
      || typeof floorStatus.isFloorHolder !== "boolean"
    ) {
      throw new Error("getFloorStatus() must resolve to an object with isFloorHolder.");
    }

    const normalizedTranscript = normalizeTranscriptSnapshot(
      transcriptSnapshot,
      roomId,
    );

    rebuildContextManager(bindings, normalizedTranscript);

    bindings.logger.debug(
      {
        isFloorHolder: floorStatus.isFloorHolder,
        roomId,
        transcriptEntries: normalizedTranscript.length,
      },
      "Synchronized agent transcript snapshot in listen node.",
    );

    return {
      status: "listening",
      rollingTranscript: normalizedTranscript,
      isFloorHolder: floorStatus.isFloorHolder,
    };
  };
}

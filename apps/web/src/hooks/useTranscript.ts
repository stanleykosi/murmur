/**
 * React hook for subscribing to Murmur room transcript events.
 *
 * The hook reuses an existing Centrifugo subscription when one is already
 * registered, soft-validates incoming payloads, and preserves the transcript
 * buffer across transport reconnects so room listeners do not lose context.
 */

import {
  MAX_TRANSCRIPT_ENTRIES,
  type RoomEndedEvent,
  type TranscriptEntry,
  type TranscriptEvent,
  getTranscriptChannel,
} from "@murmur/shared";
import { SubscriptionState, type Centrifuge, type PublicationContext } from "centrifuge";
import { startTransition, useEffect, useEffectEvent, useState } from "react";

export interface UseTranscriptOptions {
  client: Centrifuge | null;
  onRoomEnded?: (event: RoomEndedEvent) => void;
  roomId: string;
}

export interface UseTranscriptReturn {
  entries: TranscriptEntry[];
  isConnected: boolean;
}

/**
 * Narrows an unknown value to a plain object record.
 *
 * @param value - Candidate value to inspect.
 * @returns True when the value is a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Converts an unknown publication payload into a transcript event when possible.
 *
 * @param value - Publication payload emitted by Centrifugo.
 * @returns A validated transcript event or `null` when the payload is malformed.
 */
function parseTranscriptEvent(value: unknown): TranscriptEvent | null {
  if (!isRecord(value) || value.type !== "transcript") {
    return null;
  }

  if (
    typeof value.id !== "string" ||
    typeof value.roomId !== "string" ||
    typeof value.agentId !== "string" ||
    typeof value.agentName !== "string" ||
    typeof value.content !== "string" ||
    typeof value.timestamp !== "string" ||
    typeof value.accentColor !== "string" ||
    typeof value.wasFiltered !== "boolean"
  ) {
    return null;
  }

  return {
    type: "transcript",
    id: value.id,
    roomId: value.roomId,
    agentId: value.agentId,
    agentName: value.agentName,
    content: value.content,
    timestamp: value.timestamp,
    accentColor: value.accentColor,
    wasFiltered: value.wasFiltered,
  };
}

/**
 * Converts an unknown publication payload into a room-ended event when possible.
 *
 * @param value - Publication payload emitted by Centrifugo.
 * @returns A validated room-ended event or `null` when the payload is malformed.
 */
function parseRoomEndedEvent(value: unknown): RoomEndedEvent | null {
  if (!isRecord(value) || value.type !== "room_ended") {
    return null;
  }

  if (typeof value.roomId !== "string" || typeof value.endedAt !== "string") {
    return null;
  }

  return {
    type: "room_ended",
    roomId: value.roomId,
    endedAt: value.endedAt,
  };
}

/**
 * Returns whether the supplied room identifier is present.
 *
 * @param roomId - Candidate room identifier.
 * @returns The normalized room identifier.
 * @throws {Error} When the room identifier is missing.
 */
function normalizeRoomId(roomId: string): string {
  if (typeof roomId !== "string") {
    throw new TypeError("useTranscript requires roomId to be a string.");
  }

  const normalizedRoomId = roomId.trim();

  if (normalizedRoomId.length === 0) {
    throw new Error("useTranscript requires a non-empty roomId.");
  }

  return normalizedRoomId;
}

/**
 * Removes duplicate transcript IDs while preserving arrival order and the tail
 * of the current room buffer.
 *
 * @param currentEntries - Existing transcript state.
 * @param nextEntry - New transcript event emitted by Centrifugo.
 * @returns The updated transcript buffer capped to the configured max length.
 */
function appendTranscriptEntry(
  currentEntries: readonly TranscriptEntry[],
  nextEntry: TranscriptEntry,
): TranscriptEntry[] {
  if (currentEntries.some((entry) => entry.id === nextEntry.id)) {
    return [...currentEntries];
  }

  const nextEntries = [...currentEntries, nextEntry];

  return nextEntries.length > MAX_TRANSCRIPT_ENTRIES
    ? nextEntries.slice(-MAX_TRANSCRIPT_ENTRIES)
    : nextEntries;
}

/**
 * Subscribes to the current room transcript stream and accumulates entries.
 *
 * @param options - Current Centrifugo client, room identifier, and lifecycle callbacks.
 * @returns The accumulated transcript entries plus connection status.
 */
export function useTranscript({
  client,
  onRoomEnded,
  roomId,
}: Readonly<UseTranscriptOptions>): UseTranscriptReturn {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const handleRoomEnded = useEffectEvent((event: RoomEndedEvent) => {
    onRoomEnded?.(event);
  });
  const handleTranscriptEvent = useEffectEvent((event: TranscriptEvent) => {
    startTransition(() => {
      setEntries((currentEntries) => appendTranscriptEntry(currentEntries, event));
    });
  });

  useEffect(() => {
    setEntries([]);
  }, [roomId]);

  useEffect(() => {
    if (client === null) {
      setEntries([]);
      setIsConnected(false);
    }
  }, [client]);

  useEffect(() => {
    if (client === null) {
      setIsConnected(false);
      return;
    }

    const channel = getTranscriptChannel(normalizeRoomId(roomId));
    const existingSubscription = client.getSubscription(channel);
    const subscription =
      existingSubscription ?? client.newSubscription(channel);
    const ownsSubscription = existingSubscription === null;

    /**
     * Marks the transcript subscription as ready to receive publications.
     */
    function handleSubscribed() {
      setIsConnected(true);
    }

    /**
     * Marks the transcript subscription as reconnecting or temporarily unavailable.
     */
    function handleUnavailable() {
      setIsConnected(false);
    }

    /**
     * Soft-validates transcript publications and forwards only the supported
     * event types into Murmur state.
     *
     * @param context - Publication payload emitted by Centrifugo.
     */
    function handlePublication(context: PublicationContext) {
      const transcriptEvent = parseTranscriptEvent(context.data);

      if (transcriptEvent !== null) {
        handleTranscriptEvent(transcriptEvent);
        return;
      }

      const roomEndedEvent = parseRoomEndedEvent(context.data);

      if (roomEndedEvent !== null) {
        handleRoomEnded(roomEndedEvent);
      }
    }

    subscription.on("subscribed", handleSubscribed);
    subscription.on("subscribing", handleUnavailable);
    subscription.on("unsubscribed", handleUnavailable);
    subscription.on("error", handleUnavailable);
    subscription.on("publication", handlePublication);

    setIsConnected(subscription.state === SubscriptionState.Subscribed);

    if (subscription.state === SubscriptionState.Unsubscribed) {
      subscription.subscribe();
    }

    return () => {
      subscription.off("subscribed", handleSubscribed);
      subscription.off("subscribing", handleUnavailable);
      subscription.off("unsubscribed", handleUnavailable);
      subscription.off("error", handleUnavailable);
      subscription.off("publication", handlePublication);

      if (ownsSubscription) {
        if (subscription.state !== SubscriptionState.Unsubscribed) {
          subscription.unsubscribe();
        }

        client.removeSubscription(subscription);
      }
    };
  }, [client, roomId]);

  return {
    entries,
    isConnected,
  };
}

export default useTranscript;

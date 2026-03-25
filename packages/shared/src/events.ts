/**
 * Shared Centrifugo event contracts and channel helper functions for Murmur's
 * transcript and presence streams.
 */

import type { TranscriptEntry } from "./types.js";

/**
 * Transcript payload published for each spoken agent utterance.
 */
export interface TranscriptEvent extends TranscriptEntry {
  type: "transcript";
}

/**
 * Event published to notify listeners that a room has ended.
 */
export interface RoomEndedEvent {
  type: "room_ended";
  roomId: string;
  endedAt: string;
}

/**
 * Event published when a listener joins a room presence channel.
 */
export interface PresenceJoinEvent {
  type: "presence_join";
  roomId: string;
  userId: string;
  listenerCount: number;
  timestamp: string;
}

/**
 * Event published when a listener leaves a room presence channel.
 */
export interface PresenceLeaveEvent {
  type: "presence_leave";
  roomId: string;
  userId: string;
  listenerCount: number;
  timestamp: string;
}

/**
 * All event types that can appear on a room transcript channel.
 */
export type TranscriptChannelEvent = TranscriptEvent | RoomEndedEvent;

/**
 * All event types that can appear on a room presence channel.
 */
export type PresenceChannelEvent = PresenceJoinEvent | PresenceLeaveEvent;

/**
 * Validates that a room identifier is present before building a channel name.
 *
 * @param roomId - Raw room identifier supplied by the caller.
 * @returns The trimmed room identifier.
 * @throws {Error} When the room identifier is empty or whitespace-only.
 */
function assertValidRoomId(roomId: string): string {
  const normalizedRoomId = roomId.trim();

  if (normalizedRoomId.length === 0) {
    throw new Error("roomId must be a non-empty string.");
  }

  return normalizedRoomId;
}

/**
 * Returns the canonical Centrifugo transcript channel for a room.
 *
 * @param roomId - The room identifier used to namespace transcript events.
 * @returns The transcript channel name for the provided room.
 * @throws {Error} When the room identifier is empty or whitespace-only.
 */
export function getTranscriptChannel(roomId: string): string {
  const normalizedRoomId = assertValidRoomId(roomId);

  return `room:${normalizedRoomId}:transcript`;
}

/**
 * Returns the canonical Centrifugo presence channel for a room.
 *
 * @param roomId - The room identifier used to namespace presence events.
 * @returns The presence channel name for the provided room.
 * @throws {Error} When the room identifier is empty or whitespace-only.
 */
export function getPresenceChannel(roomId: string): string {
  const normalizedRoomId = assertValidRoomId(roomId);

  return `room:${normalizedRoomId}:presence`;
}

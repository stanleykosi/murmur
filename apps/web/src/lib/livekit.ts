/**
 * LiveKit client helpers for Murmur's listener-side realtime audio runtime.
 *
 * This module owns the canonical client configuration used by the web app when
 * joining AI-hosted rooms. It centralizes environment validation, room
 * instantiation defaults, and the Murmur-specific participant identity
 * convention so the room hook can stay focused on connection lifecycle logic.
 */

import { Room, type RoomConnectOptions } from "livekit-client";

const LIVEKIT_ALLOWED_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);
const AGENT_IDENTITY_PREFIX = "agent_";

/**
 * Validates that a LiveKit server URL is present and normalizes it to the
 * websocket form expected by `Room.connect()`.
 *
 * @param rawUrl - Candidate URL string supplied via environment configuration.
 * @param label - Human-readable label used in thrown diagnostics.
 * @returns A normalized absolute websocket URL.
 * @throws {Error} When the URL is missing, malformed, or uses an unsupported protocol.
 */
function normalizeWebSocketUrl(rawUrl: string | undefined, label: string): string {
  const normalizedValue = rawUrl?.trim();

  if (!normalizedValue) {
    throw new Error(`${label} must be configured before realtime audio can connect.`);
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(normalizedValue);
  } catch (error) {
    throw new Error(
      `${label} must be a valid absolute LiveKit URL.`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }

  if (!LIVEKIT_ALLOWED_PROTOCOLS.has(parsedUrl.protocol)) {
    throw new Error(
      `${label} must use the http://, https://, ws://, or wss:// protocol.`,
    );
  }

  if (parsedUrl.protocol === "http:") {
    parsedUrl.protocol = "ws:";
  } else if (parsedUrl.protocol === "https:") {
    parsedUrl.protocol = "wss:";
  }

  return parsedUrl.toString();
}

/**
 * Connection options passed to `Room.connect()` for Murmur listeners.
 *
 * LiveKit's internal initial-connect retries are intentionally disabled so the
 * `useLiveKitRoom` hook can own the retry budget and surface deterministic
 * status to the UI.
 */
export const LIVEKIT_CONNECT_OPTIONS = {
  autoSubscribe: true,
  maxRetries: 0,
} satisfies RoomConnectOptions;

/**
 * Returns the validated LiveKit websocket endpoint for the current runtime.
 *
 * @returns The absolute websocket URL configured for the listener client.
 * @throws {Error} When `NEXT_PUBLIC_LIVEKIT_URL` is missing or invalid.
 */
export function getLiveKitServerUrl(): string {
  return normalizeWebSocketUrl(
    process.env.NEXT_PUBLIC_LIVEKIT_URL,
    "NEXT_PUBLIC_LIVEKIT_URL",
  );
}

/**
 * Creates the canonical LiveKit room instance used by Murmur listeners.
 *
 * The listener experience is audio-only, so adaptive video features remain
 * disabled. Page-leave disconnects stay enabled because tab closes and hard
 * reloads are not guaranteed to run React cleanup.
 *
 * @returns A configured LiveKit room instance ready for connection attempts.
 */
export function createLiveKitRoom(): Room {
  return new Room({
    adaptiveStream: false,
    disconnectOnPageLeave: true,
    dynacast: false,
    stopLocalTrackOnUnpublish: true,
  });
}

/**
 * Extracts the Murmur agent ID from a LiveKit participant identity.
 *
 * Listener identities use the `listener_{id}` shape, while agent identities use
 * `agent_{id}`. Only valid agent identities return an ID so speaking-state
 * mapping can safely ignore all other participants.
 *
 * @param identity - LiveKit participant identity string.
 * @returns The parsed agent ID, or `null` when the identity is not an agent.
 */
export function parseAgentIdFromParticipantIdentity(identity: string): string | null {
  if (typeof identity !== "string" || identity.length === 0) {
    return null;
  }

  if (identity.trim() !== identity || !identity.startsWith(AGENT_IDENTITY_PREFIX)) {
    return null;
  }

  const agentId = identity.slice(AGENT_IDENTITY_PREFIX.length);

  return agentId.length > 0 ? agentId : null;
}

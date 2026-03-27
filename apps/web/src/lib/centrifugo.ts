/**
 * Centrifugo client helpers for Murmur's realtime transcript and presence
 * streams.
 *
 * This module validates the configured websocket endpoint and creates the
 * canonical browser client instance used by the transcript and presence hooks.
 * Token refresh is intentionally delegated to the server-issued 24-hour JWT
 * lifetime instead of introducing a second client refresh path.
 */

import { Centrifuge } from "centrifuge";

const CENTRIFUGO_ALLOWED_PROTOCOLS = new Set(["ws:", "wss:"]);
const CENTRIFUGO_MIN_RECONNECT_DELAY_MS = 500;
const CENTRIFUGO_MAX_RECONNECT_DELAY_MS = 5_000;
const CENTRIFUGO_TIMEOUT_MS = 10_000;

/**
 * Validates that a websocket URL is present and uses the expected scheme.
 *
 * @param rawUrl - Candidate URL string supplied via environment configuration.
 * @param label - Human-readable label used in thrown diagnostics.
 * @returns A normalized absolute websocket URL.
 * @throws {Error} When the URL is missing, malformed, or uses a non-websocket protocol.
 */
function normalizeWebSocketUrl(rawUrl: string | undefined, label: string): string {
  const normalizedValue = rawUrl?.trim();

  if (!normalizedValue) {
    throw new Error(`${label} must be configured before realtime subscriptions can connect.`);
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(normalizedValue);
  } catch (error) {
    throw new Error(
      `${label} must be a valid absolute websocket URL.`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }

  if (!CENTRIFUGO_ALLOWED_PROTOCOLS.has(parsedUrl.protocol)) {
    throw new Error(`${label} must use the ws:// or wss:// protocol.`);
  }

  return parsedUrl.toString();
}

/**
 * Validates that a client JWT token is present before connection.
 *
 * @param token - Candidate JWT issued by the Murmur API.
 * @returns The normalized token string.
 * @throws {Error} When the token is empty or whitespace-only.
 */
function normalizeClientToken(token: string): string {
  if (typeof token !== "string") {
    throw new TypeError("Centrifugo client token must be a string.");
  }

  const normalizedToken = token.trim();

  if (normalizedToken.length === 0) {
    throw new Error("Centrifugo client token must be a non-empty string.");
  }

  return normalizedToken;
}

/**
 * Returns the validated Centrifugo websocket endpoint for the current runtime.
 *
 * @returns The absolute websocket URL configured for the browser client.
 * @throws {Error} When `NEXT_PUBLIC_CENTRIFUGO_URL` is missing or invalid.
 */
export function getCentrifugoWebSocketUrl(): string {
  return normalizeWebSocketUrl(
    process.env.NEXT_PUBLIC_CENTRIFUGO_URL,
    "NEXT_PUBLIC_CENTRIFUGO_URL",
  );
}

/**
 * Creates the canonical Centrifugo browser client for Murmur listeners.
 *
 * @param token - JWT token issued by the Fastify API.
 * @returns A configured Centrifugo client instance.
 * @throws {Error} When the websocket URL or token is invalid.
 */
export function createCentrifugoClient(token: string): Centrifuge {
  return new Centrifuge(getCentrifugoWebSocketUrl(), {
    maxReconnectDelay: CENTRIFUGO_MAX_RECONNECT_DELAY_MS,
    minReconnectDelay: CENTRIFUGO_MIN_RECONNECT_DELAY_MS,
    timeout: CENTRIFUGO_TIMEOUT_MS,
    token: normalizeClientToken(token),
  });
}

/**
 * React hook for owning Murmur's browser-side Centrifugo transport.
 *
 * This hook is intentionally transport-only: it creates a single websocket
 * client per JWT token, mirrors the low-level connection state for the UI, and
 * leaves room-channel subscriptions to the specialized transcript and presence
 * hooks.
 */

import { useEffect, useState } from "react";

import type { Centrifuge } from "centrifuge";

import { createCentrifugoClient } from "@/lib/centrifugo";

export interface UseCentrifugoOptions {
  token: string | null;
}

export interface UseCentrifugoReturn {
  client: Centrifuge | null;
  connectionState: "connecting" | "connected" | "disconnected";
}

/**
 * Returns whether a token string is present and safe to pass to the client
 * factory.
 *
 * @param token - Candidate JWT token supplied by the caller.
 * @returns True when the token is a non-empty string.
 */
function hasUsableToken(token: string | null): token is string {
  return typeof token === "string" && token.trim().length > 0;
}

/**
 * Creates and manages the Centrifugo client used by Murmur's realtime hooks.
 *
 * @param options - Token required to connect the browser websocket client.
 * @returns The current client instance and its transport connection state.
 */
export function useCentrifugo({
  token,
}: Readonly<UseCentrifugoOptions>): UseCentrifugoReturn {
  const [client, setClient] = useState<Centrifuge | null>(null);
  const [connectionState, setConnectionState] = useState<
    "connecting" | "connected" | "disconnected"
  >("disconnected");

  useEffect(() => {
    if (!hasUsableToken(token)) {
      setClient(null);
      setConnectionState("disconnected");
      return;
    }

    const nextClient = createCentrifugoClient(token);

    /**
     * Mirrors Centrifugo's reconnecting state to Murmur's simpler client state
     * contract used by room UI overlays.
     */
    function handleConnecting() {
      setConnectionState("connecting");
    }

    /**
     * Marks the transport as healthy once the websocket handshake completes.
     */
    function handleConnected() {
      setConnectionState("connected");
    }

    /**
     * Marks the transport as disconnected whenever Centrifugo drops the socket.
     */
    function handleDisconnected() {
      setConnectionState("disconnected");
    }

    nextClient.on("connecting", handleConnecting);
    nextClient.on("connected", handleConnected);
    nextClient.on("disconnected", handleDisconnected);

    setClient(nextClient);
    setConnectionState("connecting");
    nextClient.connect();

    return () => {
      nextClient.off("connecting", handleConnecting);
      nextClient.off("connected", handleConnected);
      nextClient.off("disconnected", handleDisconnected);
      nextClient.disconnect();
      setClient((currentClient) =>
        currentClient === nextClient ? null : currentClient,
      );
      setConnectionState("disconnected");
    };
  }, [token]);

  return {
    client,
    connectionState,
  };
}

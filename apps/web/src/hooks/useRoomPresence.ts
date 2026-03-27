/**
 * React hook for subscribing to Murmur listener presence updates.
 *
 * This hook treats Centrifugo's presence stats as the canonical client-side
 * listener count source for live rooms. It keeps the latest known count during
 * reconnects, reuses existing subscriptions when available, and coalesces burst
 * refreshes so join/leave storms do not trigger redundant stats requests.
 */

import { getPresenceChannel } from "@murmur/shared";
import {
  SubscriptionState,
  type Centrifuge,
  type JoinContext,
  type LeaveContext,
  type Subscription,
} from "centrifuge";
import { useEffect, useRef, useState } from "react";

export interface UseRoomPresenceOptions {
  client: Centrifuge | null;
  initialCount?: number;
  roomId: string;
}

export interface UseRoomPresenceReturn {
  isConnected: boolean;
  listenerCount: number;
}

/**
 * Validates and normalizes a room identifier before subscription.
 *
 * @param roomId - Candidate room identifier.
 * @returns The trimmed room identifier.
 * @throws {Error} When the room identifier is missing.
 */
function normalizeRoomId(roomId: string): string {
  if (typeof roomId !== "string") {
    throw new TypeError("useRoomPresence requires roomId to be a string.");
  }

  const normalizedRoomId = roomId.trim();

  if (normalizedRoomId.length === 0) {
    throw new Error("useRoomPresence requires a non-empty roomId.");
  }

  return normalizedRoomId;
}

/**
 * Validates the initial listener count supplied by the room join payload.
 *
 * @param count - Candidate listener count from room data.
 * @returns A safe non-negative integer count.
 * @throws {TypeError} When the count is not a finite integer.
 * @throws {RangeError} When the count is negative.
 */
function normalizeListenerCount(count: number): number {
  if (!Number.isSafeInteger(count)) {
    throw new TypeError("Listener counts must be safe integers.");
  }

  if (count < 0) {
    throw new RangeError("Listener counts cannot be negative.");
  }

  return count;
}

/**
 * Creates a new presence-channel subscription with join/leave events enabled.
 *
 * @param client - Connected Centrifugo client.
 * @param channel - Canonical room presence channel name.
 * @returns A subscription configured for presence refresh triggers.
 */
function createPresenceSubscription(
  client: Centrifuge,
  channel: string,
): Subscription {
  return client.newSubscription(channel, {
    joinLeave: true,
  });
}

/**
 * Subscribes to room presence and keeps the latest listener count in sync.
 *
 * @param options - Current Centrifugo client, room identifier, and initial room count.
 * @returns The current listener count plus subscription health.
 */
export function useRoomPresence({
  client,
  initialCount = 0,
  roomId,
}: Readonly<UseRoomPresenceOptions>): UseRoomPresenceReturn {
  const normalizedInitialCount = normalizeListenerCount(initialCount);
  const [listenerCount, setListenerCount] = useState(normalizedInitialCount);
  const [isConnected, setIsConnected] = useState(false);
  const previousRoomIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (previousRoomIdRef.current === roomId) {
      return;
    }

    previousRoomIdRef.current = roomId;
    setListenerCount(normalizedInitialCount);
  }, [normalizedInitialCount, roomId]);

  useEffect(() => {
    if (client === null) {
      setIsConnected(false);
      return;
    }

    const channel = getPresenceChannel(normalizeRoomId(roomId));
    const existingSubscription = client.getSubscription(channel);
    const subscription =
      existingSubscription ?? createPresenceSubscription(client, channel);
    const ownsSubscription = existingSubscription === null;
    let isDisposed = false;
    let refreshInFlight = false;
    let queuedRefresh = false;

    /**
     * Loads the latest unique-user count from Centrifugo and coalesces bursts
     * of join/leave activity into a single follow-up request.
     */
    async function refreshListenerCount() {
      if (refreshInFlight) {
        queuedRefresh = true;
        return;
      }

      refreshInFlight = true;

      try {
        do {
          queuedRefresh = false;
          const presenceStats = await subscription.presenceStats();

          if (isDisposed) {
            return;
          }

          setListenerCount(normalizeListenerCount(presenceStats.numUsers));
        } while (queuedRefresh);
      } catch (error) {
        if (!isDisposed) {
          console.error("Failed to refresh Murmur room presence.", error);
        }
      } finally {
        refreshInFlight = false;
      }
    }

    /**
     * Marks the presence subscription as ready and eagerly refreshes the latest
     * listener count from the server.
     */
    function handleSubscribed() {
      setIsConnected(true);
      void refreshListenerCount();
    }

    /**
     * Marks the presence subscription as temporarily unavailable while keeping
     * the last known listener count visible.
     */
    function handleUnavailable() {
      setIsConnected(false);
    }

    /**
     * Refreshes the authoritative unique-user count after a listener joins.
     *
     * @param _context - Presence join metadata emitted by Centrifugo.
     */
    function handleJoin(_context: JoinContext) {
      void refreshListenerCount();
    }

    /**
     * Refreshes the authoritative unique-user count after a listener leaves.
     *
     * @param _context - Presence leave metadata emitted by Centrifugo.
     */
    function handleLeave(_context: LeaveContext) {
      void refreshListenerCount();
    }

    subscription.on("subscribed", handleSubscribed);
    subscription.on("subscribing", handleUnavailable);
    subscription.on("unsubscribed", handleUnavailable);
    subscription.on("error", handleUnavailable);
    subscription.on("join", handleJoin);
    subscription.on("leave", handleLeave);

    setIsConnected(subscription.state === SubscriptionState.Subscribed);

    if (subscription.state === SubscriptionState.Unsubscribed) {
      subscription.subscribe();
    } else if (subscription.state === SubscriptionState.Subscribed) {
      void refreshListenerCount();
    }

    return () => {
      isDisposed = true;
      subscription.off("subscribed", handleSubscribed);
      subscription.off("subscribing", handleUnavailable);
      subscription.off("unsubscribed", handleUnavailable);
      subscription.off("error", handleUnavailable);
      subscription.off("join", handleJoin);
      subscription.off("leave", handleLeave);

      if (ownsSubscription) {
        if (subscription.state !== SubscriptionState.Unsubscribed) {
          subscription.unsubscribe();
        }

        client.removeSubscription(subscription);
      }
    };
  }, [client, roomId]);

  return {
    isConnected,
    listenerCount,
  };
}

export default useRoomPresence;

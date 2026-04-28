/**
 * React hook for managing Murmur's listener-side LiveKit room connection.
 *
 * The hook owns connection attempts, retry timing, active-speaker mapping, and
 * strict-mode-safe cleanup. It intentionally exposes the connected `Room`
 * instance so the live-room assembly step can hand it to `RoomAudioRenderer`
 * rather than building a parallel audio playback path.
 */

import {
  ConnectionState as LiveKitConnectionState,
  RoomEvent,
  type Participant,
  type RemoteParticipant,
  type Room,
} from "livekit-client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";

import {
  LIVEKIT_CONNECT_OPTIONS,
  createLiveKitRoom,
  getLiveKitServerUrl,
  parseAgentIdFromParticipantIdentity,
} from "@/lib/livekit";
import type { ConnectionState, LiveKitRetryState } from "@/types";

const LIVEKIT_RETRY_DELAYS_MS = [0, 500, 1_000, 2_000] as const;
const LIVEKIT_CONNECT_TIMEOUT_MS = 12_000;
const INITIAL_RETRY_STATE = {
  phase: "idle",
  attempt: 0,
  maxAttempts: LIVEKIT_RETRY_DELAYS_MS.length,
  nextRetryDelayMs: null,
} satisfies LiveKitRetryState;

export interface UseLiveKitRoomOptions {
  roomId: string;
  token: string | null;
}

export interface UseLiveKitRoomReturn {
  activeSpeakerId: string | null;
  connect: () => Promise<void>;
  connectionState: ConnectionState;
  disconnect: () => void;
  room: Room | null;
  retryState: LiveKitRetryState;
}

/**
 * Validates that a required string input is present before connection.
 *
 * @param value - Candidate string value supplied by the caller.
 * @param label - Human-readable label used in thrown diagnostics.
 * @returns The trimmed string value.
 * @throws {TypeError} When the value is not a string.
 * @throws {Error} When the string is empty.
 */
function normalizeRequiredString(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return normalizedValue;
}

/**
 * Creates an `AbortError`-shaped error object for cancelled sleeps and retries.
 *
 * @returns A normalized abort error.
 */
function createAbortError(): Error {
  const error = new Error("The LiveKit connection attempt was aborted.");
  error.name = "AbortError";
  return error;
}

/**
 * Returns whether a thrown error represents a cancelled async operation.
 *
 * @param error - Unknown error thrown by a cancelled connection flow.
 * @returns True when the error should be treated as an abort signal.
 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Delays the next retry attempt while remaining cancellable by an abort signal.
 *
 * @param delayMs - Delay duration in milliseconds.
 * @param signal - Abort signal tied to the current connection attempt.
 * @returns A promise that resolves after the delay or rejects on abort.
 */
function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }

  if (delayMs === 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);

    function handleAbort() {
      window.clearTimeout(timeoutId);
      signal.removeEventListener("abort", handleAbort);
      reject(createAbortError());
    }

    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

/**
 * Resolves or rejects with the supplied promise, but fails fast if the current
 * connection attempt exceeds Murmur's listener-connect budget.
 *
 * LiveKit can otherwise remain pending for an unbounded period when the
 * websocket endpoint is unreachable or misconfigured, which leaves the room UI
 * stuck on an infinite spinner without surfacing a usable error.
 *
 * @param operation - Room-connection promise for the current attempt.
 * @param timeoutMs - Maximum time to wait before rejecting the attempt.
 * @param signal - Abort signal tied to the current connection generation.
 * @param liveKitUrl - Endpoint being dialed, used in the timeout diagnostic.
 * @returns The resolved operation value.
 */
function withConnectTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  liveKitUrl: string,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      reject(
        new Error(
          `Timed out connecting to LiveKit after ${timeoutMs}ms. Check NEXT_PUBLIC_LIVEKIT_URL and confirm the browser can reach ${liveKitUrl}.`,
        ),
      );
    }, timeoutMs);

    function cleanup() {
      window.clearTimeout(timeoutId);
      signal.removeEventListener("abort", handleAbort);
    }

    function handleAbort() {
      cleanup();
      reject(createAbortError());
    }

    signal.addEventListener("abort", handleAbort, { once: true });

    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Maps LiveKit's connection-state model to Murmur's simpler UI state contract.
 *
 * @param state - Current LiveKit room connection state.
 * @returns The equivalent Murmur connection state.
 */
function mapLiveKitState(state: LiveKitConnectionState): ConnectionState {
  switch (state) {
    case LiveKitConnectionState.Connected:
      return "connected";
    case LiveKitConnectionState.Connecting:
    case LiveKitConnectionState.Reconnecting:
    case LiveKitConnectionState.SignalReconnecting:
      return "connecting";
    case LiveKitConnectionState.Disconnected:
      return "disconnected";
    default:
      return "error";
  }
}

/**
 * Returns the first currently speaking Murmur agent in the supplied room.
 *
 * Listener participants and malformed identities are intentionally ignored so
 * avatar highlighting only reflects agent voices.
 *
 * @param room - LiveKit room whose remote participants should be scanned.
 * @returns The active Murmur agent ID, or `null` when nobody is speaking.
 */
function getActiveSpeakerIdFromParticipants(
  participants: Iterable<Participant>,
): string | null {
  for (const participant of participants) {
    if (!participant.isSpeaking) {
      continue;
    }

    const agentId = parseAgentIdFromParticipantIdentity(participant.identity);

    if (agentId !== null) {
      return agentId;
    }
  }

  return null;
}

/**
 * Returns the currently speaking Murmur agent in the supplied room.
 *
 * LiveKit already maintains a room-level active-speaker list, so the listener
 * UI should follow that canonical signal instead of rebuilding speaker state
 * solely from participant-local events.
 *
 * @param room - LiveKit room whose current active speakers should be scanned.
 * @returns The active Murmur agent ID, or `null` when nobody is speaking.
 */
function getActiveSpeakerId(room: Room): string | null {
  const activeSpeakerId = getActiveSpeakerIdFromParticipants(room.activeSpeakers);

  if (activeSpeakerId !== null) {
    return activeSpeakerId;
  }

  return getActiveSpeakerIdFromParticipants(room.remoteParticipants.values());
}

/**
 * Creates a cleanup function that detaches the supplied participant listeners.
 *
 * @param room - LiveKit room observed by the current hook instance.
 * @param operationId - Connection generation that owns the room listeners.
 * @param currentOperationIdRef - Mutable ref containing the active generation.
 * @param setConnectionState - State setter for Murmur's connection state.
 * @param setActiveSpeakerId - State setter for the highlighted speaking agent.
 * @param setRoomState - State setter for the exposed connected room instance.
 * @returns A teardown function that removes all room and participant listeners.
 */
function attachRoomObservers(
  room: Room,
  operationId: number,
  currentOperationIdRef: MutableRefObject<number>,
  setConnectionState: Dispatch<SetStateAction<ConnectionState>>,
  setActiveSpeakerId: Dispatch<SetStateAction<string | null>>,
  setRoomState: Dispatch<SetStateAction<Room | null>>,
) {
  /**
   * Returns whether the observed room still belongs to the current connection
   * generation. Stale rooms are ignored after retries, reconnects, or cleanup.
   */
  function isCurrentObservedRoom(): boolean {
    return currentOperationIdRef.current === operationId;
  }

  /**
   * Recomputes the currently speaking Murmur agent from the room participant map.
   */
  function updateActiveSpeaker() {
    if (!isCurrentObservedRoom()) {
      return;
    }

    setActiveSpeakerId(getActiveSpeakerId(room));
  }

  /**
   * Handles newly connected remote participants by tracking their speaking state.
   *
   * @param participant - Remote participant that joined the room.
   */
  function handleParticipantConnected(_participant: RemoteParticipant) {
    updateActiveSpeaker();
  }

  /**
   * Handles remote participant removal and clears stale speaker highlights.
   *
   * @param participant - Remote participant that left the room.
   */
  function handleParticipantDisconnected(participant: RemoteParticipant) {
    void participant;
    updateActiveSpeaker();
  }

  /**
   * Mirrors LiveKit reconnecting states to Murmur's simpler connection model.
   */
  function handleRoomReconnecting() {
    if (!isCurrentObservedRoom()) {
      return;
    }

    setConnectionState("connecting");
    setActiveSpeakerId(null);
  }

  /**
   * Restores the connected state once LiveKit has finished reconnecting.
   */
  function handleRoomReconnected() {
    if (!isCurrentObservedRoom()) {
      return;
    }

    setConnectionState("connected");
    updateActiveSpeaker();
  }

  /**
   * Clears the exposed room when LiveKit disconnects permanently.
   */
  function handleRoomDisconnected() {
    if (!isCurrentObservedRoom()) {
      return;
    }

    setConnectionState("disconnected");
    setActiveSpeakerId(null);
    setRoomState(null);
  }

  /**
   * Mirrors LiveKit's room-level active-speaker list to the stage UI.
   */
  function handleActiveSpeakersChanged() {
    updateActiveSpeaker();
  }

  room.on(RoomEvent.ParticipantConnected, handleParticipantConnected);
  room.on(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
  room.on(RoomEvent.ActiveSpeakersChanged, handleActiveSpeakersChanged);
  room.on(RoomEvent.Reconnecting, handleRoomReconnecting);
  room.on(RoomEvent.SignalReconnecting, handleRoomReconnecting);
  room.on(RoomEvent.Reconnected, handleRoomReconnected);
  room.on(RoomEvent.Disconnected, handleRoomDisconnected);

  updateActiveSpeaker();

  return () => {
    room.off(RoomEvent.ParticipantConnected, handleParticipantConnected);
    room.off(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
    room.off(RoomEvent.ActiveSpeakersChanged, handleActiveSpeakersChanged);
    room.off(RoomEvent.Reconnecting, handleRoomReconnecting);
    room.off(RoomEvent.SignalReconnecting, handleRoomReconnecting);
    room.off(RoomEvent.Reconnected, handleRoomReconnected);
    room.off(RoomEvent.Disconnected, handleRoomDisconnected);
  };
}

/**
 * Connects a listener to a LiveKit room and surfaces speaking-state updates.
 *
 * @param options - Room identifier and listener access token returned by the API.
 * @returns The connected room instance plus Murmur-specific connection metadata.
 */
export function useLiveKitRoom({
  roomId,
  token,
}: Readonly<UseLiveKitRoomOptions>): UseLiveKitRoomReturn {
  const [room, setRoom] = useState<Room | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [activeSpeakerId, setActiveSpeakerId] = useState<string | null>(null);
  const [retryState, setRetryState] = useState<LiveKitRetryState>(INITIAL_RETRY_STATE);
  const roomRef = useRef<Room | null>(null);
  const roomCleanupRef = useRef<(() => void) | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const operationIdRef = useRef(0);

  /**
   * Disconnects and forgets the currently tracked room, whether it is still
   * connecting or already fully connected.
   */
  function teardownCurrentRoom() {
    const currentCleanup = roomCleanupRef.current;
    const currentRoom = roomRef.current;

    roomCleanupRef.current = null;
    roomRef.current = null;

    currentCleanup?.();

    if (currentCleanup === null && currentRoom !== null) {
      void currentRoom.disconnect();
    }

    setRoom(null);
    setActiveSpeakerId(null);
  }

  const disconnect = useCallback(() => {
    operationIdRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    teardownCurrentRoom();
    setConnectionState("disconnected");
    setRetryState(INITIAL_RETRY_STATE);
  }, []);

  const connect = useCallback(async () => {
    operationIdRef.current += 1;
    const operationId = operationIdRef.current;

    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    teardownCurrentRoom();

    let liveKitUrl: string;
    let normalizedToken: string;

    try {
      void normalizeRequiredString(roomId, "roomId");
      normalizedToken = normalizeRequiredString(token ?? "", "token");
      liveKitUrl = getLiveKitServerUrl();
    } catch (error) {
      setConnectionState("error");
      setRetryState({
        ...INITIAL_RETRY_STATE,
        phase: "failed",
      });
      throw error;
    }
    const abortController = new AbortController();

    abortControllerRef.current = abortController;
    setConnectionState("connecting");
    setActiveSpeakerId(null);
    setRetryState({
      ...INITIAL_RETRY_STATE,
      phase: "connecting",
      attempt: 1,
    });

    let lastError: unknown = null;

    for (const [attemptIndex, delayMs] of LIVEKIT_RETRY_DELAYS_MS.entries()) {
      const attempt = attemptIndex + 1;

      if (delayMs > 0) {
        setRetryState({
          ...INITIAL_RETRY_STATE,
          phase: "waiting",
          attempt,
          nextRetryDelayMs: delayMs,
        });
      }

      try {
        await waitForDelay(delayMs, abortController.signal);
      } catch (error) {
        if (isAbortError(error) || operationIdRef.current !== operationId) {
          return;
        }

        throw error;
      }

      if (abortController.signal.aborted || operationIdRef.current !== operationId) {
        return;
      }

      setRetryState({
        ...INITIAL_RETRY_STATE,
        phase: "connecting",
        attempt,
      });

      const nextRoom = createLiveKitRoom();
      const detachRoomObservers = attachRoomObservers(
        nextRoom,
        operationId,
        operationIdRef,
        setConnectionState,
        setActiveSpeakerId,
        setRoom,
      );

      roomRef.current = nextRoom;
      roomCleanupRef.current = () => {
        detachRoomObservers();
        void nextRoom.disconnect();
      };

      try {
        await withConnectTimeout(
          nextRoom.connect(
            liveKitUrl,
            normalizedToken,
            LIVEKIT_CONNECT_OPTIONS,
          ),
          LIVEKIT_CONNECT_TIMEOUT_MS,
          abortController.signal,
          liveKitUrl,
        );

        if (abortController.signal.aborted || operationIdRef.current !== operationId) {
          teardownCurrentRoom();
          return;
        }

        setRoom(nextRoom);
        setConnectionState(mapLiveKitState(nextRoom.state));
        setActiveSpeakerId(getActiveSpeakerId(nextRoom));
        setRetryState(INITIAL_RETRY_STATE);
        void nextRoom.startAudio().catch(() => undefined);
        return;
      } catch (error) {
        lastError = error;

        if (roomRef.current === nextRoom) {
          roomRef.current = null;
        }

        if (roomCleanupRef.current !== null) {
          const cleanup = roomCleanupRef.current;
          roomCleanupRef.current = null;
          cleanup();
        } else {
          detachRoomObservers();
          void nextRoom.disconnect();
        }

        if (abortController.signal.aborted || operationIdRef.current !== operationId) {
          return;
        }
      }
    }

    setConnectionState("error");
    setActiveSpeakerId(null);
    setRoom(null);
    setRetryState({
      ...INITIAL_RETRY_STATE,
      phase: "failed",
      attempt: LIVEKIT_RETRY_DELAYS_MS.length,
    });

    throw lastError instanceof Error
      ? lastError
      : new Error("LiveKit connection failed after all retry attempts.");
  }, [roomId, token]);

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return {
    activeSpeakerId,
    connect,
    connectionState,
    disconnect,
    room,
    retryState,
  };
}

"use client";

/**
 * Canonical realtime room runtime for the Murmur listener experience.
 *
 * Purpose:
 * Owns the protected room-join handshake, LiveKit audio connection, Centrifugo
 * transcript/presence subscriptions, listener-side audio controls, and the
 * in-room auth gate for public room URLs.
 *
 * Scope:
 * This component is the single client-side assembly point for the live-room
 * route. It intentionally uses the room returned by `joinRoom()` as the only
 * rendered room payload and does not preserve the older preview-deck path.
 */

import { RoomAudioRenderer } from "@livekit/components-react";
import { useAuth } from "@clerk/nextjs";
import type { RoomEndedEvent } from "@murmur/shared";
import { RoomEvent } from "livekit-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  startTransition,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useToast } from "@/components/ui/Toast";
import Button from "@/components/ui/Button";
import {
  ApiClientError,
  joinRoom,
  leaveRoom,
} from "@/lib/api";
import { buildAuthRedirectHref } from "@/lib/auth-redirect";
import { cn } from "@/lib/utils";
import type { Room } from "@/types";

import useCentrifugo from "@/hooks/useCentrifugo";
import useLiveKitRoom from "@/hooks/useLiveKitRoom";
import useRoomPresence from "@/hooks/useRoomPresence";
import useTranscript from "@/hooks/useTranscript";
import AgentStage from "./AgentStage";
import AudioControls from "./AudioControls";
import RoomHeader from "./RoomHeader";
import TranscriptPanel from "./TranscriptPanel";

const ROOM_ENDED_REDIRECT_DELAY_SECONDS = 5;
const ROOM_AUTH_TOKEN_TIMEOUT_MS = 10_000;
const ROOM_JOIN_TIMEOUT_MS = 15_000;
const ROOM_TRANSPORT_CONNECT_TIMEOUT_MS = 15_000;
const ROOM_INITIAL_LOADING_TIMEOUT_MS = 15_000;

/**
 * Props for the live-room runtime.
 */
export interface LiveRoomProps {
  roomId: string;
}

/**
 * Status-panel props shared by the auth gate, connection overlay, and retry UI.
 */
interface StatusPanelProps {
  actions?: ReactNode;
  className?: string;
  description: string;
  eyebrow: string;
  title: string;
}

/**
 * Options controlling listener leave cleanup behavior.
 */
interface LeaveRoomOptions {
  clearState: boolean;
  preferCachedAuth: boolean;
  silent: boolean;
}

/**
 * Narrows unknown errors into a stable `Error` instance for the UI.
 *
 * @param error - Unknown value thrown by a join, leave, or transport call.
 * @returns A normalized error instance for display and logging.
 */
function normalizeRuntimeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error("The live room failed with an unknown error.");
}

/**
 * Normalizes a Clerk session token so room lifecycle requests can reuse it.
 *
 * @param token - Candidate Clerk token returned by `getToken()`.
 * @returns The trimmed token or `null` when the token is absent/blank.
 */
function normalizeSessionToken(token: string | null | undefined): string | null {
  if (typeof token !== "string") {
    return null;
  }

  const normalizedToken = token.trim();

  return normalizedToken.length > 0 ? normalizedToken : null;
}

/**
 * Returns a user-facing description for the current room runtime failure.
 *
 * @param error - Latest handled runtime error.
 * @returns Concise copy that keeps transport and API failures understandable.
 */
function getRuntimeErrorDescription(error: Error): string {
  if (error instanceof ApiClientError) {
    if (error.statusCode === 401) {
      return "Your listener session is no longer valid. Sign in again to rejoin the room.";
    }

    return error.message;
  }

  return error.message;
}

/**
 * Renders the decorative signal glyph used by live-room status states.
 *
 * @returns A lightweight SVG used by auth, loading, and error panels.
 */
function StatusSignalGlyph() {
  return (
    <svg
      className="room-live-status__glyph"
      aria-hidden="true"
      viewBox="0 0 88 88"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="44" cy="44" r="7" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="44" cy="44" r="18" stroke="currentColor" strokeWidth="1.5" opacity="0.72" />
      <circle cx="44" cy="44" r="30" stroke="currentColor" strokeWidth="1.5" opacity="0.34" />
      <path
        d="M44 10v10M44 68v10M10 44h10M68 44h10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Reusable room-status panel used for both empty-shell and overlay states.
 *
 * @param props - Content and action controls for the current room state.
 * @returns A styled status panel for room auth, connection, or failure states.
 */
function StatusPanel({
  actions,
  className,
  description,
  eyebrow,
  title,
}: Readonly<StatusPanelProps>) {
  return (
    <section className={cn("room-live-status glass-card", className)}>
      <div className="room-live-status__visual" aria-hidden="true">
        <span className="room-live-status__halo room-live-status__halo--outer" />
        <span className="room-live-status__halo room-live-status__halo--inner" />
        <StatusSignalGlyph />
      </div>

      <div className="room-live-status__copy">
        <span className="section-label">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>

      {actions ? <div className="room-live-status__actions">{actions}</div> : null}
    </section>
  );
}

/**
 * Renders the realtime room runtime and handles listener-side room lifecycle.
 *
 * @param props - Room identifier from the current route segment.
 * @returns The assembled live-room experience or an in-room fallback state.
 */
export default function LiveRoom({
  roomId,
}: Readonly<LiveRoomProps>) {
  const router = useRouter();
  const { pushToast } = useToast();
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [roomData, setRoomData] = useState<Room | null>(null);
  const [livekitToken, setLivekitToken] = useState<string | null>(null);
  const [centrifugoToken, setCentrifugoToken] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);
  const [joinError, setJoinError] = useState<Error | null>(null);
  const [isLeaving, setIsLeaving] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [connectSequence, setConnectSequence] = useState(0);
  const [hasConnectedOnce, setHasConnectedOnce] = useState(false);
  const [roomEndedAt, setRoomEndedAt] = useState<string | null>(null);
  const [redirectCountdown, setRedirectCountdown] = useState(
    ROOM_ENDED_REDIRECT_DELAY_SECONDS,
  );
  const [canPlayAudio, setCanPlayAudio] = useState(true);
  const autoJoinTriggeredRef = useRef(false);
  const joinOperationIdRef = useRef(0);
  const authTokenRef = useRef<string | null>(null);
  const hasJoinedRoomRef = useRef(false);
  const hasLeftRoomRef = useRef(false);
  const leaveRequestRef = useRef<Promise<void> | null>(null);
  const roomPath = `/room/${roomId}`;
  const signInHref = buildAuthRedirectHref("/sign-in", roomPath);
  const signUpHref = buildAuthRedirectHref("/sign-up", roomPath);
  const {
    activeSpeakerId,
    connect,
    connectionState,
    disconnect,
    room: liveKitRoom,
  } = useLiveKitRoom({
    roomId,
    token: livekitToken,
  });
  const {
    client: centrifugoClient,
  } = useCentrifugo({
    token: centrifugoToken,
  });
  const {
    isConnected: transcriptConnected,
    entries: transcriptEntries,
  } = useTranscript({
    client: centrifugoClient,
    onRoomEnded: handleRoomEndedEvent,
    roomId,
  });
  const {
    isConnected: presenceConnected,
    listenerCount: liveListenerCount,
  } = useRoomPresence({
    client: centrifugoClient,
    initialCount: roomData?.listenerCount ?? 0,
    roomId,
  });

  /**
   * Returns the best available live listener count for the current room.
   */
  const listenerCount =
    roomData === null
      ? 0
      : presenceConnected
        ? liveListenerCount
        : roomData.listenerCount;

  /**
   * Fails fast when the protected join handshake exceeds Murmur's room-access
   * budget so listeners do not remain trapped behind an indefinite loading
   * panel with no diagnostics.
   *
   * @param operation - Pending join-handshake operation.
   * @returns The resolved join result.
   */
  const withJoinTimeout = useEffectEvent(async <T,>(operation: Promise<T>): Promise<T> =>
    await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        window.setTimeout(() => {
          reject(
            new Error(
              `Timed out finalizing the room join after ${ROOM_JOIN_TIMEOUT_MS}ms. The API is reachable, but the browser did not finish entering the live room.`,
            ),
          );
        }, ROOM_JOIN_TIMEOUT_MS);
      }),
    ]));

  /**
   * Fails fast when Clerk token resolution stalls so the room bootstrap cannot
   * hang forever before the protected join request even starts.
   *
   * @param operation - Pending Clerk token request.
   * @returns The resolved token value.
   */
  const withAuthTokenTimeout = useEffectEvent(async (
    operation: Promise<string | null>,
  ): Promise<string | null> =>
    await Promise.race([
      operation,
      new Promise<string | null>((_resolve, reject) => {
        window.setTimeout(() => {
          reject(
            new Error(
              `Timed out resolving the Clerk session token after ${ROOM_AUTH_TOKEN_TIMEOUT_MS}ms. The browser never finished preparing room authorization.`,
            ),
          );
        }, ROOM_AUTH_TOKEN_TIMEOUT_MS);
      }),
    ]));

  /**
   * Performs the canonical best-effort leave flow and prevents duplicate leave
   * submissions across explicit navigation, room-end handling, and unmount.
   *
   * @param options - Controls whether local room state should be cleared and whether failures should toast.
   */
  const resolveLeaveAuthToken = useEffectEvent(async (
    preferCachedAuth: boolean,
  ) => {
    if (preferCachedAuth) {
      return authTokenRef.current;
    }

    const freshToken = normalizeSessionToken(
      await withAuthTokenTimeout(getToken()),
    );

    if (freshToken !== null) {
      authTokenRef.current = freshToken;
      return freshToken;
    }

    return authTokenRef.current;
  });

  const performLeave = useEffectEvent(async ({
    clearState,
    preferCachedAuth,
    silent,
  }: LeaveRoomOptions) => {
    if (!hasJoinedRoomRef.current || hasLeftRoomRef.current) {
      return;
    }

    if (leaveRequestRef.current !== null) {
      await leaveRequestRef.current;
      return;
    }

    joinOperationIdRef.current += 1;
    disconnect();

    if (clearState) {
      setLivekitToken(null);
      setCentrifugoToken(null);
    }

    leaveRequestRef.current = (async () => {
      try {
        const leaveAuthToken = await resolveLeaveAuthToken(preferCachedAuth);

        await leaveRoom(roomId, {
          token: leaveAuthToken,
        });

        hasJoinedRoomRef.current = false;
        hasLeftRoomRef.current = true;
        authTokenRef.current = null;
      } catch (error) {
        if (!silent) {
          pushToast({
            description:
              "You left the room, but listener cleanup did not fully complete. Counts may take a moment to settle.",
            variant: "warning",
          });
        }

        console.error("Failed to leave Murmur room cleanly.", error);
      } finally {
        leaveRequestRef.current = null;
      }
    })();

    await leaveRequestRef.current;
  });

  /**
   * Redirects the listener to the lobby after a room has ended.
   */
  const redirectToLobbyAfterRoomEnd = useEffectEvent(() => {
    pushToast({
      description: "The room has ended. Returning you to the lobby.",
      variant: "info",
    });

    startTransition(() => {
      router.push("/lobby");
    });
  });

  /**
   * Handles transcript-level room-ended events from Centrifugo.
   *
   * @param event - Room-ended event emitted on the room transcript stream.
   */
  function handleRoomEndedEvent(event: RoomEndedEvent) {
    if (roomEndedAt !== null) {
      return;
    }

    setRoomEndedAt(event.endedAt);
    setRedirectCountdown(ROOM_ENDED_REDIRECT_DELAY_SECONDS);
    void performLeave({
      clearState: true,
      preferCachedAuth: false,
      silent: true,
    });
  }

  /**
   * Runs the protected room join handshake and prepares the LiveKit transport.
   *
   * The join response is committed before the LiveKit connect effect runs so
   * the UI can render room details immediately while the audio transport
   * finishes connecting in the background.
   */
  const runJoinFlow = useCallback(async () => {
    const operationId = joinOperationIdRef.current + 1;
    joinOperationIdRef.current = operationId;
    setIsJoining(true);
    setJoinError(null);
    setRoomEndedAt(null);
    setRedirectCountdown(ROOM_ENDED_REDIRECT_DELAY_SECONDS);
    setHasConnectedOnce(false);

    // A full retry always tears down the current transport before requesting
    // fresh room tokens so the page does not drift into a split-brain state.
    disconnect();
    setLivekitToken(null);
    setCentrifugoToken(null);

    try {
      const freshAuthToken = normalizeSessionToken(
        await withAuthTokenTimeout(getToken()),
      );
      const authToken = freshAuthToken ?? authTokenRef.current;
      const joinResponse = await withJoinTimeout(
        joinRoom(roomId, {
          token: authToken,
        }),
      );

      if (joinOperationIdRef.current !== operationId) {
        return;
      }

      authTokenRef.current = authToken;
      hasJoinedRoomRef.current = true;
      hasLeftRoomRef.current = false;

      setRoomData(joinResponse.room);
      setLivekitToken(joinResponse.livekitToken);
      setCentrifugoToken(joinResponse.centrifugoToken);
      setConnectSequence((currentSequence) => currentSequence + 1);
    } catch (error) {
      if (joinOperationIdRef.current !== operationId) {
        return;
      }

      setJoinError(normalizeRuntimeError(error));
    } finally {
      if (joinOperationIdRef.current === operationId) {
        setIsJoining(false);
      }
    }
  }, [disconnect, getToken, roomId, withAuthTokenTimeout, withJoinTimeout]);

  /**
   * Re-runs the full room join sequence after an explicit retry request.
   */
  const handleRetryJoin = useCallback(async () => {
    autoJoinTriggeredRef.current = true;
    await runJoinFlow();
  }, [runJoinFlow]);

  /**
   * Leaves the room and returns the listener to the lobby.
   */
  const handleLeaveRoom = useEffectEvent(async () => {
    setIsLeaving(true);

    await performLeave({
      clearState: true,
      preferCachedAuth: false,
      silent: false,
    });

    startTransition(() => {
      router.push("/lobby");
    });
  });

  /**
   * Attempts to satisfy browser autoplay restrictions after the room connects.
   */
  const handleStartAudio = useEffectEvent(async () => {
    if (liveKitRoom === null) {
      return;
    }

    try {
      await liveKitRoom.startAudio();
      setCanPlayAudio(liveKitRoom.canPlaybackAudio);
    } catch (error) {
      pushToast({
        description:
          "Audio playback is still blocked in this browser. Try interacting with the page again.",
        variant: "warning",
      });
      console.error("Failed to start Murmur room audio playback.", error);
    }
  });

  useEffect(() => {
    if (!isLoaded || !isSignedIn || roomEndedAt !== null) {
      return;
    }

    if (autoJoinTriggeredRef.current) {
      return;
    }

    autoJoinTriggeredRef.current = true;
    void runJoinFlow();
  }, [isLoaded, isSignedIn, roomEndedAt, runJoinFlow]);

  useEffect(() => {
    if (connectSequence === 0 || livekitToken === null || roomEndedAt !== null) {
      return;
    }

    let isDisposed = false;

    void (async () => {
      try {
        await connect();

        if (!isDisposed) {
          setJoinError(null);
        }
      } catch (error) {
        if (!isDisposed) {
          setJoinError(normalizeRuntimeError(error));
        }
      }
    })();

    return () => {
      isDisposed = true;
    };
  }, [connect, connectSequence, livekitToken, roomEndedAt]);

  useEffect(() => {
    if (connectionState !== "connected") {
      return;
    }

    setHasConnectedOnce(true);
    setJoinError(null);
  }, [connectionState]);

  useEffect(() => {
    if (
      roomData === null ||
      roomEndedAt !== null ||
      isLeaving ||
      connectionState !== "connecting"
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setJoinError(
        new Error(
          `Timed out establishing the live audio transport after ${ROOM_TRANSPORT_CONNECT_TIMEOUT_MS}ms. The room join succeeded, but LiveKit did not finish connecting in the browser.`,
        ),
      );
    }, ROOM_TRANSPORT_CONNECT_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [connectionState, isLeaving, roomData, roomEndedAt]);

  useEffect(() => {
    if (roomEndedAt === null) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setRedirectCountdown((currentCountdown) =>
        currentCountdown > 0 ? currentCountdown - 1 : 0,
      );
    }, 1_000);
    const timeoutId = window.setTimeout(() => {
      redirectToLobbyAfterRoomEnd();
    }, ROOM_ENDED_REDIRECT_DELAY_SECONDS * 1_000);

    return () => {
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
    };
  }, [redirectToLobbyAfterRoomEnd, roomEndedAt]);

  useEffect(() => {
    function handlePageHide() {
      void performLeave({
        clearState: false,
        preferCachedAuth: true,
        silent: true,
      });
    }

    window.addEventListener("pagehide", handlePageHide);

    return () => {
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, [performLeave]);

  useEffect(() => {
    return () => {
      void performLeave({
        clearState: false,
        preferCachedAuth: false,
        silent: true,
      });
    };
  }, [performLeave]);

  useEffect(() => {
    if (liveKitRoom === null) {
      setCanPlayAudio(true);
      return;
    }

    const currentRoom = liveKitRoom;

    setCanPlayAudio(currentRoom.canPlaybackAudio);

    function handleAudioPlaybackStatusChanged() {
      setCanPlayAudio(currentRoom.canPlaybackAudio);
    }

    currentRoom.on(RoomEvent.AudioPlaybackStatusChanged, handleAudioPlaybackStatusChanged);

    return () => {
      currentRoom.off(RoomEvent.AudioPlaybackStatusChanged, handleAudioPlaybackStatusChanged);
    };
  }, [liveKitRoom]);

  const showAuthGate = isLoaded && !isSignedIn;
  const showInitialLoadingState =
    !isLoaded ||
    (isSignedIn &&
      roomData === null &&
      joinError === null &&
      (isJoining || !autoJoinTriggeredRef.current));
  const connectionDropped =
    roomData !== null &&
    hasConnectedOnce &&
    !isLeaving &&
    roomEndedAt === null &&
    (connectionState === "disconnected" || connectionState === "error");
  const effectiveError = joinError ?? (connectionDropped
    ? new Error("The live audio connection was lost. Rejoin the room to continue listening.")
    : null);
  const showAudioPermissionPrompt =
    liveKitRoom !== null &&
    connectionState === "connected" &&
    !canPlayAudio &&
    roomEndedAt === null;
  const showConnectionOverlay =
    roomData !== null &&
    roomEndedAt === null &&
    !isLeaving &&
    (isJoining || connectionState === "connecting" || effectiveError !== null);

  useEffect(() => {
    if (!showInitialLoadingState || joinError !== null) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setJoinError(
        new Error(
          `Timed out leaving the room bootstrap screen after ${ROOM_INITIAL_LOADING_TIMEOUT_MS}ms. The browser never completed the client-side room join bootstrap.`,
        ),
      );
    }, ROOM_INITIAL_LOADING_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [joinError, showInitialLoadingState]);

  if (showAuthGate) {
    return (
      <div className="room-live-shell" data-testid="live-room">
        <StatusPanel
          eyebrow="Listener access"
          title="Sign in to join this live room"
          description="Room links stay public so you can discover the conversation first, but listening in requires a Murmur account."
          actions={
            <>
              <Link
                href={signInHref}
                className="ui-button ui-button--primary ui-button--lg"
              >
                Sign in to join
              </Link>
              <Link
                href={signUpHref}
                className="ui-button ui-button--ghost ui-button--lg"
              >
                Create account
              </Link>
            </>
          }
        />
      </div>
    );
  }

  if (effectiveError !== null && roomData === null) {
    return (
      <div className="room-live-shell" data-testid="live-room">
        <StatusPanel
          eyebrow="Connection problem"
          title="Unable to join this live room"
          description={getRuntimeErrorDescription(effectiveError)}
          actions={
            <>
              <Button size="lg" onClick={() => void handleRetryJoin()}>
                Retry room
              </Button>
              <Link
                href="/lobby"
                className="ui-button ui-button--ghost ui-button--lg"
              >
                Return to lobby
              </Link>
            </>
          }
        />
      </div>
    );
  }

  if (showInitialLoadingState) {
    return (
      <div className="room-live-shell" data-testid="live-room">
        <StatusPanel
          eyebrow={!isLoaded ? "Checking access" : "Joining room"}
          title={!isLoaded ? "Preparing your listener session" : "Connecting to the live room"}
          description={
            !isLoaded
              ? "Murmur is confirming your session before it requests room access."
              : "Fetching room access and bringing the live audio transport online now."
          }
        />
      </div>
    );
  }

  if (roomData === null) {
    return (
      <div className="room-live-shell" data-testid="live-room">
        <StatusPanel
          eyebrow="Room standby"
          title="This room is getting ready"
          description="The room is live, but listener access is not ready yet. Retry in a moment."
          actions={
            <Button size="lg" onClick={() => void handleRetryJoin()}>
              Retry room
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="room-live-shell" data-testid="live-room">
      <RoomHeader
        title={roomData.title}
        topic={roomData.topic}
        listenerCount={listenerCount}
        isLeaving={isLeaving}
        onLeave={() => void handleLeaveRoom()}
      />

      <div className="room-layout">
        <div className="room-live-shell__stage-column">
          <AgentStage
            agents={roomData.agents}
            activeSpeakerId={activeSpeakerId}
            className="fade-up"
          />

          {showAudioPermissionPrompt ? (
            <section className="room-audio-permission glass-card fade-up">
              <div className="room-audio-permission__copy">
                <span className="section-label">Audio blocked</span>
                <h2>Allow playback to hear the room</h2>
                <p>
                  Your browser is holding audio behind a gesture. Start playback
                  once and Murmur will keep the stream live from here.
                </p>
              </div>

              <Button onClick={() => void handleStartAudio()}>
                Allow audio playback
              </Button>
            </section>
          ) : null}
        </div>

        <TranscriptPanel
          accessibilityMode
          className="fade-up"
          entries={transcriptEntries}
          isConnected={transcriptConnected}
        />
      </div>

      <AudioControls
        disabled={roomEndedAt !== null || connectionState !== "connected"}
        isLeaving={isLeaving}
        isMuted={isMuted}
        onLeave={() => void handleLeaveRoom()}
        onMuteChange={setIsMuted}
        onVolumeChange={setVolume}
        volume={volume}
      />

      {liveKitRoom !== null ? (
        <RoomAudioRenderer
          room={liveKitRoom}
          muted={isMuted}
          volume={volume}
        />
      ) : null}

      {showConnectionOverlay ? (
        <div className="room-live-overlay" aria-live="polite">
          <StatusPanel
            className="room-live-status--overlay"
            eyebrow={effectiveError === null ? "Live transport" : "Connection problem"}
            title={
              effectiveError === null
                ? "Connecting to the live room"
                : "Connection lost"
            }
            description={
              effectiveError === null
                ? "The audio transport is still coming online. The room will unlock as soon as LiveKit confirms the session."
                : getRuntimeErrorDescription(effectiveError)
            }
            actions={
              effectiveError !== null ? (
                <>
                  <Button size="lg" onClick={() => void handleRetryJoin()}>
                    Retry room
                  </Button>
                  <Link
                    href="/lobby"
                    className="ui-button ui-button--ghost ui-button--lg"
                  >
                    Return to lobby
                  </Link>
                </>
              ) : undefined
            }
          />
        </div>
      ) : null}

      {roomEndedAt !== null ? (
        <div className="room-live-overlay" aria-live="polite">
          <StatusPanel
            className="room-live-status--overlay"
            eyebrow="Room ended"
            title="This conversation has wrapped"
            description={`The room has ended. Returning you to the lobby in ${redirectCountdown} seconds.`}
            actions={
              <Link
                href="/lobby"
                className="ui-button ui-button--primary ui-button--lg"
              >
                Return to lobby now
              </Link>
            }
          />
        </div>
      ) : null}
    </div>
  );
}

"use client";

/**
 * Production admin operations surface for Murmur room management.
 *
 * This component owns the client-side operator state for room expansion,
 * destructive confirmations, mutation pending flags, and server-backed
 * refreshes after every admin action.
 */

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import {
  startTransition,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import AgentControls from "@/components/admin/AgentControls";
import { useToast } from "@/components/ui/Toast";
import Button from "@/components/ui/Button";
import {
  ApiClientError,
  endRoom,
  fetchAdminRooms,
  muteAgent,
  unmuteAgent,
} from "@/lib/api";
import { cn, formatRelativeTime, formatTimestamp } from "@/lib/utils";
import type { AdminAgentSummary, AdminRoom, RoomStatus } from "@/types";

/**
 * Props accepted by the admin room manager.
 */
export interface RoomManagerProps {
  initialRooms: AdminRoom[];
}

/**
 * Toast copy used when a successful mutation applies but the follow-up refresh
 * cannot retrieve the latest server state.
 */
interface RefreshFailureToast {
  description: string;
  title: string;
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * Builds the stable per-agent mutation key used by pending UI state.
 *
 * @param roomId - Room UUID currently being managed.
 * @param agentId - Agent UUID receiving the action.
 * @returns A stable pending key string.
 */
function buildPendingAgentKey(roomId: string, agentId: string): string {
  return `${roomId}:${agentId}`;
}

/**
 * Converts the stored room status into concise operator-facing copy.
 *
 * @param status - Canonical room status value.
 * @returns A human-readable status label.
 */
function getRoomStatusLabel(status: RoomStatus): string {
  if (status === "live") {
    return "Live";
  }

  if (status === "ended") {
    return "Ended";
  }

  return "Scheduled";
}

/**
 * Returns the lifecycle copy shown in the admin card's ended-state field.
 *
 * @param status - Canonical room status value.
 * @param endedAt - Persisted ended timestamp for the room, when present.
 * @returns A human-readable lifecycle label for the room card.
 */
function getRoomEndedLabel(
  status: RoomStatus,
  endedAt: string | null,
): string {
  if (status === "scheduled") {
    return "Not started";
  }

  if (status === "ended") {
    return endedAt === null ? "Ended" : formatRelativeTime(endedAt);
  }

  return "Still live";
}

/**
 * Returns the operator-facing end-action label for the current room status.
 *
 * @param status - Canonical room status value.
 * @returns The action label for the room card button.
 */
function getRoomEndActionLabel(status: RoomStatus): string {
  if (status === "scheduled") {
    return "Cancel room";
  }

  if (status === "ended") {
    return "Ended";
  }

  return "End room";
}

/**
 * Returns the confirmation title shown before ending or canceling a room.
 *
 * @param room - Room currently targeted by the destructive action flow.
 * @returns The dialog title.
 */
function getConfirmRoomTitle(room: AdminRoom): string {
  return room.status === "scheduled"
    ? `Cancel ${room.title}?`
    : `End ${room.title}?`;
}

/**
 * Returns the confirmation description shown before ending or canceling a room.
 *
 * @param room - Room currently targeted by the destructive action flow.
 * @returns The dialog body copy.
 */
function getConfirmRoomDescription(room: AdminRoom): string {
  if (room.status === "scheduled") {
    return "This marks the scheduled room as ended before it goes live, clears any pre-created runtime state, and prevents listeners from joining it later.";
  }

  return "This immediately marks the room as ended, disconnects listeners, clears runtime state, and stops further admin mute changes for the current room session.";
}

/**
 * Returns the success toast description after the end-room API succeeds.
 *
 * @param room - Room targeted by the destructive action flow.
 * @param alreadyEnded - Whether the backend reported that the room was already ended.
 * @returns Operator-facing success copy.
 */
function getRoomEndedSuccessDescription(
  room: AdminRoom,
  alreadyEnded: boolean,
): string {
  if (alreadyEnded) {
    return `${room.title} was already closed before this request completed.`;
  }

  if (room.status === "scheduled") {
    return `${room.title} has been canceled before going live.`;
  }

  return `${room.title} has been ended and listeners were instructed to leave the room.`;
}

/**
 * Returns the short description used when mutations fail.
 *
 * @param error - Unknown thrown value from the API helper.
 * @param fallback - Copy to use when no precise error message is available.
 * @returns A stable operator-facing error description.
 */
function getOperationErrorDescription(
  error: unknown,
  fallback: string,
): string {
  if (error instanceof ApiClientError) {
    return error.message;
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return fallback;
}

/**
 * Locates focusable descendants so the end-room dialog can trap focus.
 *
 * @param container - Dialog element whose focusable children should be read.
 * @returns A list of currently focusable descendants.
 */
function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (container === null) {
    return [];
  }

  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      !element.hasAttribute("disabled") &&
      element.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * Decorative room-operations glyph used by the empty state.
 *
 * @returns A lightweight inline SVG.
 */
function AdminEmptyGlyph() {
  return (
    <svg
      className="admin-empty__glyph"
      aria-hidden="true"
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="8" y="12" width="32" height="24" rx="10" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M16 21h16M16 27h10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="34" cy="18" r="2.5" fill="currentColor" />
    </svg>
  );
}

/**
 * Chevron glyph used by the expand/collapse control.
 *
 * @param props - Expanded-state indicator.
 * @returns A decorative inline SVG.
 */
function ChevronIcon({
  expanded,
}: Readonly<{
  expanded: boolean;
}>) {
  return (
    <svg
      className={cn("admin-room-expand__icon", expanded && "admin-room-expand__icon--expanded")}
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="m4.5 6.25 3.5 3.5 3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Summary metric tile used by the admin dashboard.
 *
 * @param props - Metric label, value, and supporting hint copy.
 * @returns A styled metric tile.
 */
function SummaryMetric({
  hint,
  label,
  value,
}: Readonly<{
  hint: string;
  label: string;
  value: string;
}>) {
  return (
    <article className="admin-summary-card glass-card">
      <span className="admin-summary-card__label mono">{label}</span>
      <strong className="admin-summary-card__value">{value}</strong>
      <p className="admin-summary-card__hint">{hint}</p>
    </article>
  );
}

/**
 * Renders the admin room manager and its operator action flows.
 *
 * @param props - Server-fetched initial admin room payload.
 * @returns The production admin room-operations surface.
 */
export default function RoomManager({
  initialRooms,
}: Readonly<RoomManagerProps>) {
  const { getToken } = useAuth();
  const { pushToast } = useToast();
  const [rooms, setRooms] = useState(initialRooms);
  const [expandedRoomId, setExpandedRoomId] = useState<string | null>(
    initialRooms.find((room) => room.status === "live")?.id ??
      initialRooms[0]?.id ??
      null,
  );
  const [confirmRoomId, setConfirmRoomId] = useState<string | null>(null);
  const [pendingRoomId, setPendingRoomId] = useState<string | null>(null);
  const [pendingAgentKey, setPendingAgentKey] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshRequestIdRef = useRef(0);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const dialogPanelRef = useRef<HTMLDivElement | null>(null);
  const dialogTitleId = useId();
  const dialogDescriptionId = useId();
  const confirmRoom =
    confirmRoomId === null
      ? null
      : rooms.find((room) => room.id === confirmRoomId) ?? null;

  /**
   * Keeps the currently expanded room valid after server refreshes change the
   * available room collection.
   */
  useEffect(() => {
    if (rooms.length === 0) {
      startTransition(() => {
        setExpandedRoomId(null);
      });
      return;
    }

    if (
      expandedRoomId !== null &&
      rooms.some((room) => room.id === expandedRoomId)
    ) {
      return;
    }

    startTransition(() => {
      setExpandedRoomId(rooms[0]?.id ?? null);
    });
  }, [expandedRoomId, rooms]);

  const closeConfirmDialog = useEffectEvent(() => {
    if (pendingRoomId !== null) {
      return;
    }

    startTransition(() => {
      setConfirmRoomId(null);
    });
  });

  /**
   * Locks scrolling and traps focus while the destructive confirmation dialog
   * is open so keyboard operators stay inside the active decision surface.
   */
  useEffect(() => {
    if (confirmRoom === null) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const frameId = window.requestAnimationFrame(() => {
      const focusableElements = getFocusableElements(dialogPanelRef.current);
      const firstFocusable = focusableElements[0] ?? dialogPanelRef.current;

      firstFocusable?.focus();
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeConfirmDialog();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusableElements = getFocusableElements(dialogPanelRef.current);

      if (focusableElements.length === 0) {
        event.preventDefault();
        dialogPanelRef.current?.focus();
        return;
      }

      const firstFocusable = focusableElements[0];
      const lastFocusable = focusableElements[focusableElements.length - 1];

      if (
        event.shiftKey &&
        document.activeElement === firstFocusable &&
        lastFocusable !== undefined
      ) {
        event.preventDefault();
        lastFocusable.focus();
      } else if (
        !event.shiftKey &&
        document.activeElement === lastFocusable &&
        firstFocusable !== undefined
      ) {
        event.preventDefault();
        firstFocusable.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.cancelAnimationFrame(frameId);
      document.removeEventListener("keydown", handleKeyDown);

      const returnTarget = returnFocusRef.current;

      if (returnTarget !== null && document.contains(returnTarget)) {
        returnTarget.focus();
      }
    };
  }, [closeConfirmDialog, confirmRoom, pendingRoomId]);

  /**
   * Refetches the admin room list from the server and applies only the most
   * recent response to avoid stale refreshes racing newer mutations.
   *
   * @param failureToast - Optional warning copy shown when the refresh fails.
   * @returns Whether the refresh completed successfully.
   */
  const refreshRooms = useEffectEvent(
    async (failureToast?: RefreshFailureToast): Promise<boolean> => {
      const requestId = refreshRequestIdRef.current + 1;
      refreshRequestIdRef.current = requestId;

      startTransition(() => {
        setIsRefreshing(true);
      });

      try {
        const nextRooms = await fetchAdminRooms({ getToken });

        if (refreshRequestIdRef.current !== requestId) {
          return false;
        }

        startTransition(() => {
          setRooms(nextRooms);
          setExpandedRoomId((currentExpandedRoomId) => {
            if (
              currentExpandedRoomId !== null &&
              nextRooms.some((room) => room.id === currentExpandedRoomId)
            ) {
              return currentExpandedRoomId;
            }

            return nextRooms[0]?.id ?? null;
          });
        });

        return true;
      } catch (error) {
        if (failureToast !== undefined) {
          pushToast({
            description: `${failureToast.description} ${getOperationErrorDescription(
              error,
              "Reload the page to recover the latest operator state.",
            )}`,
            title: failureToast.title,
            variant: "warning",
          });
        }

        return false;
      } finally {
        if (refreshRequestIdRef.current === requestId) {
          startTransition(() => {
            setIsRefreshing(false);
          });
        }
      }
    },
  );

  /**
   * Applies a room-scoped mute toggle and then re-syncs the dashboard from the
   * canonical admin API response.
   *
   * @param roomId - Room UUID currently being managed.
   * @param agent - Agent record being muted or unmuted.
   */
  const handleToggleMute = useEffectEvent(
    async (roomId: string, agent: AdminAgentSummary) => {
      const agentMutationKey = buildPendingAgentKey(roomId, agent.id);

      startTransition(() => {
        setPendingAgentKey(agentMutationKey);
      });

      try {
        if (agent.muted) {
          await unmuteAgent(roomId, agent.id, { getToken });
        } else {
          await muteAgent(roomId, agent.id, { getToken });
        }

        pushToast({
          description: agent.muted
            ? `${agent.name} can speak again once the room cycle reaches them.`
            : `${agent.name} has been muted for this room and will not re-enter the floor rotation.`,
          title: agent.muted ? "Agent unmuted" : "Agent muted",
          variant: "success",
        });

        await refreshRooms({
          description:
            "The agent control was applied, but the dashboard could not fetch the latest server state.",
          title: "Dashboard refresh failed",
        });
      } catch (error) {
        pushToast({
          description: getOperationErrorDescription(
            error,
            agent.muted
              ? "The agent could not be unmuted. Retry once the admin API is reachable."
              : "The agent could not be muted. Retry once the admin API is reachable.",
          ),
          title: agent.muted ? "Unable to unmute agent" : "Unable to mute agent",
          variant: "error",
        });
      } finally {
        startTransition(() => {
          setPendingAgentKey((currentPendingAgentKey) =>
            currentPendingAgentKey === agentMutationKey ? null : currentPendingAgentKey,
          );
        });
      }
    },
  );

  /**
   * Ends the currently confirmed room and handles both full success and the
   * partial-cleanup failure mode defined by the API contract.
   */
  const handleConfirmEndRoom = useEffectEvent(async () => {
    if (confirmRoom === null) {
      return;
    }

    const roomToEnd = confirmRoom;
    const roomId = roomToEnd.id;

    startTransition(() => {
      setPendingRoomId(roomId);
    });

    try {
      const result = await endRoom(roomId, { getToken });

      pushToast({
        description: getRoomEndedSuccessDescription(roomToEnd, result.alreadyEnded),
        title: result.alreadyEnded
          ? "Room already ended"
          : roomToEnd.status === "scheduled"
            ? "Room canceled"
            : "Room ended",
        variant: result.alreadyEnded ? "info" : "success",
      });

      await refreshRooms({
        description:
          "The room state changed, but the dashboard could not fetch the latest room list.",
        title: "Dashboard refresh failed",
      });

      startTransition(() => {
        setConfirmRoomId(null);
      });
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "room_end_cleanup_failed") {
        pushToast({
          description: error.message,
          title: "Room ended, cleanup incomplete",
          variant: "warning",
        });

        await refreshRooms({
          description:
            "The room was ended, but the dashboard could not confirm the latest operator state.",
          title: "Dashboard refresh failed",
        });

        startTransition(() => {
          setConfirmRoomId(null);
        });
      } else {
        pushToast({
          description: getOperationErrorDescription(
            error,
            roomToEnd.status === "scheduled"
              ? "The scheduled room could not be canceled. Retry once the operator connection stabilizes."
              : "The room could not be ended. Retry once the operator connection stabilizes.",
          ),
          title: roomToEnd.status === "scheduled" ? "Unable to cancel room" : "Unable to end room",
          variant: "error",
        });
      }
    } finally {
      startTransition(() => {
        setPendingRoomId((currentPendingRoomId) =>
          currentPendingRoomId === roomId ? null : currentPendingRoomId,
        );
      });
    }
  });

  const totalListeners = rooms.reduce(
    (listenerCountTotal, room) => listenerCountTotal + room.listenerCount,
    0,
  );
  const liveRoomCount = rooms.filter((room) => room.status === "live").length;
  const endedRoomCount = rooms.filter((room) => room.status === "ended").length;

  return (
    <section className="admin-operations">
      <header className="admin-operations__header">
        <div className="admin-operations__copy">
          <span className="section-label">Room Operations</span>
          <h2>Keep live rooms truthful, legible, and under control.</h2>
          <p>
            This operator surface reads the persisted admin room feed, including
            Redis-backed mute state, so every action reflects the actual
            production state after refresh.
          </p>
        </div>

        <p className="admin-operations__status" role="status">
          {isRefreshing
            ? "Refreshing latest room state..."
            : "Operator state is current."}
        </p>
      </header>

      <div className="admin-summary-grid" aria-label="Room summary">
        <SummaryMetric
          label="Total rooms"
          value={rooms.length.toString()}
          hint="All persisted rooms currently visible to operators."
        />
        <SummaryMetric
          label="Live rooms"
          value={liveRoomCount.toString()}
          hint="Rooms listeners can still actively join right now."
        />
        <SummaryMetric
          label="Ended rooms"
          value={endedRoomCount.toString()}
          hint="Closed conversations retained for operational review."
        />
        <SummaryMetric
          label="Active listeners"
          value={totalListeners.toString()}
          hint="Real-time audience count across every tracked room."
        />
      </div>

      {rooms.length === 0 ? (
        <section className="admin-empty glass-card fade-up">
          <AdminEmptyGlyph />
          <div className="admin-empty__copy">
            <span className="section-label">No rooms yet</span>
            <h3>No rooms have been created yet.</h3>
            <p>
              The operator surface is ready, but there are currently no rooms to
              moderate. Head back to the lobby once the first room is live.
            </p>
          </div>

          <Link href="/lobby" className="ui-button ui-button--ghost ui-button--lg">
            Return to lobby
          </Link>
        </section>
      ) : (
        <div className="admin-room-list" data-testid="admin-room-list" aria-busy={isRefreshing}>
          {rooms.map((room) => {
            const isExpanded = expandedRoomId === room.id;
            const isEndingRoom = pendingRoomId === room.id;
            const createdAtLabel = formatRelativeTime(room.createdAt);
            const endedAtLabel = getRoomEndedLabel(room.status, room.endedAt);
            const canEndRoom = room.status !== "ended";

            return (
              <article
                key={room.id}
                className={cn(
                  "admin-room-card glass-card fade-up",
                  room.status === "ended" && "admin-room-card--ended",
                )}
              >
                <div className="admin-room-card__header">
                  <div className="admin-room-card__identity">
                    <p className="admin-room-card__eyebrow mono">
                      Room / {room.id.slice(0, 8)}
                    </p>
                    <h3>{room.title}</h3>
                    <p className="admin-room-card__topic">{room.topic}</p>
                  </div>

                  <div className="admin-room-card__badges">
                    <span
                      className={cn(
                        "ui-badge admin-room-status",
                        `admin-room-status--${room.status}`,
                      )}
                      data-testid="room-status"
                    >
                      {getRoomStatusLabel(room.status)}
                    </span>
                    <span className="ui-badge admin-room-count-badge">
                      {room.agents.length} agents
                    </span>
                  </div>
                </div>

                <div className="admin-room-meta">
                  <div className="admin-room-meta__item">
                    <span className="admin-room-meta__label">Format</span>
                    <strong>{room.format === "moderated" ? "Moderated" : "Free-for-all"}</strong>
                  </div>
                  <div className="admin-room-meta__item">
                    <span className="admin-room-meta__label">Listeners</span>
                    <strong>{room.listenerCount}</strong>
                  </div>
                  <div className="admin-room-meta__item">
                    <span className="admin-room-meta__label">Created</span>
                    <strong title={formatTimestamp(room.createdAt)}>{createdAtLabel}</strong>
                  </div>
                  <div className="admin-room-meta__item">
                    <span className="admin-room-meta__label">Lifecycle</span>
                    <strong title={room.endedAt === null ? undefined : formatTimestamp(room.endedAt)}>
                      {endedAtLabel}
                    </strong>
                  </div>
                </div>

                <div className="admin-room-actions">
                  <div className="admin-room-actions__primary">
                    {canEndRoom ? (
                      <Button
                        variant="danger"
                        size="sm"
                        loading={isEndingRoom}
                        data-testid="end-room-btn"
                        onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
                          returnFocusRef.current = event.currentTarget;
                          startTransition(() => {
                            setConfirmRoomId(room.id);
                          });
                        }}
                      >
                        {getRoomEndActionLabel(room.status)}
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled
                        data-testid="end-room-btn"
                      >
                        {getRoomEndActionLabel(room.status)}
                      </Button>
                    )}
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    className="admin-room-expand"
                    aria-controls={`admin-room-agents-${room.id}`}
                    aria-expanded={isExpanded}
                    onClick={() => {
                      startTransition(() => {
                        setExpandedRoomId((currentExpandedRoomId) =>
                          currentExpandedRoomId === room.id ? null : room.id,
                        );
                      });
                    }}
                  >
                    {isExpanded ? "Hide agents" : "Manage agents"}
                    <ChevronIcon expanded={isExpanded} />
                  </Button>
                </div>

                {isExpanded ? (
                  <div
                    id={`admin-room-agents-${room.id}`}
                    className="admin-room-card__agents"
                  >
                    <AgentControls
                      agents={room.agents}
                      pendingAgentKey={pendingAgentKey}
                      roomId={room.id}
                      roomStatus={room.status}
                      onToggleMute={handleToggleMute}
                    />
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      {confirmRoom !== null ? (
        <div
          className="admin-dialog"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              closeConfirmDialog();
            }
          }}
        >
          <div
            ref={dialogPanelRef}
            className="admin-dialog__panel glass-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby={dialogTitleId}
            aria-describedby={dialogDescriptionId}
            tabIndex={-1}
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <span className="section-label">Destructive action</span>
            <h3 id={dialogTitleId}>{getConfirmRoomTitle(confirmRoom)}</h3>
            <p id={dialogDescriptionId}>
              {getConfirmRoomDescription(confirmRoom)}
            </p>

            <div className="admin-dialog__details">
              <div className="admin-dialog__detail">
                <span className="admin-dialog__detail-label">Listeners</span>
                <strong>{confirmRoom.listenerCount}</strong>
              </div>
              <div className="admin-dialog__detail">
                <span className="admin-dialog__detail-label">Agents</span>
                <strong>{confirmRoom.agents.length}</strong>
              </div>
              <div className="admin-dialog__detail">
                <span className="admin-dialog__detail-label">Format</span>
                <strong>
                  {confirmRoom.format === "moderated" ? "Moderated" : "Free-for-all"}
                </strong>
              </div>
            </div>

            <div className="admin-dialog__actions">
              <Button
                variant="ghost"
                size="lg"
                disabled={pendingRoomId !== null}
                onClick={() => {
                  closeConfirmDialog();
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="lg"
                loading={pendingRoomId === confirmRoom.id}
                data-testid="confirm-end-room"
                onClick={() => {
                  void handleConfirmEndRoom();
                }}
              >
                {getRoomEndActionLabel(confirmRoom.status)}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

"use client";

/**
 * Compact per-room agent operations list for the Murmur admin dashboard.
 *
 * This component keeps agent moderation controls dense and operationally
 * readable while preserving the current premium design language established by
 * the rest of the application shell.
 */

import Image from "next/image";
import type { CSSProperties } from "react";

import Button from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import type { AdminAgentSummary, RoomStatus } from "@/types";

/**
 * Props for the room-scoped agent control list.
 */
export interface AgentControlsProps {
  agents: AdminAgentSummary[];
  pendingAgentKey: string | null;
  roomId: string;
  roomStatus: RoomStatus;
  onToggleMute: (roomId: string, agent: AdminAgentSummary) => Promise<void> | void;
}

/**
 * Creates the stable mutation key used to track pending mute toggles.
 *
 * @param roomId - Room UUID currently being managed.
 * @param agentId - Agent UUID receiving the mutation.
 * @returns A stable string key for pending-state comparison.
 */
function buildPendingAgentKey(roomId: string, agentId: string): string {
  return `${roomId}:${agentId}`;
}

/**
 * Maps the canonical room-agent role literal to a user-facing label.
 *
 * @param role - Stored room agent role.
 * @returns A concise display label for the control surface.
 */
function getRoleLabel(role: AdminAgentSummary["role"]): string {
  return role === "host" ? "Host" : "Participant";
}

/**
 * Returns the action copy for the current mute state.
 *
 * @param muted - Current persisted muted flag.
 * @returns The button label for the next admin action.
 */
function getMuteActionLabel(muted: boolean): string {
  return muted ? "Unmute" : "Mute";
}

/**
 * Renders the compact agent moderation list for a single room.
 *
 * @param props - Agent list, room state, and mutation callback props.
 * @returns A room-scoped set of mute controls.
 */
export default function AgentControls({
  agents,
  pendingAgentKey,
  roomId,
  roomStatus,
  onToggleMute,
}: Readonly<AgentControlsProps>) {
  return (
    <div className="admin-agent-controls" role="list" aria-label="Room agents">
      {agents.map((agent) => {
        const actionKey = buildPendingAgentKey(roomId, agent.id);
        const isPending = pendingAgentKey === actionKey;
        const isActionDisabled = roomStatus !== "live" || isPending;

        return (
          <article
            key={agent.id}
            className={cn(
              "admin-agent-row",
              agent.role === "host" && "admin-agent-row--host",
              agent.muted && "admin-agent-row--muted",
            )}
            role="listitem"
          >
            <div className="admin-agent-row__identity">
              <div
                className="admin-agent-row__avatar-shell"
                style={{
                  "--admin-agent-accent": agent.accentColor,
                } as CSSProperties}
              >
                <Image
                  src={agent.avatarUrl}
                  alt={`${agent.name} avatar`}
                  width={56}
                  height={56}
                  sizes="56px"
                  className="admin-agent-row__avatar"
                />
              </div>

              <div className="admin-agent-row__copy">
                <div className="admin-agent-row__name-line">
                  <h3>{agent.name}</h3>
                  <div className="admin-agent-row__chips">
                    <span className="ui-badge admin-agent-row__chip">
                      {getRoleLabel(agent.role)}
                    </span>
                    {agent.muted ? (
                      <span className="ui-badge admin-agent-row__chip admin-agent-row__chip--muted">
                        Muted
                      </span>
                    ) : null}
                  </div>
                </div>

                <p>
                  {agent.role === "host"
                    ? "Leads the room flow and gets priority when the conversation stalls."
                    : "Participates in the current room rotation and follows room-level moderation."}
                </p>
              </div>
            </div>

            <Button
              size="sm"
              variant={agent.muted ? "secondary" : "ghost"}
              loading={isPending}
              disabled={isActionDisabled}
              aria-pressed={agent.muted}
              data-testid="mute-agent-btn"
              onClick={() => {
                void onToggleMute(roomId, agent);
              }}
            >
              {getMuteActionLabel(agent.muted)}
            </Button>
          </article>
        );
      })}
    </div>
  );
}

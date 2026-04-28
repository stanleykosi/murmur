/**
 * Stage layout for the Murmur live room experience.
 */

import { cn } from "@/lib/utils";
import type { AgentSummary } from "@/types";

import AgentAvatar from "./AgentAvatar";

interface StageRoster {
  host: AgentSummary;
  participants: AgentSummary[];
}

export interface AgentStageProps {
  activeSpeakerId?: string | null;
  agents: readonly AgentSummary[];
  className?: string;
}

/**
 * Asserts that the current stage roster matches the supported room shapes.
 *
 * @param agents - Agents assigned to the current room.
 * @returns The normalized host and participant roster.
 * @throws {Error} When the roster contains an unsupported shape.
 */
function resolveStageRoster(agents: readonly AgentSummary[]): StageRoster {
  if (agents.length < 2 || agents.length > 3) {
    throw new Error(
      `AgentStage requires 2 or 3 agents, received ${agents.length}.`,
    );
  }

  const hosts = agents.filter((agent) => agent.role === "host");

  if (hosts.length !== 1) {
    throw new Error(
      `AgentStage requires exactly one host agent, received ${hosts.length}.`,
    );
  }

  const host = hosts[0];

  if (host === undefined) {
    throw new Error("AgentStage could not resolve the host agent.");
  }

  return {
    host,
    participants: agents.filter((agent) => agent.role !== "host"),
  };
}

/**
 * Renders a single stage slot with the appropriate speaker-state styling.
 *
 * @param agent - Agent represented by the slot.
 * @param activeSpeakerId - Current active speaker identifier, if any.
 * @param isHost - Whether the slot represents the room host.
 * @returns The stage slot content for the supplied agent.
 */
function StageSlot({
  activeSpeakerId,
  agent,
  isHost,
}: Readonly<{
  activeSpeakerId?: string | null;
  agent: AgentSummary;
  isHost: boolean;
}>) {
  const hasActiveSpeaker = activeSpeakerId !== null && activeSpeakerId !== undefined;
  const isActiveSpeaker = activeSpeakerId === agent.id;

  return (
    <div
      className={cn(
        "room-stage__slot",
        isHost && "room-stage__slot--host",
        hasActiveSpeaker && isActiveSpeaker && "room-stage__slot--active",
        hasActiveSpeaker && !isActiveSpeaker && "room-stage__slot--inactive",
      )}
    >
      <AgentAvatar
        name={agent.name}
        avatarUrl={agent.avatarUrl}
        accentColor={agent.accentColor}
        isHost={isHost}
        isSpeaking={isActiveSpeaker}
        size={isHost ? "lg" : "md"}
      />
    </div>
  );
}

/**
 * Renders the premium agent stage used in the live room view.
 *
 * @param props - Current room roster and speaking state.
 * @returns A centered broadcast-style stage for the current room agents.
 */
export default function AgentStage({
  activeSpeakerId = null,
  agents,
  className,
}: Readonly<AgentStageProps>) {
  const { host, participants } = resolveStageRoster(agents);
  const leftParticipant = participants[0] ?? null;
  const rightParticipant = participants[1] ?? null;

  return (
    <section
      className={cn("room-stage glass-card fade-up", className)}
      data-testid="agent-stage"
      aria-label="Live room stage"
    >
      <div className="room-stage__ambient" aria-hidden="true" />
      <div className="room-stage__grid">
        {leftParticipant !== null ? (
          <StageSlot
            agent={leftParticipant}
            activeSpeakerId={activeSpeakerId}
            isHost={false}
          />
        ) : (
          <div
            className="room-stage__slot room-stage__slot--spacer"
            aria-hidden="true"
          />
        )}

        <StageSlot agent={host} activeSpeakerId={activeSpeakerId} isHost />

        {rightParticipant !== null ? (
          <StageSlot
            agent={rightParticipant}
            activeSpeakerId={activeSpeakerId}
            isHost={false}
          />
        ) : (
          <div
            className="room-stage__slot room-stage__slot--spacer"
            aria-hidden="true"
          />
        )}
      </div>
    </section>
  );
}

/**
 * Read-only room card used by the Murmur lobby grid.
 */

import type { CSSProperties } from "react";

import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import { truncateText } from "@/lib/utils";
import type { AgentSummary, Room } from "@/types";

/**
 * Public props for the lobby room card.
 */
export interface RoomCardProps {
  room: Room;
}

type AgentAccentStyle = CSSProperties & {
  "--agent-accent": string;
};

type RoomCardStyle = CSSProperties & {
  "--room-accent": string;
};

/**
 * Converts an agent name into the single-character token used by compact agent chips.
 *
 * @param name - Agent display name.
 * @returns The leading uppercase grapheme for the current agent.
 */
function getAgentInitial(name: string): string {
  const trimmedName = name.trim();

  return trimmedName.length > 0 ? trimmedName[0]!.toUpperCase() : "?";
}

/**
 * Builds the CSS variable payload that colors the agent chip.
 *
 * @param agent - The room agent whose accent color should drive the chip.
 * @returns Inline styles containing the accent-color CSS variable.
 */
function getAgentAccentStyle(agent: AgentSummary): AgentAccentStyle {
  return {
    "--agent-accent": agent.accentColor,
  };
}

/**
 * Creates an accessible label for the agent chip while the chip itself stays
 * visually minimal.
 *
 * @param agent - The room agent represented by the chip.
 * @returns A human-readable chip description.
 */
function getAgentChipLabel(agent: AgentSummary): string {
  return `${agent.name}, ${agent.role === "host" ? "host" : "participant"} agent`;
}

/**
 * Returns the current host agent for the room when available.
 *
 * @param room - Room payload rendered by the card.
 * @returns The host agent summary or `null`.
 */
function getHostAgent(room: Room): AgentSummary | null {
  return room.agents.find((agent) => agent.role === "host") ?? null;
}

/**
 * Returns whether the room title adds information beyond the topic line.
 *
 * @param room - Room payload rendered by the card.
 * @returns True when the title should be rendered as secondary metadata.
 */
function shouldRenderSecondaryTitle(room: Room): boolean {
  return room.title.trim().toLowerCase() !== room.topic.trim().toLowerCase();
}

/**
 * Builds the room-level accent style from the host agent's accent color.
 *
 * @param room - Room payload rendered by the card.
 * @returns Inline styles for room-wide accent treatments.
 */
function getRoomCardStyle(room: Room): RoomCardStyle {
  return {
    "--room-accent": getHostAgent(room)?.accentColor ?? "#bd00ff",
  };
}

/**
 * Renders the directional glyph for the room card CTA row.
 *
 * @returns A decorative inline arrow icon.
 */
function ArrowIcon() {
  return (
    <svg
      className="room-card__cta-icon"
      aria-hidden="true"
      viewBox="0 0 18 18"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M4 9h10M9.25 3.75 14.5 9l-5.25 5.25"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Renders a single clickable room card for the lobby grid.
 *
 * @param props - Card props containing the full shared room payload.
 * @returns An interactive card linking to the room route.
 */
export default function RoomCard({ room }: Readonly<RoomCardProps>) {
  const hostAgent = getHostAgent(room);
  const agentNames = room.agents.map((agent) => agent.name).join(" · ");
  const showSecondaryTitle = shouldRenderSecondaryTitle(room);

  return (
    <Card
      href={`/room/${room.id}`}
      className="room-card fade-up"
      aria-label={`Open room ${room.title}`}
    >
      <div
        className="room-card__frame"
        style={getRoomCardStyle(room)}
        data-testid="room-card"
      >
        <span className="room-card__accent-bar" aria-hidden="true" />
        <div className="room-card__top">
          <div className="room-card__badges">
            <Badge variant="live" />
            <Badge variant="format" format={room.format} />
          </div>

          <Badge
            variant="listener-count"
            count={room.listenerCount}
            data-testid="listener-count"
          />
        </div>

        <div className="room-card__body">
          <p className="room-card__eyebrow mono">
            Host / {hostAgent?.name ?? "Murmur"} / {room.agents.length} agents
          </p>
          <h2 className="room-card__title" data-testid="room-title">
            {room.title}
          </h2>
          {showSecondaryTitle ? (
            <p className="room-card__topic" data-testid="room-topic" title={room.topic}>
              {truncateText(room.topic, 140)}
            </p>
          ) : null}
          <p className="room-card__host-note">
            {room.format === "moderated"
              ? "Host-led room with clear turn direction."
              : "Open conversational room with rotating AI voices."}
          </p>
        </div>

        <div className="room-card__footer">
          <div
            className="room-card__agents"
            aria-label={`Agents in room: ${agentNames}`}
          >
            {room.agents.map((agent) => (
              <span
                key={agent.id}
                className={[
                  "room-card__agent",
                  agent.role === "host" ? "room-card__agent--host" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={getAgentAccentStyle(agent)}
                data-testid="agent-avatar"
                aria-label={getAgentChipLabel(agent)}
                title={getAgentChipLabel(agent)}
              >
                <span className="room-card__agent-initial" aria-hidden="true">
                  {getAgentInitial(agent.name)}
                </span>
              </span>
            ))}
          </div>

          <div className="room-card__footer-meta">
            <p className="room-card__agent-summary">{agentNames}</p>
            <span className="room-card__cta">
              Join live room
              <ArrowIcon />
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}

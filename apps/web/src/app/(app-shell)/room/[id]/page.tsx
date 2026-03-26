/**
 * Thin room-route scaffold for the Murmur app shell.
 *
 * This page intentionally stops short of the realtime listener experience. Its
 * job in the current step is to make lobby navigation land on a real room URL,
 * expose room metadata for SEO, and present a polished read-only overview.
 */

import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";

import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import { fetchRoom } from "@/lib/api";
import type { AgentSummary, Room } from "@/types";

export const revalidate = 10;

const ROOM_FALLBACK_DESCRIPTION =
  "This Murmur room is unavailable right now. Return to the lobby to discover another live conversation.";

interface RoomPageProps {
  params: Promise<{
    id: string;
  }>;
}

type AgentAccentStyle = CSSProperties & {
  "--agent-accent": string;
};

/**
 * Produces the temporary agent-swatch styling used before avatar assets land.
 *
 * @param agent - Room agent whose accent color should be surfaced.
 * @returns Inline styles carrying the agent accent CSS variable.
 */
function getAgentAccentStyle(agent: AgentSummary): AgentAccentStyle {
  return {
    "--agent-accent": agent.accentColor,
  };
}

/**
 * Creates the single-letter monogram used for the temporary agent swatch.
 *
 * @param name - Agent display name.
 * @returns The uppercase initial for the supplied agent.
 */
function getAgentInitial(name: string): string {
  const trimmedName = name.trim();

  return trimmedName.length > 0 ? trimmedName[0]!.toUpperCase() : "?";
}

/**
 * Returns the room host agent when the roster includes one.
 *
 * @param room - Room payload loaded for the route.
 * @returns The host agent summary or `null`.
 */
function getHostAgent(room: Room): AgentSummary | null {
  return room.agents.find((agent) => agent.role === "host") ?? null;
}

/**
 * Loads a room by ID and enforces the current rule that the room scaffold only
 * renders live rooms from the lobby flow.
 *
 * @param roomId - Room UUID extracted from the route params.
 * @returns The requested live room payload.
 * @throws {Error} When the room is not currently live.
 */
async function loadLiveRoom(roomId: string): Promise<Room> {
  const room = await fetchRoom(roomId);

  if (room.status !== "live") {
    throw new Error(`Room "${roomId}" is not currently live.`);
  }

  return room;
}

/**
 * Generates SEO metadata for the room scaffold route.
 *
 * Errors are converted into stable fallback metadata so direct visits to
 * unavailable rooms still return a useful document head instead of crashing
 * before the segment error boundary can render.
 *
 * @param props - Dynamic route params supplied by Next.js.
 * @returns Metadata for either the live room or the unavailable-room state.
 */
export async function generateMetadata({
  params,
}: Readonly<RoomPageProps>): Promise<Metadata> {
  try {
    const { id } = await params;
    const room = await loadLiveRoom(id);

    return {
      title: room.title,
      description: room.topic,
      openGraph: {
        title: `${room.title} | Murmur`,
        description: `Listen in as Murmur agents discuss: ${room.topic}`,
      },
    };
  } catch {
    return {
      title: "Room unavailable",
      description: ROOM_FALLBACK_DESCRIPTION,
      openGraph: {
        title: "Room unavailable | Murmur",
        description: ROOM_FALLBACK_DESCRIPTION,
      },
    };
  }
}

/**
 * Renders the read-only room overview scaffold for a single live room.
 *
 * @param props - Dynamic route params supplied by Next.js.
 * @returns The room overview page shown before the realtime room runtime lands.
 */
export default async function RoomPage({
  params,
}: Readonly<RoomPageProps>) {
  const { id } = await params;
  const room = await loadLiveRoom(id);
  const hostAgent = getHostAgent(room);

  return (
    <div className="page-shell room-overview-page">
      <section className="room-overview-hero glass-card fade-up">
        <div className="room-overview-hero__copy">
          <span className="section-label">Live Room Preview</span>
          <p className="room-overview-hero__eyebrow mono">
            Transmission brief / roster in place / entry path live
          </p>
          <h1>{room.title}</h1>
          <p>{room.topic}</p>
        </div>

        <div className="room-overview-hero__sidecar">
          <div className="room-overview-hero__actions">
            <Badge variant="live" />
            <Badge variant="format" format={room.format} />
            <Badge variant="listener-count" count={room.listenerCount} />
          </div>

          <div className="room-overview-hero__host-card">
            <span className="section-label">Current Host</span>
            <h2>{hostAgent?.name ?? "Murmur"}</h2>
            <p>
              The room is staged and visible now, with the full listening deck
              warming up behind this preview surface.
            </p>
          </div>
        </div>
      </section>

      <div className="room-overview-layout">
        <Card className="room-overview-panel fade-up">
          <div className="room-overview-panel__header">
            <span className="section-label">Stage Roster</span>
            <p>These are the agents currently assigned to the room.</p>
          </div>

          <div className="room-overview-agents">
            {room.agents.map((agent) => (
              <div
                key={agent.id}
                className={[
                  "room-overview-agent",
                  agent.role === "host" ? "room-overview-agent--host" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <span
                  className="room-overview-agent__swatch"
                  style={getAgentAccentStyle(agent)}
                  aria-hidden="true"
                >
                  {getAgentInitial(agent.name)}
                </span>

                <div className="room-overview-agent__copy">
                  <h2>{agent.name}</h2>
                  <p>{agent.role === "host" ? "Host agent" : "Participant agent"}</p>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="room-overview-panel fade-up">
          <div className="room-overview-panel__header">
            <span className="section-label">Signal Brief</span>
            <p>
              A quick read on the room before the full listener controls open:
              who is leading, how the room is structured, and how crowded the
              channel already feels.
            </p>
          </div>

          <div className="room-overview-stats">
            <div className="room-overview-stat">
              <span className="mono">Format</span>
              <p>{room.format === "moderated" ? "Host-guided panel flow." : "Open floor pressure between agents."}</p>
            </div>
            <div className="room-overview-stat">
              <span className="mono">Roster</span>
              <p>{room.agents.length} agents are staged, with {hostAgent?.name ?? "the host"} steering the tone.</p>
            </div>
            <div className="room-overview-stat">
              <span className="mono">Audience</span>
              <p>{room.listenerCount} listeners are already leaning into the conversation.</p>
            </div>
          </div>

          <p className="room-overview-note">
            This preview keeps the room legible and navigable now, while the
            full Murmur listening interface comes online in the next phase.
          </p>

          <div className="room-overview-panel__actions">
            <Link href="/lobby" className="ui-button ui-button--secondary ui-button--md">
              Back to lobby
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}

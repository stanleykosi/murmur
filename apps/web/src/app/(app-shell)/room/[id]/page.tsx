/**
 * Read-only room route scaffold for the Murmur app shell.
 *
 * This page still stops short of the realtime listener runtime, but it now
 * presents the room as a clean listening deck so the route looks intentional
 * while the LiveKit and Centrifugo assembly is completed in later steps.
 */

import type { Metadata } from "next";

import RoomPreviewDeck from "@/components/room/RoomPreviewDeck";
import { fetchRoom } from "@/lib/api";
import type { AgentSummary, Room, TranscriptEntry } from "@/types";

export const revalidate = 10;

const ROOM_FALLBACK_DESCRIPTION =
  "This Murmur room is unavailable right now. Return to the lobby to discover another live conversation.";

interface RoomPageProps {
  params: Promise<{
    id: string;
  }>;
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

interface PreviewLineTemplate {
  agent: AgentSummary;
  content: string;
}

/**
 * Validates that the room contains enough assigned agents to support the
 * current read-only stage preview.
 *
 * @param room - Room payload loaded for the current route.
 * @throws {Error} When the room does not contain the required stage roster.
 */
function assertPreviewRoster(room: Room): void {
  if (room.agents.length < 2) {
    throw new Error(
      `Room "${room.id}" cannot render the preview stage with fewer than 2 agents.`,
    );
  }
}

/**
 * Builds the static transcript preview shown beside the read-only room stage.
 *
 * The transcript copy is intentionally editorial and concise so the scaffold
 * feels premium without pretending to be realtime before the room runtime is
 * actually wired in.
 *
 * @param room - Room payload loaded for the current route.
 * @returns Stable transcript entries for the preview deck.
 */
function buildPreviewTranscript(room: Room): TranscriptEntry[] {
  assertPreviewRoster(room);

  const hostAgent = getHostAgent(room) ?? room.agents[0];

  if (hostAgent === undefined) {
    throw new Error(`Room "${room.id}" is missing a host-capable preview agent.`);
  }

  const firstParticipant =
    room.agents.find((agent) => agent.role !== "host") ?? room.agents[1] ?? hostAgent;
  const secondParticipant =
    room.agents.filter((agent) => agent.role !== "host")[1] ?? hostAgent;

  const previewLineTemplates: PreviewLineTemplate[] = [
    {
      agent: hostAgent,
      content:
        "Let's open with the core tension in this room: the pace of progress is obvious, but the meaning of that progress is still up for debate.",
    },
    {
      agent: firstParticipant ?? hostAgent,
      content:
        "The mistake is turning impressive demos into a timeline forecast. Strong outputs are not the same thing as robust general intelligence.",
    },
    {
      agent: secondParticipant ?? hostAgent,
      content:
        "What matters is whether capability compounds into dependable judgment. That is a technical question, but it is also a social one.",
    },
  ];

  const baseTimestamp = Date.now();

  return previewLineTemplates.map((line, index) => ({
    id: `${room.id}-preview-${index + 1}`,
    roomId: room.id,
    agentId: line.agent.id,
    agentName: line.agent.name,
    content: line.content,
    timestamp: new Date(baseTimestamp - (previewLineTemplates.length - index) * 90_000).toISOString(),
    accentColor: line.agent.accentColor,
    wasFiltered: false,
  }));
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
 * Renders the read-only room listening deck for a single live room.
 *
 * @param props - Dynamic route params supplied by Next.js.
 * @returns The room preview page shown before the realtime room runtime lands.
 */
export default async function RoomPage({
  params,
}: Readonly<RoomPageProps>) {
  const { id } = await params;
  const room = await loadLiveRoom(id);
  const previewTranscript = buildPreviewTranscript(room);

  return (
    <div className="page-shell">
      <RoomPreviewDeck room={room} previewTranscript={previewTranscript} />
    </div>
  );
}

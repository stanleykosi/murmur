/**
 * Canonical live-room route for the Murmur app shell.
 *
 * This server component keeps direct-visit validation and route metadata on
 * the server, while delegating the realtime join handshake and transport
 * orchestration to the client-side `LiveRoom` runtime.
 */

import type { Metadata } from "next";

import LiveRoom from "@/components/room/LiveRoom";
import { fetchRoom } from "@/lib/api";
import type { Room } from "@/types";

export const revalidate = 10;

const ROOM_FALLBACK_DESCRIPTION =
  "This Murmur room is unavailable right now. Return to the lobby to discover another live conversation.";

interface RoomPageProps {
  params: Promise<{
    id: string;
  }>;
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
 * Renders the realtime room route for a single live room.
 *
 * @param props - Dynamic route params supplied by Next.js.
 * @returns The server-validated room route with the client-side live-room runtime.
 */
export default async function RoomPage({
  params,
}: Readonly<RoomPageProps>) {
  const { id } = await params;
  await loadLiveRoom(id);

  return (
    <div className="page-shell">
      <LiveRoom roomId={id} />
    </div>
  );
}

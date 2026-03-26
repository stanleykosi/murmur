"use client";

/**
 * Error boundary for the room scaffold route.
 *
 * Direct navigation can reach ended, invalid, or otherwise unavailable room
 * IDs. This boundary keeps those failures localized and gives listeners a
 * simple escape hatch back to the lobby.
 */

import Link from "next/link";
import { useEffect } from "react";

import Button from "@/components/ui/Button";

interface RoomErrorPageProps {
  error: Error & {
    digest?: string;
  };
  reset: () => void;
}

/**
 * Renders the room-route failure state with retry and return actions.
 *
 * @param props - Error boundary props provided by Next.js.
 * @returns A recoverable room-route error UI.
 */
export default function RoomErrorPage({
  error,
  reset,
}: Readonly<RoomErrorPageProps>) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="page-shell room-overview-page">
      <section className="room-error glass-card fade-up">
        <div className="room-error__copy">
          <span className="section-label">Room Unavailable</span>
          <h1>Room not found or no longer live</h1>
          <p>
            This room could not be loaded as an active Murmur conversation. Retry
            the lookup or head back to the lobby to choose another live room.
          </p>
        </div>

        <div className="room-error__actions">
          <Button onClick={reset} size="lg">
            Retry room
          </Button>
          <Link href="/lobby" className="ui-button ui-button--ghost ui-button--lg">
            Return to lobby
          </Link>
        </div>
      </section>
    </div>
  );
}

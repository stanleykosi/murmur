"use client";

/**
 * Error boundary for the live-room route.
 *
 * Direct navigation can still reach missing or ended room IDs. This boundary
 * keeps those failures localized and gives listeners a fast path back to the
 * lobby without collapsing the surrounding app shell.
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
    <div className="page-shell room-live-page">
      <section className="room-error glass-card fade-up">
        <div className="room-error__copy">
          <span className="section-label">Room Unavailable</span>
          <h1>Room not found or has ended</h1>
          <p>
            This Murmur conversation is no longer available as a live room.
            Retry the lookup or return to the lobby to choose another room.
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

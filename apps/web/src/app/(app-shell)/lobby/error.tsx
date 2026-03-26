"use client";

/**
 * Error boundary for the Murmur lobby route.
 *
 * The lobby depends on the API room feed during rendering. When that request
 * fails, this client boundary gives listeners a fast retry path instead of a
 * blank shell or silent failure.
 */

import Link from "next/link";
import { useEffect } from "react";

import Button from "@/components/ui/Button";

interface LobbyErrorPageProps {
  error: Error & {
    digest?: string;
  };
  reset: () => void;
}

/**
 * Renders the lobby fetch-failure state with a retry affordance.
 *
 * @param props - Error boundary props from Next.js.
 * @returns A recoverable lobby error screen.
 */
export default function LobbyErrorPage({
  error,
  reset,
}: Readonly<LobbyErrorPageProps>) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="page-shell lobby-page">
      <section className="lobby-error glass-card fade-up">
        <div className="lobby-error__copy">
          <span className="section-label">Feed Interrupted</span>
          <h1>Unable to load rooms</h1>
          <p>
            The lobby could not reach the live room feed just now. Retry the
            request or head back to the public homepage while the signal settles.
          </p>
        </div>

        <div className="lobby-error__actions">
          <Button onClick={reset} size="lg">
            Retry lobby
          </Button>
          <Link href="/" className="ui-button ui-button--ghost ui-button--lg">
            Return home
          </Link>
        </div>
      </section>
    </div>
  );
}

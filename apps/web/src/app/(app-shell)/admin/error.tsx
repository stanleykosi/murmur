"use client";

/**
 * Error boundary for the Murmur admin dashboard.
 *
 * The admin route depends on authenticated server data. This boundary keeps
 * failures localized and gives operators an immediate retry path instead of a
 * collapsed app shell.
 */

import Link from "next/link";
import { useEffect } from "react";

import Button from "@/components/ui/Button";

interface AdminErrorPageProps {
  error: Error & {
    digest?: string;
  };
  reset: () => void;
}

/**
 * Renders the admin-route failure state.
 *
 * @param props - Error boundary props supplied by Next.js.
 * @returns A recoverable admin error screen.
 */
export default function AdminErrorPage({
  error,
  reset,
}: Readonly<AdminErrorPageProps>) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="page-shell admin-page">
      <section className="admin-error glass-card fade-up">
        <div className="admin-error__copy">
          <span className="section-label">Operator feed interrupted</span>
          <h1>Unable to load room operations</h1>
          <p>
            The admin dashboard could not load the latest room controls just
            now. Retry the request or return to the lobby while the operator
            connection settles.
          </p>
        </div>

        <div className="admin-error__actions">
          <Button size="lg" onClick={reset}>
            Try again
          </Button>
          <Link href="/lobby" className="ui-button ui-button--ghost ui-button--lg">
            Return to lobby
          </Link>
        </div>
      </section>
    </div>
  );
}

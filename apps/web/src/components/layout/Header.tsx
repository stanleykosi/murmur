/**
 * Persistent top navigation for the Murmur frontend.
 *
 * This server component reads the authenticated Clerk session directly from
 * the App Router request context so the shared site chrome can render the
 * correct auth affordances and admin navigation without fetching app data.
 */

import { UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import Link from "next/link";

/**
 * Renders the fixed site header with navigation and auth controls.
 *
 * @returns The canonical Murmur top navigation bar.
 */
export default async function Header() {
  const { userId, sessionClaims } = await auth();
  const isSignedIn = userId !== null;
  const isAdmin = sessionClaims?.metadata?.role === "admin";

  return (
    <header className="site-header">
      <div className="page-container site-header__inner">
        <Link href="/" className="site-brand" aria-label="Murmur home">
          <span className="site-brand__mark" aria-hidden="true">
            M
          </span>
          <span>Murmur</span>
        </Link>

        <nav className="site-nav" aria-label="Primary">
          <Link href="/lobby" className="site-nav__link">
            Lobby
          </Link>
          {isAdmin ? (
            <Link href="/admin" className="site-nav__link" prefetch={false}>
              Admin
            </Link>
          ) : null}
        </nav>

        <div className="site-header__actions">
          {isSignedIn ? (
            <UserButton />
          ) : (
            <Link href="/sign-in" className="site-nav__link site-nav__link--cta">
              Sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}

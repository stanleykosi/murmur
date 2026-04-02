"use client";

/**
 * Persistent top navigation for the Murmur frontend.
 *
 * This client component reads Clerk auth state in the browser so static and
 * ISR routes such as `/lobby` can keep their cached rendering behavior
 * without opting the shared app shell into request-time server auth.
 */

import { Show, UserButton, useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Minimal record guard used to safely inspect Clerk session claims.
 *
 * @param value - Candidate value to narrow.
 * @returns True when the value is a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type SessionClaims = ReturnType<typeof useAuth>["sessionClaims"];

/**
 * Extracts the custom Murmur role stored in Clerk session metadata.
 *
 * Clerk's auth helpers expose session claims as a generic payload, so this
 * function validates the nested metadata shape before reading the `role`
 * property used for admin navigation.
 *
 * @param sessionClaims - Clerk session claims returned by `useAuth()`.
 * @returns The metadata role string when available, otherwise `null`.
 */
function getSessionRole(sessionClaims: SessionClaims): string | null {
  if (!isRecord(sessionClaims)) {
    return null;
  }

  const metadata = sessionClaims.metadata;

  if (!isRecord(metadata)) {
    return null;
  }

  return typeof metadata.role === "string" ? metadata.role : null;
}

/**
 * Renders the fixed site header with navigation and auth controls.
 *
 * @returns The canonical Murmur top navigation bar.
 */
export default function Header() {
  const { isLoaded, sessionClaims } = useAuth();
  const pathname = usePathname();
  const isAdmin = isLoaded && getSessionRole(sessionClaims) === "admin";

  /**
   * Returns whether the current route belongs to the supplied nav path.
   *
   * @param href - Navigation target to compare against the current pathname.
   * @returns True when the current route should be styled as active.
   */
  function isActiveLink(href: string): boolean {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <header className="site-header">
      <div className="page-container site-header__inner">
        <Link href="/" className="site-brand" aria-label="Murmur home">
          <span className="site-brand__mark" aria-hidden="true">
            M
          </span>
          <span className="site-brand__copy">
            <span className="site-brand__wordmark">Murmur</span>
            <span className="site-brand__eyebrow">Live AI rooms</span>
          </span>
        </Link>

        <nav className="site-nav" aria-label="Primary">
          <Link
            href="/lobby"
            className="site-nav__link"
            aria-current={isActiveLink("/lobby") ? "page" : undefined}
            data-active={isActiveLink("/lobby") ? "true" : "false"}
          >
            Lobby
          </Link>
          {isAdmin ? (
            <Link
              href="/admin"
              className="site-nav__link"
              prefetch={false}
              aria-current={isActiveLink("/admin") ? "page" : undefined}
              data-active={isActiveLink("/admin") ? "true" : "false"}
            >
              Admin
            </Link>
          ) : null}
        </nav>

        <div className="site-header__actions">
          <Show when="signed-in">
            <UserButton />
          </Show>
          <Show when="signed-out">
            <Link href="/sign-in" className="site-nav__link site-nav__link--cta">
              Sign in
            </Link>
          </Show>
        </div>
      </div>
    </header>
  );
}

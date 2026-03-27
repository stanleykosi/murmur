/**
 * Server-rendered admin operations route for Murmur.
 *
 * This route preloads the canonical admin room feed on the server so operators
 * arrive on a truthful, production-backed control surface instead of a client
 * shell that has to rehydrate before showing critical room state.
 */

import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";

import RoomManager from "@/components/admin/RoomManager";
import { fetchAdminRooms } from "@/lib/api";

export const dynamic = "force-dynamic";

const ADMIN_DESCRIPTION =
  "Operate live Murmur rooms with truthful muted-state visibility, room shutdown controls, and a production-grade operator surface.";

/**
 * Route metadata for the admin dashboard.
 */
export const metadata: Metadata = {
  title: "Admin",
  description: ADMIN_DESCRIPTION,
  openGraph: {
    title: "Murmur Admin",
    description: ADMIN_DESCRIPTION,
  },
};

/**
 * Decorative control glyph used by the admin hero panel.
 *
 * @returns A lightweight inline SVG.
 */
function AdminHeroGlyph() {
  return (
    <svg
      className="admin-hero__glyph"
      aria-hidden="true"
      viewBox="0 0 96 96"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="48" cy="48" r="9" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="48" cy="48" r="24" stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
      <circle cx="48" cy="48" r="38" stroke="currentColor" strokeWidth="1.5" opacity="0.28" />
      <path
        d="M48 16v9M48 71v9M16 48h9M71 48h9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Renders the production admin dashboard route.
 *
 * @returns The server-rendered admin room operations surface.
 * @throws {Error} When Clerk does not provide a bearer token for the request.
 */
export default async function AdminPage() {
  const authState = await auth();

  if (typeof authState.getToken !== "function") {
    throw new Error(
      "Clerk did not provide an admin session token resolver for the Murmur admin route.",
    );
  }

  const token = await authState.getToken();

  if (token === null || token.trim().length === 0) {
    throw new Error(
      "Clerk did not provide a valid admin bearer token for the Murmur admin route.",
    );
  }

  const rooms = await fetchAdminRooms({ token });

  return (
    <div className="page-shell admin-page">
      <section className="admin-hero glass-card fade-up">
        <div className="admin-hero__copy">
          <span className="section-label">Operator Console</span>
          <p className="admin-hero__ledger mono">
            Truthful state / room controls / live moderation
          </p>
          <h1>Operate Murmur rooms without guessing what production is doing.</h1>
          <p>
            This control surface reads the same persisted admin room feed the
            backend exposes, including Redis-backed mute state, so ending rooms
            and controlling agents stays grounded in the actual runtime state.
          </p>
        </div>

        <div className="admin-hero__panel">
          <div className="admin-hero__signal">
            <span className="admin-hero__ring admin-hero__ring--outer" />
            <span className="admin-hero__ring admin-hero__ring--inner" />
            <AdminHeroGlyph />
            <div className="admin-hero__signal-tag">
              <span className="mono">Operator signal</span>
              <p>Room state, mute state, and teardown flow stay aligned.</p>
            </div>
          </div>

          <div className="admin-hero__principles">
            <div className="admin-hero__principle">
              <span className="mono">01</span>
              <p>Muted state reflects Redis after refresh instead of session-local guesswork.</p>
            </div>
            <div className="admin-hero__principle">
              <span className="mono">02</span>
              <p>End-room flow makes destructive consequences explicit before listeners are disconnected.</p>
            </div>
            <div className="admin-hero__principle">
              <span className="mono">03</span>
              <p>Partial teardown failures surface clearly so operators can retry cleanup instead of assuming success.</p>
            </div>
          </div>
        </div>
      </section>

      <RoomManager initialRooms={rooms} />
    </div>
  );
}

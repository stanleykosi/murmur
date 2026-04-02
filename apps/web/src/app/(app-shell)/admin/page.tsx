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
          <span className="section-label">Operator console</span>
          <p className="admin-hero__ledger mono">Truthful room state / moderation controls / fast intervention</p>
          <h1>Operate rooms from one calm, readable surface.</h1>
          <p>
            Room state, listener counts, and mute controls all stay grounded in
            the same persisted admin feed, so operators can act quickly without
            scanning through decorative noise first.
          </p>
        </div>

        <div className="admin-hero__panel">
          <div className="admin-hero__principles">
            <div className="admin-hero__principle">
              <span className="mono">Truth</span>
              <p>Muted state and room state stay aligned with persisted backend data after every refresh.</p>
            </div>
            <div className="admin-hero__principle">
              <span className="mono">Control</span>
              <p>Agent muting and room shutdown remain easy to find, but clearly separated from passive room details.</p>
            </div>
            <div className="admin-hero__principle">
              <span className="mono">Recovery</span>
              <p>Partial teardown failures surface clearly so operators can retry with context instead of assuming success.</p>
            </div>
          </div>
        </div>
      </section>

      <RoomManager initialRooms={rooms} />
    </div>
  );
}

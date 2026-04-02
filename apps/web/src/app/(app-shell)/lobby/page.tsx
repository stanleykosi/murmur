/**
 * ISR lobby route for Murmur listeners.
 *
 * This page renders immediately with static editorial framing, then streams in
 * the live room grid through a Suspense-wrapped server component so the route
 * stays SEO-friendly and cacheable while still using the canonical API client.
 */

import type { Metadata } from "next";
import { Suspense } from "react";

import RoomGrid from "@/components/lobby/RoomGrid";
import RoomGridSkeleton from "@/components/lobby/RoomGridSkeleton";
import { fetchRooms } from "@/lib/api";

export const revalidate = 10;

const LOBBY_DESCRIPTION =
  "Browse Murmur's live AI conversations, compare formats, and drop into the room that already matches your mood.";

/**
 * Route metadata for the public lobby page.
 */
export const metadata: Metadata = {
  title: "Lobby",
  description: LOBBY_DESCRIPTION,
  openGraph: {
    title: "Murmur Lobby",
    description: LOBBY_DESCRIPTION,
  },
};

/**
 * Streams the live room list through the canonical frontend API client.
 *
 * @returns The hydrated lobby room grid.
 */
async function LobbyRoomsSection() {
  const rooms = await fetchRooms("live");

  return <RoomGrid rooms={rooms} />;
}

/**
 * Renders the Murmur lobby page with a static intro and streamed room grid.
 *
 * @returns The public `/lobby` route.
 */
export default function LobbyPage() {
  return (
    <div className="page-shell lobby-page">
      <section className="lobby-hero glass-card fade-up">
        <div className="lobby-hero__copy">
          <span className="section-label">Rooms already in motion</span>
          <p className="lobby-hero__signal-ledger mono">Live discovery / AI hosts / instant entry</p>
          <h1>Find a room that already sounds worth your time.</h1>
          <p>
            Browse active conversations, compare room formats quickly, and jump
            straight into the stream without wading through a noisy interface.
          </p>
        </div>

        <div className="lobby-hero__panel">
          <div className="lobby-hero__metrics">
            <div className="lobby-hero__metric">
              <span className="mono">10s</span>
              <p>Lobby content revalidates frequently so the room deck stays fresh without turning the page into a live dashboard.</p>
            </div>
            <div className="lobby-hero__metric">
              <span className="mono">2 modes</span>
              <p>Free-for-all rooms and host-led panels stay visually distinct, so format choice takes seconds instead of guesswork.</p>
            </div>
            <div className="lobby-hero__metric">
              <span className="mono">1 click</span>
              <p>Room cards prioritize the topic, active roster, and current audience so discovery already feels like entry.</p>
            </div>
          </div>
        </div>
      </section>

      <Suspense fallback={<RoomGridSkeleton />}>
        <LobbyRoomsSection />
      </Suspense>
    </div>
  );
}

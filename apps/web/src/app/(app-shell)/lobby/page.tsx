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
 * Static signal glyph used by the lobby hero.
 *
 * @returns A decorative SVG matching the live-room motif.
 */
function LobbySignalGlyph() {
  return (
    <svg
      className="lobby-hero__glyph"
      aria-hidden="true"
      viewBox="0 0 96 96"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="48" cy="48" r="8" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="48" cy="48" r="22" stroke="currentColor" strokeWidth="1.5" opacity="0.72" />
      <circle cx="48" cy="48" r="36" stroke="currentColor" strokeWidth="1.5" opacity="0.36" />
      <path
        d="M48 12v10M48 74v10M12 48h10M74 48h10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Decorative waveform used to give the lobby hero a stronger sense of motion.
 *
 * @returns A compact waveform SVG rendered beside the signal field.
 */
function LobbyWaveformGlyph() {
  return (
    <svg
      className="lobby-hero__waveform"
      aria-hidden="true"
      viewBox="0 0 180 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M2 33.5h16l8-12 16 25 12-18 14 11 12-16 15 8 12-12 13 20 12-10 14 4 18-17"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

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
          <span className="section-label">Rooms Already In Motion</span>
          <p className="lobby-hero__signal-ledger mono">
            Discovery deck / live rooms / open channels
          </p>
          <h1>
            Choose the conversation wave that feels{" "}
            <span className="lobby-hero__title-accent">alive</span> right now.
          </h1>
          <p>
            Murmur keeps the lobby warm: live listener counts, format lanes, and
            the current agent lineup are all waiting before you ever enter a room.
          </p>
        </div>

        <div className="lobby-hero__panel">
          <div className="lobby-hero__signal-field">
            <span className="lobby-hero__signal-ring lobby-hero__signal-ring--outer" />
            <span className="lobby-hero__signal-ring lobby-hero__signal-ring--inner" />
            <LobbySignalGlyph />
            <div className="lobby-hero__signal-tag">
              <span className="mono">Live Signal</span>
              <p>Rooms are already underway.</p>
            </div>
          </div>
          <LobbyWaveformGlyph />
          <div className="lobby-hero__metrics">
            <div className="lobby-hero__metric">
              <span className="mono">01</span>
              <p>Host-led panels and open debate rooms sit side by side without flattening into the same visual card.</p>
            </div>
            <div className="lobby-hero__metric">
              <span className="mono">02</span>
              <p>Listener counts, format cues, and roster accents all come from the same canonical room feed.</p>
            </div>
            <div className="lobby-hero__metric">
              <span className="mono">03</span>
              <p>Every card opens into a real room surface, so discovery already feels like entry instead of a dead-end preview.</p>
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

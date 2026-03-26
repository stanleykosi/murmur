/**
 * Public Murmur landing page for signed-out visitors.
 *
 * This route is the canonical first-touch surface for the product: it gives
 * new listeners a strong overview of the live AI-audio experience while
 * sending authenticated users directly to the lobby with a server redirect.
 */

import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { CSSProperties } from "react";

interface LandingHighlight {
  title: string;
  description: string;
}

type WaveBarStyle = CSSProperties & {
  "--wave-bar-delay": string;
  "--wave-bar-height": string;
};

const LANDING_HIGHLIGHTS: readonly LandingHighlight[] = [
  {
    title: "Always-on rooms",
    description: "Jump into live debates already in motion.",
  },
  {
    title: "Distinct voices",
    description:
      "Each Murmur agent speaks with a persistent personality and voice.",
  },
  {
    title: "Live transcript",
    description:
      "Follow every exchange with synchronized text as the conversation unfolds.",
  },
] as const;

const SOUND_WAVE_BARS = [
  { height: "36%", delay: "0s" },
  { height: "68%", delay: "0.08s" },
  { height: "52%", delay: "0.16s" },
  { height: "82%", delay: "0.24s" },
  { height: "44%", delay: "0.32s" },
  { height: "94%", delay: "0.4s" },
  { height: "58%", delay: "0.48s" },
  { height: "76%", delay: "0.56s" },
  { height: "46%", delay: "0.64s" },
  { height: "88%", delay: "0.72s" },
  { height: "54%", delay: "0.8s" },
  { height: "70%", delay: "0.88s" },
] as const;

/**
 * Route metadata for Murmur's marketing entry point.
 */
export const metadata: Metadata = {
  title: "AI Conversations You Can Listen To",
  description:
    "Murmur streams live AI-hosted conversations with distinct voices, live transcripts, and rooms you can join instantly.",
};

/**
 * Builds the inline custom-property map for a deterministic wave bar.
 *
 * @param height - Base rendered height for the bar.
 * @param delay - Animation delay used to stagger the wave motion.
 * @returns A CSS custom-property object compatible with React inline styles.
 */
function createWaveBarStyle(height: string, delay: string): WaveBarStyle {
  return {
    "--wave-bar-delay": delay,
    "--wave-bar-height": height,
  };
}

/**
 * Renders the Murmur homepage for signed-out visitors.
 *
 * Authenticated listeners are redirected server-side to the lobby so the root
 * route cleanly serves either product discovery or immediate app entry.
 *
 * @returns The immersive Murmur landing page or a lobby redirect.
 */
export default async function HomePage() {
  const { userId } = await auth();

  if (userId !== null) {
    redirect("/lobby");
  }

  return (
    <section className="landing-page fade-up">
      <div className="landing-hero">
        <div className="landing-copy">
          <span className="section-label">Live AI audio</span>
          <h1>AI conversations you can listen to</h1>
          <p>
            Tune into always-on rooms where Murmur&apos;s house agents debate
            tech, culture, and big ideas in real time. Every room pairs
            distinct AI voices with a live transcript so you can drop in
            instantly and follow every turn.
          </p>

          <div className="landing-actions">
            <Link
              href="/lobby"
              className="ui-button ui-button--primary ui-button--lg"
            >
              Enter the lobby
            </Link>
          </div>
        </div>

        <div className="landing-visual glass-card" aria-hidden="true">
          <div className="landing-wave">
            {SOUND_WAVE_BARS.map((bar) => (
              <span
                key={`${bar.height}-${bar.delay}`}
                className="landing-wave__bar"
                style={createWaveBarStyle(bar.height, bar.delay)}
              />
            ))}
          </div>
        </div>
      </div>

      <ul className="landing-highlights" role="list">
        {LANDING_HIGHLIGHTS.map((highlight) => (
          <li key={highlight.title} className="landing-highlight glass-card">
            <h2>{highlight.title}</h2>
            <p>{highlight.description}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

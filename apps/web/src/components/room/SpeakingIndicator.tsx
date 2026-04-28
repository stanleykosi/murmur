/**
 * Animated speaking-state halo for Murmur room avatars.
 */

import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

const RING_CONFIG = [
  { delay: "0s", size: "72%" },
  { delay: "0.3s", size: "84%" },
  { delay: "0.6s", size: "96%" },
] as const;

type SpeakingIndicatorStyle = CSSProperties & {
  "--agent-accent": string;
};

type SpeakingRingStyle = CSSProperties & {
  "--ring-delay": string;
  "--ring-size": string;
};

export interface SpeakingIndicatorProps {
  agentColor: string;
  className?: string;
  isHost: boolean;
  isSpeaking: boolean;
}

/**
 * Validates that a required string prop is present for the visual treatment.
 *
 * @param value - Candidate prop value.
 * @param label - Human-readable prop name for diagnostics.
 * @returns The trimmed string value.
 * @throws {Error} When the value is blank.
 */
function assertRequiredString(value: string, label: string): string {
  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new Error(`SpeakingIndicator requires a non-empty ${label}.`);
  }

  return normalizedValue;
}

/**
 * Creates the CSS variable payload driving the accent-tinted pulse effect.
 *
 * @param agentColor - Accent color associated with the current agent.
 * @returns Inline styles containing the accent CSS custom property.
 */
function getIndicatorStyle(agentColor: string): SpeakingIndicatorStyle {
  return {
    "--agent-accent": assertRequiredString(agentColor, "agentColor"),
  };
}

/**
 * Creates the ring-level animation variables for a single pulse layer.
 *
 * @param delay - Staggered animation delay for the ring.
 * @param size - Base size for the ring within the shared frame.
 * @returns Inline styles containing ring-specific CSS custom properties.
 */
function getRingStyle(delay: string, size: string): SpeakingRingStyle {
  return {
    "--ring-delay": delay,
    "--ring-size": size,
  };
}

/**
 * Renders the animated speaking halo for the current active speaker.
 *
 * @param props - Speaking state and accent styling configuration.
 * @returns The layered ring treatment, or `null` when the agent is idle.
 */
export default function SpeakingIndicator({
  agentColor,
  className,
  isHost,
  isSpeaking,
}: Readonly<SpeakingIndicatorProps>) {
  if (!isSpeaking) {
    return null;
  }

  return (
    <span
      className={cn(
        "room-speaking-indicator",
        isHost && "room-speaking-indicator--host",
        className,
      )}
      style={getIndicatorStyle(agentColor)}
      data-testid="speaking-indicator"
      aria-hidden="true"
    >
      <span className="room-speaking-indicator__aura" />
      <span className="room-speaking-indicator__host-glow" />
      {RING_CONFIG.map((ring) => (
        <span
          key={`${ring.delay}-${ring.size}`}
          className="room-speaking-indicator__ring pulse-ring"
          style={getRingStyle(ring.delay, ring.size)}
        />
      ))}
    </span>
  );
}

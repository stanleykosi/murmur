/**
 * Premium agent avatar presentation for the Murmur live room stage.
 *
 * This component is intentionally image-led and cinematic, carrying the same
 * editorial identity and material depth established by the landing page into
 * the real-time listening interface.
 */

import Image from "next/image";
import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

import SpeakingIndicator from "./SpeakingIndicator";

const AVATAR_SIZE_MAP = {
  sm: 40,
  md: 80,
  lg: 120,
} as const;

type AgentAccentStyle = CSSProperties & {
  "--agent-accent": string;
};

export type AgentAvatarSize = keyof typeof AVATAR_SIZE_MAP;

export interface AgentAvatarProps {
  accentColor: string;
  avatarUrl: string;
  className?: string;
  isHost: boolean;
  isSpeaking?: boolean;
  name: string;
  size?: AgentAvatarSize;
}

/**
 * Renders the crown badge used to identify the room host.
 *
 * @returns A decorative crown icon.
 */
function CrownIcon() {
  return (
    <svg
      className="room-agent-avatar__host-icon"
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M5.25 17.5h13.5m-12-8.75 3.2 3.55 2.05-5 2 5 3.25-3.55L18.75 17.5h-13.5l1.5-8.75Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Validates that a required string prop is present.
 *
 * @param value - Candidate prop value.
 * @param label - Human-readable prop name for diagnostics.
 * @returns The trimmed string value.
 * @throws {Error} When the value is blank.
 */
function assertRequiredString(value: string, label: string): string {
  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new Error(`AgentAvatar requires a non-empty ${label}.`);
  }

  return normalizedValue;
}

/**
 * Builds the accent-color CSS variables for the avatar shell.
 *
 * @param accentColor - Canonical accent color for the current agent.
 * @returns Inline styles containing the accent color custom property.
 */
function getAgentAccentStyle(accentColor: string): AgentAccentStyle {
  return {
    "--agent-accent": assertRequiredString(accentColor, "accentColor"),
  };
}

/**
 * Renders the premium live-room avatar treatment for a single agent.
 *
 * @param props - Identity, state, and sizing props for the stage avatar.
 * @returns A styled avatar figure with optional host and speaking treatments.
 */
export default function AgentAvatar({
  accentColor,
  avatarUrl,
  className,
  isHost,
  isSpeaking = false,
  name,
  size = "md",
}: Readonly<AgentAvatarProps>) {
  const resolvedName = assertRequiredString(name, "name");
  const resolvedAvatarUrl = assertRequiredString(avatarUrl, "avatarUrl");
  const pixelSize = AVATAR_SIZE_MAP[size];

  return (
    <figure
      className={cn(
        "room-agent-avatar",
        `room-agent-avatar--${size}`,
        isHost && "room-agent-avatar--host",
        isSpeaking && "room-agent-avatar--speaking",
        className,
      )}
      style={getAgentAccentStyle(accentColor)}
      data-testid="agent-avatar"
    >
      <div className="room-agent-avatar__frame">
        <SpeakingIndicator
          agentColor={accentColor}
          isHost={isHost}
          isSpeaking={isSpeaking}
        />

        <div className="room-agent-avatar__media">
          <Image
            src={resolvedAvatarUrl}
            alt={`${resolvedName} portrait`}
            width={pixelSize}
            height={pixelSize}
            sizes={`${pixelSize}px`}
            className="room-agent-avatar__image"
            priority={size === "lg"}
          />
        </div>

        {isHost ? (
          <span className="room-agent-avatar__host-badge">
            <CrownIcon />
            <span className="sr-only">Host agent</span>
          </span>
        ) : null}
      </div>

      <figcaption className="room-agent-avatar__label">{resolvedName}</figcaption>
    </figure>
  );
}

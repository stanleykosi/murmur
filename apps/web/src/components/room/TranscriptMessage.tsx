/**
 * Individual live transcript message for the Murmur room transcript panel.
 *
 * The message component keeps transcript presentation focused and readable:
 * accent-colored speaker identity, relative timing, and a calm editorial card
 * treatment that can be streamed repeatedly without overwhelming the page.
 */

import type { CSSProperties } from "react";

import { cn, formatRelativeTime, formatTimestamp } from "@/lib/utils";
import type { TranscriptEntry } from "@/types";

type TranscriptAccentStyle = CSSProperties & {
  "--transcript-accent": string;
};

export interface TranscriptMessageProps {
  className?: string;
  entry: TranscriptEntry;
}

/**
 * Validates the accent color supplied by the transcript stream.
 *
 * @param accentColor - Accent color associated with the transcript speaker.
 * @returns Inline styles carrying the transcript accent variable.
 * @throws {TypeError} When the accent color is not a string.
 * @throws {Error} When the accent color is empty.
 */
function getTranscriptAccentStyle(accentColor: string): TranscriptAccentStyle {
  if (typeof accentColor !== "string") {
    throw new TypeError("TranscriptMessage requires accentColor to be a string.");
  }

  const normalizedAccentColor = accentColor.trim();

  if (normalizedAccentColor.length === 0) {
    throw new Error("TranscriptMessage requires a non-empty accentColor.");
  }

  return {
    "--transcript-accent": normalizedAccentColor,
  };
}

/**
 * Renders a single transcript entry with speaker, timestamp, and message copy.
 *
 * @param props - Transcript entry data and optional styling hooks.
 * @returns A styled transcript message article.
 */
export default function TranscriptMessage({
  className,
  entry,
}: Readonly<TranscriptMessageProps>) {
  return (
    <article
      className={cn("room-transcript-message", className)}
      style={getTranscriptAccentStyle(entry.accentColor)}
    >
      <header className="room-transcript-message__meta">
        <span className="room-transcript-message__speaker">
          {entry.agentName}
        </span>
        <time
          className="room-transcript-message__timestamp mono"
          dateTime={entry.timestamp}
          title={formatTimestamp(entry.timestamp)}
        >
          {formatRelativeTime(entry.timestamp)}
        </time>
      </header>

      <p className="room-transcript-message__content">{entry.content}</p>
    </article>
  );
}

"use client";

/**
 * Scrollable live transcript panel for the Murmur room experience.
 *
 * This component owns transcript-specific interaction behavior: a smart
 * auto-scroll that respects listeners who scroll upward, a connection status
 * banner for reconnects, and an optional ARIA-live mode for accessibility.
 */

import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";
import type { TranscriptEntry } from "@/types";

import TranscriptMessage from "./TranscriptMessage";

const AUTO_SCROLL_THRESHOLD_PX = 96;

export interface TranscriptPanelProps {
  accessibilityMode?: boolean;
  className?: string;
  entries: readonly TranscriptEntry[];
  isConnected: boolean;
}

/**
 * Returns the status copy matching the current transcript connection state.
 *
 * @param hasEntries - Whether the panel has already rendered transcript items.
 * @returns The user-facing connection status label.
 */
function getConnectionStatusCopy(hasEntries: boolean): string {
  return hasEntries ? "Transcript reconnecting..." : "Connecting transcript...";
}

/**
 * Determines whether the transcript viewport is currently near the bottom.
 *
 * @param viewport - Scroll viewport element for the transcript list.
 * @returns True when the viewport is near enough to the bottom to auto-scroll.
 */
function isViewportNearBottom(viewport: HTMLDivElement): boolean {
  const distanceFromBottom =
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;

  return distanceFromBottom <= AUTO_SCROLL_THRESHOLD_PX;
}

/**
 * Renders the live transcript panel with smart auto-scroll behavior.
 *
 * @param props - Transcript entries, connectivity state, and accessibility hooks.
 * @returns A transcript surface ready for live room assembly.
 */
export default function TranscriptPanel({
  accessibilityMode = false,
  className,
  entries,
  isConnected,
}: Readonly<TranscriptPanelProps>) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const hasHydratedRef = useRef(false);

  useEffect(() => {
    const viewport = viewportRef.current;

    if (viewport === null || !shouldStickToBottomRef.current) {
      hasHydratedRef.current = true;
      return;
    }

    const animationFrameId = window.requestAnimationFrame(() => {
      viewport.scrollTo({
        top: viewport.scrollHeight,
        behavior: hasHydratedRef.current ? "smooth" : "auto",
      });
      hasHydratedRef.current = true;
    });

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [entries.length]);

  /**
   * Tracks whether the listener still wants the viewport pinned to the latest
   * transcript entries or has intentionally scrolled upward to review context.
   */
  function handleViewportScroll() {
    const viewport = viewportRef.current;

    if (viewport === null) {
      return;
    }

    shouldStickToBottomRef.current = isViewportNearBottom(viewport);
  }

  return (
    <section
      className={cn("room-transcript-panel glass-card", className)}
      data-testid="transcript-panel"
      aria-label="Live transcript"
    >
      <header className="room-transcript-panel__header">
        <div className="room-transcript-panel__heading">
          <span className="section-label">Transcript</span>
          <h2>Conversation feed</h2>
        </div>

        {!isConnected ? (
          <span className="room-transcript-panel__status" role="status">
            {getConnectionStatusCopy(entries.length > 0)}
          </span>
        ) : null}
      </header>

      <div
        ref={viewportRef}
        className="room-transcript-panel__viewport scrollbar-subtle"
        onScroll={handleViewportScroll}
        role={accessibilityMode ? "log" : undefined}
        aria-live={accessibilityMode ? "polite" : undefined}
        aria-atomic={accessibilityMode ? "false" : undefined}
        aria-relevant={accessibilityMode ? "additions text" : undefined}
      >
        {entries.length > 0 ? (
          <div className="room-transcript-panel__messages">
            {entries.map((entry) => (
              <TranscriptMessage key={entry.id} entry={entry} />
            ))}
          </div>
        ) : (
          <div className="room-transcript-panel__empty">
            <span className="section-label">Standby</span>
            <h3>No transcript yet</h3>
            <p>
              Spoken turns will begin streaming here as soon as the agents take
              the floor.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

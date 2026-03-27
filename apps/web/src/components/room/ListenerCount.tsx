"use client";

/**
 * Animated listener-count display for the Murmur live room header.
 *
 * This component surfaces the current audience size with a subtle motion cue
 * whenever the value changes, helping the room feel alive without introducing
 * noisy counters or secondary state management.
 */

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

const listenerCountFormatter = new Intl.NumberFormat("en-US");
const COUNT_CHANGE_ANIMATION_MS = 320;

export interface ListenerCountProps {
  className?: string;
  count: number;
}

/**
 * Validates and normalizes the live listener count before rendering.
 *
 * @param count - Raw listener count supplied by the room runtime.
 * @returns The validated listener count.
 * @throws {TypeError} When the count is not a safe integer.
 * @throws {RangeError} When the count is negative.
 */
function normalizeListenerCount(count: number): number {
  if (!Number.isSafeInteger(count)) {
    throw new TypeError("ListenerCount requires a safe integer count.");
  }

  if (count < 0) {
    throw new RangeError("ListenerCount does not accept negative values.");
  }

  return count;
}

/**
 * Renders the decorative audience icon used beside the numeric listener count.
 *
 * @returns A presentational inline SVG icon.
 */
function AudienceIcon() {
  return (
    <svg
      className="room-listener-count__icon"
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M4.417 10a5.583 5.583 0 1 1 11.166 0v4a1.25 1.25 0 0 1-1.25 1.25h-.75a1.25 1.25 0 0 1-1.25-1.25v-2.667a1.25 1.25 0 0 1 1.25-1.25h.75a3.333 3.333 0 0 0-6.666 0h.75a1.25 1.25 0 0 1 1.25 1.25V14a1.25 1.25 0 0 1-1.25 1.25h-.75A1.25 1.25 0 0 1 4.417 14v-4Z"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Renders the live listener count with a small bump animation on updates.
 *
 * @param props - Current listener count and optional styling hooks.
 * @returns A listener-count pill used by live room surfaces.
 */
export default function ListenerCount({
  className,
  count,
}: Readonly<ListenerCountProps>) {
  const normalizedCount = normalizeListenerCount(count);
  const [isAnimating, setIsAnimating] = useState(false);
  const previousCountRef = useRef<number | null>(null);

  useEffect(() => {
    if (previousCountRef.current === null) {
      previousCountRef.current = normalizedCount;
      return;
    }

    if (previousCountRef.current === normalizedCount) {
      return;
    }

    previousCountRef.current = normalizedCount;
    setIsAnimating(true);

    const timeoutId = window.setTimeout(() => {
      setIsAnimating(false);
    }, COUNT_CHANGE_ANIMATION_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [normalizedCount]);

  const audienceLabel =
    normalizedCount === 1
      ? "1 listener tuned in"
      : `${listenerCountFormatter.format(normalizedCount)} listeners tuned in`;

  return (
    <div
      className={cn(
        "room-listener-count",
        isAnimating && "room-listener-count--animating",
        className,
      )}
      aria-label={audienceLabel}
      aria-live="polite"
      aria-atomic="true"
      data-testid="listener-count"
    >
      <AudienceIcon />
      <span className="room-listener-count__copy">
        <span className="room-listener-count__value mono">
          {listenerCountFormatter.format(normalizedCount)}
        </span>
        <span className="room-listener-count__label">
          {normalizedCount === 1 ? "listener tuned in" : "listeners tuned in"}
        </span>
      </span>
    </div>
  );
}

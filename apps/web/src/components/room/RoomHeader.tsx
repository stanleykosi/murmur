"use client";

/**
 * Sticky live-room header for the Murmur listening experience.
 *
 * The header keeps the room identity, audience pulse, and leave action visible
 * while listeners move through the stage and transcript, giving the room page
 * a clear control anchor before the full live-room assembly lands.
 */

import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import { cn } from "@/lib/utils";

import ListenerCount from "./ListenerCount";

export interface RoomHeaderProps {
  className?: string;
  isLeaving?: boolean;
  listenerCount: number;
  onLeave: () => Promise<void> | void;
  title: string;
  topic: string;
}

/**
 * Ensures required header copy is present before rendering.
 *
 * @param value - Candidate room title or topic string.
 * @param label - Human-readable label used in diagnostics.
 * @returns The trimmed string value.
 * @throws {TypeError} When the value is not a string.
 * @throws {Error} When the value is empty.
 */
function normalizeRequiredText(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`RoomHeader requires ${label} to be a string.`);
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new Error(`RoomHeader requires a non-empty ${label}.`);
  }

  return normalizedValue;
}

/**
 * Renders the sticky room header with live state and leave-room action.
 *
 * @param props - Room identity, audience size, and leave-room behavior.
 * @returns A sticky room header used by the live room route.
 */
export default function RoomHeader({
  className,
  isLeaving = false,
  listenerCount,
  onLeave,
  title,
  topic,
}: Readonly<RoomHeaderProps>) {
  const normalizedTitle = normalizeRequiredText(title, "title");
  const normalizedTopic = normalizeRequiredText(topic, "topic");

  return (
    <section className={cn("room-header glass-card", className)}>
      <div className="room-header__topline">
        <div className="room-header__status-cluster">
          <span className="section-label">Live room</span>
          <div className="room-header__status-pills">
            <Badge variant="live" />
            <ListenerCount count={listenerCount} />
          </div>
        </div>

        <Button
          variant="ghost"
          size="sm"
          loading={isLeaving}
          onClick={() => {
            void onLeave();
          }}
        >
          Leave room
        </Button>
      </div>

      <div className="room-header__copy">
        <h1 className="room-header__title">{normalizedTitle}</h1>
        <p className="room-header__topic">{normalizedTopic}</p>
      </div>
    </section>
  );
}

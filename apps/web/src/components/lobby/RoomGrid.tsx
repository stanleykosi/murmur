"use client";

/**
 * Responsive client-side room grid for the Murmur lobby.
 *
 * The grid owns only presentational filter state. Room data still arrives from
 * the ISR server page so the product keeps a single canonical data-fetching
 * path through the typed frontend API client.
 */

import {
  startTransition,
  useDeferredValue,
  useState,
} from "react";

import type { Room } from "@/types";

import RoomCard from "./RoomCard";
import RoomFilters, { type LobbyFormatFilter } from "./RoomFilters";

/**
 * Public props for the lobby room grid.
 */
export interface RoomGridProps {
  rooms: Room[];
}

interface EmptyStateCopy {
  description: string;
  title: string;
}

/**
 * Returns the empty-state copy matching the currently selected lobby filter.
 *
 * @param filter - Active lobby filter selected by the listener.
 * @param hasLiveRooms - Whether any live rooms exist before filter narrowing.
 * @returns Filter-aware empty-state messaging.
 */
function getEmptyStateCopy(
  filter: LobbyFormatFilter,
  hasLiveRooms: boolean,
): EmptyStateCopy {
  if (!hasLiveRooms) {
    return {
      description:
        "New AI conversations will surface here as soon as they go live. Check back in a moment for the next signal burst.",
      title: "No live rooms right now",
    };
  }

  if (filter === "moderated") {
    return {
      description:
        "There are no host-led panels live at the moment. Try switching back to the full lobby feed.",
      title: "No moderated rooms live yet",
    };
  }

  if (filter === "free_for_all") {
    return {
      description:
        "The open-debate lane is quiet for now. Try the moderated feed or return to the full live list.",
      title: "No free-for-all rooms live yet",
    };
  }

  return {
    description:
      "No rooms match the current filter. Try another format to reopen the full signal field.",
    title: "No rooms match this filter",
  };
}

/**
 * Decorative icon used by the empty-state panel.
 *
 * @returns A lightweight SVG illustration for the empty lobby state.
 */
function EmptyStateIcon() {
  return (
    <svg
      className="lobby-empty__icon"
      aria-hidden="true"
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M16 22.5c0-4.694 3.806-8.5 8.5-8.5h15c4.694 0 8.5 3.806 8.5 8.5v19c0 4.694-3.806 8.5-8.5 8.5h-15c-4.694 0-8.5-3.806-8.5-8.5v-19Z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M24 28h16M24 34h16M24 40h10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="49.5" cy="18.5" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12.5" cy="45.5" r="3.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/**
 * Renders the filterable room grid used by the ISR lobby page.
 *
 * @param props - Lobby room data fetched by the surrounding server route.
 * @returns A responsive grid or an empty state when no matching rooms exist.
 */
export default function RoomGrid({ rooms }: Readonly<RoomGridProps>) {
  const [activeFilter, setActiveFilter] = useState<LobbyFormatFilter>("all");
  const deferredFilter = useDeferredValue(activeFilter);
  const visibleRooms = rooms.filter((room) =>
    deferredFilter === "all" ? true : room.format === deferredFilter,
  );
  const emptyState = getEmptyStateCopy(deferredFilter, rooms.length > 0);

  return (
    <section className="lobby-grid-shell fade-up" data-testid="room-grid">
      <RoomFilters
        totalCount={rooms.length}
        value={activeFilter}
        visibleCount={visibleRooms.length}
        onChange={(nextFilter) => {
          // Keep filter changes responsive even if a large room list ever lands.
          startTransition(() => {
            setActiveFilter(nextFilter);
          });
        }}
      />

      {visibleRooms.length > 0 ? (
        <div className="lobby-grid">
          {visibleRooms.map((room) => (
            <RoomCard key={room.id} room={room} />
          ))}
        </div>
      ) : (
        <div className="lobby-empty glass-card">
          <EmptyStateIcon />
          <div className="lobby-empty__copy">
            <span className="section-label">Standby</span>
            <h2>{emptyState.title}</h2>
            <p>{emptyState.description}</p>
          </div>
        </div>
      )}
    </section>
  );
}

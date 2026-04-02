"use client";

/**
 * Format-filter controls for the Murmur room lobby.
 *
 * This component stays intentionally focused on the single lobby filtering
 * concern for the current product surface: listeners can switch between all
 * live rooms, moderated rooms, and free-for-all rooms without introducing a
 * broader search or sort system.
 */

import type { RoomFormat } from "@/types";
import { cn } from "@/lib/utils";

/**
 * Canonical format filter values supported by the room lobby.
 */
export type LobbyFormatFilter = "all" | RoomFormat;

interface LobbyFilterOption {
  description: string;
  label: string;
  value: LobbyFormatFilter;
}

/**
 * Public props for the room-filter toolbar.
 */
export interface RoomFiltersProps {
  totalCount: number;
  value: LobbyFormatFilter;
  visibleCount: number;
  onChange: (nextFilter: LobbyFormatFilter) => void;
}

const FILTER_OPTIONS = [
  {
    description: "Show every room currently live in the lobby.",
    label: "All",
    value: "all",
  },
  {
    description: "Show only free-for-all rooms with open AI debate energy.",
    label: "Free-for-all",
    value: "free_for_all",
  },
  {
    description: "Show only moderated rooms led by a host agent.",
    label: "Moderated",
    value: "moderated",
  },
] as const satisfies readonly LobbyFilterOption[];

/**
 * Formats a room count for the lobby summary line.
 *
 * @param count - Number of rooms to display.
 * @returns A localized room-count label.
 */
function formatRoomCount(count: number): string {
  const formattedCount = new Intl.NumberFormat("en-US").format(count);

  return count === 1 ? "1 room live" : `${formattedCount} rooms live`;
}

/**
 * Renders the room-format filter controls used by the lobby grid.
 *
 * @param props - Controlled filter props from the room grid.
 * @returns A toolbar with live-room summaries and filter toggles.
 */
export default function RoomFilters({
  totalCount,
  value,
  visibleCount,
  onChange,
}: Readonly<RoomFiltersProps>) {
  const isFiltered = value !== "all";
  const summary = isFiltered
    ? `${formatRoomCount(visibleCount)} matching ${value === "moderated" ? "the moderated feed" : "the free-for-all feed"}.`
    : `${formatRoomCount(totalCount)} across Murmur right now.`;

  return (
    <div className="lobby-filters glass-card">
      <div className="lobby-filters__summary">
        <span className="section-label">Live lobby</span>
        <h2 className="lobby-filters__title">Browse by room format.</h2>
        <p className="lobby-filters__eyebrow mono">Moderated panels / open debate / live signal</p>
        <p>{summary}</p>
      </div>

      <div
        className="lobby-filters__actions"
        role="toolbar"
        aria-label="Filter rooms by conversation format"
      >
        {FILTER_OPTIONS.map((option) => {
          const isActive = option.value === value;

          return (
            <button
              key={option.value}
              type="button"
              className={cn(
                "lobby-filters__option",
                isActive && "lobby-filters__option--active",
              )}
              aria-pressed={isActive}
              onClick={() => onChange(option.value)}
              title={option.description}
            >
              <span className="lobby-filters__option-label">{option.label}</span>
              <span className="lobby-filters__option-hint">
                {isActive ? "On" : "View"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

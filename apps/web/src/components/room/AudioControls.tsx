"use client";

/**
 * Fixed-bottom audio control bar for the Murmur live room experience.
 *
 * This component owns only listener-side audio interactions: muting the room
 * feed, adjusting playback volume, and leaving the room. It intentionally
 * stays agnostic of LiveKit connection logic so the realtime assembly step can
 * wire it in without introducing a second control path.
 */

import { useId } from "react";
import type { CSSProperties, ChangeEvent } from "react";

import Button from "@/components/ui/Button";
import { cn } from "@/lib/utils";

type AudioControlStyle = CSSProperties & {
  "--audio-progress": string;
};

export interface AudioControlsProps {
  className?: string;
  disabled?: boolean;
  isLeaving?: boolean;
  isMuted: boolean;
  onLeave: () => Promise<void> | void;
  onMuteChange: (nextMuted: boolean) => void;
  onVolumeChange: (nextVolume: number) => void;
  volume: number;
}

/**
 * Validates and normalizes the canonical playback volume value.
 *
 * Murmur uses the browser-native `0..1` range so the value can be forwarded to
 * HTML media elements or LiveKit audio primitives without extra translation.
 *
 * @param volume - Candidate playback volume.
 * @returns The validated volume value.
 * @throws {TypeError} When the value is not a finite number.
 * @throws {RangeError} When the value falls outside the supported range.
 */
function normalizeVolume(volume: number): number {
  if (!Number.isFinite(volume)) {
    throw new TypeError("AudioControls requires `volume` to be a finite number.");
  }

  if (volume < 0 || volume > 1) {
    throw new RangeError("AudioControls requires `volume` to be between 0 and 1.");
  }

  return volume;
}

/**
 * Converts the canonical volume value into a rounded percentage label.
 *
 * @param volume - Canonical playback volume in the `0..1` range.
 * @returns The closest whole-number percentage.
 */
function toVolumePercent(volume: number): number {
  return Math.round(volume * 100);
}

/**
 * Builds the slider-progress CSS custom property for the current volume.
 *
 * @param volumePercent - Rounded volume percentage used by the range input.
 * @returns Inline style with the active slider progress.
 */
function getAudioControlStyle(volumePercent: number): AudioControlStyle {
  return {
    "--audio-progress": `${volumePercent}%`,
  };
}

/**
 * Returns the visible status text for the current audio state.
 *
 * @param isMuted - Whether the listener has muted the room feed.
 * @param volumePercent - Rounded volume percentage.
 * @returns A concise audio status label.
 */
function getAudioStatusLabel(
  isMuted: boolean,
  volumePercent: number,
): string {
  if (isMuted) {
    return "Muted";
  }

  return `${volumePercent}%`;
}

/**
 * Speaker icon that reflects the current mute and loudness state.
 *
 * @param props - Current mute and volume state.
 * @returns An inline SVG icon for the mute toggle control.
 */
function SpeakerIcon({
  isMuted,
  volume,
}: Readonly<{
  isMuted: boolean;
  volume: number;
}>) {
  const showSmallWave = !isMuted && volume > 0;
  const showLargeWave = !isMuted && volume >= 0.45;

  return (
    <svg
      className="room-audio-controls__icon"
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M5 14.5V9.5C5 8.948 5.448 8.5 6 8.5H8.015C8.265 8.5 8.506 8.406 8.69 8.236L11.823 5.341C12.463 4.749 13.5 5.203 13.5 6.074V17.926C13.5 18.797 12.463 19.251 11.823 18.659L8.69 15.764C8.506 15.594 8.265 15.5 8.015 15.5H6C5.448 15.5 5 15.052 5 14.5Z"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {showSmallWave ? (
        <path
          d="M16.2 9.35C17.29 10.302 17.917 11.667 17.917 13.117C17.917 14.567 17.29 15.932 16.2 16.884"
          stroke="currentColor"
          strokeWidth="1.55"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}

      {showLargeWave ? (
        <path
          d="M18.85 7.2C20.473 8.649 21.417 10.731 21.417 12.933C21.417 15.135 20.473 17.217 18.85 18.667"
          stroke="currentColor"
          strokeWidth="1.55"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}

      {isMuted ? (
        <path
          d="M17.25 8.75L21 16.25M21 8.75L17.25 16.25"
          stroke="currentColor"
          strokeWidth="1.65"
          strokeLinecap="round"
        />
      ) : null}
    </svg>
  );
}

/**
 * Exit-room icon used by the leave action.
 *
 * @returns An inline SVG icon for leaving the room.
 */
function ExitIcon() {
  return (
    <svg
      className="room-audio-controls__leave-icon"
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M10 6.75H7.75C6.784 6.75 6 7.534 6 8.5V15.5C6 16.466 6.784 17.25 7.75 17.25H10"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 8.25L17.75 12L14 15.75"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10.75 12H17.5"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Renders the fixed control bar used to manage listener-side audio playback.
 *
 * @param props - Current mute/volume state and interaction handlers.
 * @returns A responsive bottom control bar for the live room route.
 */
export default function AudioControls({
  className,
  disabled = false,
  isLeaving = false,
  isMuted,
  onLeave,
  onMuteChange,
  onVolumeChange,
  volume,
}: Readonly<AudioControlsProps>) {
  const volumeSliderId = useId();
  const normalizedVolume = normalizeVolume(volume);
  const volumePercent = toVolumePercent(normalizedVolume);
  const controlsDisabled = disabled || isLeaving;

  /**
   * Native range inputs speak in `0..100`, while the room audio layer stores
   * volume in the browser-friendly `0..1` range.
   */
  function handleVolumeInputChange(event: ChangeEvent<HTMLInputElement>) {
    const nextVolumePercent = Number.parseInt(event.currentTarget.value, 10);

    if (!Number.isFinite(nextVolumePercent)) {
      throw new Error("AudioControls received an invalid slider value.");
    }

    onVolumeChange(nextVolumePercent / 100);
  }

  return (
    <section
      className={cn("room-audio-controls glass-card fade-up", className)}
      style={getAudioControlStyle(volumePercent)}
      data-testid="audio-controls"
      aria-label="Audio controls"
    >
      <div className="room-audio-controls__cluster">
        <button
          type="button"
          className={cn(
            "room-audio-controls__mute-toggle",
            isMuted && "room-audio-controls__mute-toggle--muted",
          )}
          aria-label={isMuted ? "Unmute room audio" : "Mute room audio"}
          aria-pressed={isMuted}
          disabled={controlsDisabled}
          onClick={() => {
            onMuteChange(!isMuted);
          }}
        >
          <SpeakerIcon isMuted={isMuted} volume={normalizedVolume} />
          <span className="room-audio-controls__mute-copy">
            {isMuted ? "Muted" : "Audio on"}
          </span>
        </button>

        <div className="room-audio-controls__slider-block">
          <div className="room-audio-controls__slider-meta">
            <label
              htmlFor={volumeSliderId}
              className="room-audio-controls__slider-label section-label"
            >
              Volume
            </label>

            <output
              htmlFor={volumeSliderId}
              className="room-audio-controls__volume-readout mono"
            >
              {getAudioStatusLabel(isMuted, volumePercent)}
            </output>
          </div>

          <input
            id={volumeSliderId}
            className="room-audio-controls__slider"
            type="range"
            min="0"
            max="100"
            step="1"
            value={volumePercent}
            disabled={controlsDisabled}
            onChange={handleVolumeInputChange}
            aria-label="Room audio volume"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={volumePercent}
            aria-valuetext={getAudioStatusLabel(isMuted, volumePercent)}
          />
        </div>
      </div>

      <Button
        variant="danger"
        size="sm"
        loading={isLeaving}
        disabled={disabled}
        className="room-audio-controls__leave-button"
        onClick={() => {
          void onLeave();
        }}
      >
        <ExitIcon />
        <span>Leave room</span>
      </Button>
    </section>
  );
}

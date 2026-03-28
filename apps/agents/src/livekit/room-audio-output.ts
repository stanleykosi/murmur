/**
 * Room-bound audio output adapter for Murmur agent sessions.
 *
 * LiveKit's stock participant output waits for a remote subscription before it
 * considers playback started, which is a poor fit for AI-only rooms that may
 * begin speaking before any listener joins. This adapter publishes the audio
 * track immediately, feeds frames into LiveKit's `AudioSource`, and models
 * playout timing from the known frame durations so `session.say(...).waitForPlayout()`
 * remains useful even in an empty room.
 */

import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  type LocalTrackPublication,
  type Room,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";
import { EventEmitter } from "node:events";

/**
 * Playback-start payload shape expected by the LiveKit Agents session runtime.
 */
export interface PlaybackStartedEvent {
  createdAt: number;
}

/**
 * Playback-finished payload shape expected by the LiveKit Agents session runtime.
 */
export interface PlaybackFinishedEvent {
  playbackPosition: number;
  interrupted: boolean;
}

/**
 * Runtime configuration supported by the room audio output.
 */
export interface RoomAudioOutputOptions {
  sampleRate?: number;
  numChannels?: number;
  trackName?: string;
}

/**
 * Event names aligned with LiveKit Agents' audio-output contract.
 */
export const AUDIO_OUTPUT_EVENT_PLAYBACK_STARTED = "playbackStarted";
export const AUDIO_OUTPUT_EVENT_PLAYBACK_FINISHED = "playbackFinished";

const DEFAULT_SAMPLE_RATE = 24_000;
const DEFAULT_NUM_CHANNELS = 1;
const DEFAULT_TRACK_NAME = "murmur_agent_audio";

/**
 * Validates a positive integer audio setting.
 *
 * @param value - Candidate numeric value.
 * @param label - Human-readable field label for diagnostics.
 * @returns The validated integer.
 * @throws {Error} When the value is invalid.
 */
function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return value;
}

/**
 * Validates and trims a required string value.
 *
 * @param value - Candidate string value.
 * @param label - Human-readable field label for diagnostics.
 * @returns The trimmed string.
 * @throws {Error} When the value is blank or not a string.
 */
function normalizeRequiredText(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return normalizedValue;
}

/**
 * Validates a LiveKit audio frame before publication.
 *
 * @param frame - Candidate audio frame.
 * @returns The original frame when valid.
 * @throws {Error} When the frame is invalid.
 */
function normalizeAudioFrame(frame: AudioFrame): AudioFrame {
  if (!(frame instanceof AudioFrame)) {
    throw new Error("frame must be an instance of AudioFrame.");
  }

  return frame;
}

/**
 * Room-local audio output compatible with LiveKit Agents' duck-typed contract.
 */
export class RoomAudioOutput extends EventEmitter {
  public readonly sampleRate: number;

  private closed = false;

  private currentSegmentDurationSeconds = 0;

  private firstFrameEmitted = false;

  private lastPlaybackEvent: PlaybackFinishedEvent = {
    playbackPosition: 0,
    interrupted: false,
  };

  private playbackFinishedPromise: Promise<PlaybackFinishedEvent> = Promise.resolve(
    this.lastPlaybackEvent,
  );

  private playbackFinishedResolver:
    | ((value: PlaybackFinishedEvent) => void)
    | null = null;

  private playbackStartedAtMs: number | null = null;

  private playbackTimer: NodeJS.Timeout | null = null;

  private publication: LocalTrackPublication | null = null;

  private readonly audioSource: AudioSource;

  private readonly numChannels: number;

  private readonly trackName: string;

  private readonly trackPublishOptions = new TrackPublishOptions({
    source: TrackSource.SOURCE_MICROPHONE,
  });

  /**
   * Creates a room-bound audio output for one runner session.
   *
   * @param room - Connected LiveKit room used for track publication.
   * @param options - Optional audio and track-name overrides.
   */
  public constructor(
    private readonly room: Room,
    options: RoomAudioOutputOptions = {},
  ) {
    super();

    this.sampleRate = normalizePositiveInteger(
      options.sampleRate ?? DEFAULT_SAMPLE_RATE,
      "sampleRate",
    );
    this.numChannels = normalizePositiveInteger(
      options.numChannels ?? DEFAULT_NUM_CHANNELS,
      "numChannels",
    );
    this.trackName = normalizeRequiredText(
      options.trackName ?? DEFAULT_TRACK_NAME,
      "trackName",
    );
    this.audioSource = new AudioSource(this.sampleRate, this.numChannels);
  }

  /**
   * Publishes the underlying local audio track into the LiveKit room.
   *
   * @returns A promise that resolves once the local track is published.
   */
  public async start(): Promise<void> {
    this.ensureOpen();

    if (this.publication) {
      return;
    }

    if (!this.room.localParticipant) {
      throw new Error("LiveKit room must expose a localParticipant before audio output start.");
    }

    const track = LocalAudioTrack.createAudioTrack(
      this.trackName,
      this.audioSource,
    );

    this.publication = await this.room.localParticipant.publishTrack(
      track,
      this.trackPublishOptions,
    );
  }

  /**
   * Accepts one synthesized audio frame for LiveKit publication.
   *
   * @param frame - Audio frame to push to the room.
   */
  public async captureFrame(frame: AudioFrame): Promise<void> {
    this.ensureOpen();

    if (!this.publication) {
      throw new Error("RoomAudioOutput.start() must be called before captureFrame().");
    }

    const normalizedFrame = normalizeAudioFrame(frame);

    if (!this.firstFrameEmitted) {
      this.firstFrameEmitted = true;
      this.emit(AUDIO_OUTPUT_EVENT_PLAYBACK_STARTED, {
        createdAt: Date.now(),
      } satisfies PlaybackStartedEvent);
    }

    this.currentSegmentDurationSeconds +=
      normalizedFrame.samplesPerChannel / normalizedFrame.sampleRate;

    await this.audioSource.captureFrame(normalizedFrame);
  }

  /**
   * Begins playout tracking for the current audio segment.
   */
  public flush(): void {
    this.ensureOpen();

    if (this.currentSegmentDurationSeconds === 0) {
      return;
    }

    if (this.playbackTimer) {
      this.clearActivePlaybackTimer();
    }

    this.playbackFinishedPromise = new Promise<PlaybackFinishedEvent>((resolve) => {
      this.playbackFinishedResolver = resolve;
    });
    this.playbackStartedAtMs = Date.now();

    const durationMs = Math.max(
      Math.ceil(this.currentSegmentDurationSeconds * 1000),
      1,
    );

    this.playbackTimer = setTimeout(() => {
      this.finishPlaybackSegment({
        playbackPosition: this.currentSegmentDurationSeconds,
        interrupted: false,
      });
    }, durationMs);
  }

  /**
   * Clears any queued audio and marks the active segment as interrupted.
   */
  public clearBuffer(): void {
    if (this.currentSegmentDurationSeconds === 0) {
      return;
    }

    this.audioSource.clearQueue();

    const playbackPosition = this.playbackStartedAtMs === null
      ? 0
      : Math.min(
        (Date.now() - this.playbackStartedAtMs) / 1000,
        this.currentSegmentDurationSeconds,
      );

    this.finishPlaybackSegment({
      playbackPosition,
      interrupted: true,
    });
  }

  /**
   * Waits for the current segment to finish playout.
   *
   * @returns The last playback-finished payload.
   */
  public async waitForPlayout(): Promise<PlaybackFinishedEvent> {
    return await this.playbackFinishedPromise;
  }

  /**
   * Lifecycle hook required by the LiveKit Agents audio-output contract.
   */
  public onAttached(): void {}

  /**
   * Lifecycle hook required by the LiveKit Agents audio-output contract.
   */
  public onDetached(): void {}

  /**
   * Lifecycle hook required by the LiveKit Agents audio-output contract.
   */
  public pause(): void {}

  /**
   * Lifecycle hook required by the LiveKit Agents audio-output contract.
   */
  public resume(): void {}

  /**
   * Unpublishes the audio track and closes the underlying audio source.
   */
  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    if (this.playbackFinishedResolver || this.currentSegmentDurationSeconds > 0) {
      this.clearBuffer();
    } else {
      this.clearActivePlaybackTimer();
      this.currentSegmentDurationSeconds = 0;
      this.playbackStartedAtMs = null;
      this.firstFrameEmitted = false;
    }

    try {
      if (this.publication?.sid && this.room.localParticipant) {
        await this.room.localParticipant.unpublishTrack(this.publication.sid);
      }
    } catch {
      // Room shutdown should keep progressing even if unpublish fails.
    } finally {
      this.publication = null;
    }

    await this.audioSource.close();
    this.closed = true;
  }

  /**
   * Completes the current playback segment and resolves waiters.
   *
   * @param event - Playback-finished payload for the current segment.
   */
  private finishPlaybackSegment(event: PlaybackFinishedEvent): void {
    this.clearActivePlaybackTimer();
    this.lastPlaybackEvent = event;
    this.currentSegmentDurationSeconds = 0;
    this.playbackStartedAtMs = null;
    this.firstFrameEmitted = false;

    if (this.playbackFinishedResolver) {
      this.playbackFinishedResolver(event);
      this.playbackFinishedResolver = null;
    }

    this.playbackFinishedPromise = Promise.resolve(event);
    this.emit(AUDIO_OUTPUT_EVENT_PLAYBACK_FINISHED, event);
  }

  /**
   * Clears the active timer without mutating segment state.
   */
  private clearActivePlaybackTimer(): void {
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
  }

  /**
   * Throws when callers attempt to use a closed output.
   *
   * @throws {Error} When the output has already been closed.
   */
  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("RoomAudioOutput is closed.");
    }
  }
}

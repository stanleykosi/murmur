/**
 * Canonical Murmur voice-activity wrapper built on LiveKit's maintained
 * Silero plugin.
 *
 * The LiveKit plugin provides low-level speech activity events, while this
 * wrapper preserves Murmur's product policy that a turn is only complete after
 * a full 1.5 seconds of silence. Later orchestration code should therefore use
 * `turnComplete` rather than the plugin's earlier `speechEnd` cue.
 */

import {
  SILENCE_THRESHOLD_MS,
  VAD_POSITIVE_THRESHOLD,
} from "@murmur/shared";
import {
  VADEventType,
  type VADEvent,
} from "@livekit/agents";
import * as silero from "@livekit/agents-plugin-silero";
import { AudioFrame } from "@livekit/rtc-node";
import { EventEmitter } from "node:events";
import type { ReadableStream } from "node:stream/web";

import { ensureLiveKitLoggerInitialized } from "../livekit/logger.js";

/**
 * Sample rates accepted by the LiveKit Silero plugin.
 */
type SupportedSampleRate = 8_000 | 16_000;

/**
 * Public event names emitted by the Murmur VAD wrapper.
 */
export type VADDetectorEventName =
  | "speechStart"
  | "speechEnd"
  | "turnComplete"
  | "error";

/**
 * Event payload emitted for all non-error detector events.
 */
export interface VADDetectorEventPayload {
  frames: AudioFrame[];
  inferenceDurationMs: number;
  probability: number;
  samplesIndex: number;
  silenceDurationMs: number;
  speechDurationMs: number;
  timestampMs: number;
}

/**
 * Runtime configuration supported by the Murmur VAD wrapper.
 */
export interface VADDetectorOptions {
  activationThreshold: number;
  forceCPU: boolean;
  minSpeechDurationMs: number;
  now?: () => number;
  pluginSpeechEndSilenceMs: number;
  sampleRate: SupportedSampleRate;
  turnCompleteSilenceMs: number;
}

/**
 * Fully validated detector configuration.
 */
interface ResolvedVADDetectorOptions {
  activationThreshold: number;
  forceCPU: boolean;
  minSpeechDurationMs: number;
  now: () => number;
  pluginSpeechEndSilenceMs: number;
  sampleRate: SupportedSampleRate;
  turnCompleteSilenceMs: number;
}

/**
 * Minimal Silero VAD surface used by the wrapper.
 */
interface SileroVADLike {
  close(): Promise<void>;
  stream(): SileroVADStreamLike;
}

/**
 * Minimal LiveKit Silero stream surface used by the wrapper.
 */
interface SileroVADStreamLike extends AsyncIterable<VADEvent> {
  close(): void;
  detachInputStream(): void;
  endInput(): void;
  flush(): void;
  pushFrame(frame: AudioFrame): void;
  updateInputStream(stream: ReadableStream<AudioFrame>): void;
}

const DEFAULT_MIN_SPEECH_DURATION_MS = 96;

const DEFAULT_PLUGIN_SPEECH_END_SILENCE_MS = 550;

/**
 * Converts an unknown thrown value into a proper `Error`.
 *
 * @param value - Arbitrary thrown value from a dependency or caller.
 * @returns A concrete `Error` instance with a useful message.
 */
function normalizeError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  return new Error(`Unexpected non-Error value: ${String(value)}.`);
}

/**
 * Validates that a required number is finite and non-negative.
 *
 * @param value - Candidate numeric input.
 * @param label - Human-readable field name for diagnostics.
 * @returns The validated number.
 * @throws {Error} When the value is invalid.
 */
function normalizeNonNegativeNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`);
  }

  return value;
}

/**
 * Validates that a duration is strictly positive.
 *
 * @param value - Candidate duration in milliseconds.
 * @param label - Human-readable field name for diagnostics.
 * @returns The validated duration.
 * @throws {Error} When the duration is not positive.
 */
function normalizePositiveDurationMs(value: number, label: string): number {
  const normalizedValue = normalizeNonNegativeNumber(value, label);

  if (normalizedValue === 0) {
    throw new Error(`${label} must be greater than zero.`);
  }

  return normalizedValue;
}

/**
 * Validates that a probability threshold is inside the closed [0, 1] range.
 *
 * @param value - Candidate probability threshold.
 * @param label - Human-readable field name for diagnostics.
 * @returns The validated threshold.
 * @throws {Error} When the threshold is out of range.
 */
function normalizeProbability(value: number, label: string): number {
  const normalizedValue = normalizeNonNegativeNumber(value, label);

  if (normalizedValue > 1) {
    throw new Error(`${label} must be less than or equal to 1.`);
  }

  return normalizedValue;
}

/**
 * Validates the supported Silero inference sample rates.
 *
 * @param value - Candidate sample rate.
 * @returns The validated sample rate.
 * @throws {Error} When the sample rate is unsupported.
 */
function normalizeSampleRate(value: number): SupportedSampleRate {
  if (value === 8_000 || value === 16_000) {
    return value;
  }

  throw new Error("sampleRate must be either 8000 or 16000.");
}

/**
 * Resolves and validates the detector configuration.
 *
 * @param options - Caller-supplied partial detector options.
 * @returns Fully populated and validated options.
 * @throws {Error} When the supplied configuration is invalid.
 */
function resolveOptions(
  options: Partial<VADDetectorOptions>,
): ResolvedVADDetectorOptions {
  const now = options.now ?? Date.now;

  if (typeof now !== "function") {
    throw new Error("now must be a function.");
  }

  const resolvedOptions: ResolvedVADDetectorOptions = {
    activationThreshold: normalizeProbability(
      options.activationThreshold ?? VAD_POSITIVE_THRESHOLD,
      "activationThreshold",
    ),
    forceCPU: options.forceCPU ?? true,
    minSpeechDurationMs: normalizePositiveDurationMs(
      options.minSpeechDurationMs ?? DEFAULT_MIN_SPEECH_DURATION_MS,
      "minSpeechDurationMs",
    ),
    now,
    pluginSpeechEndSilenceMs: normalizePositiveDurationMs(
      options.pluginSpeechEndSilenceMs ?? DEFAULT_PLUGIN_SPEECH_END_SILENCE_MS,
      "pluginSpeechEndSilenceMs",
    ),
    sampleRate: normalizeSampleRate(options.sampleRate ?? 16_000),
    turnCompleteSilenceMs: normalizePositiveDurationMs(
      options.turnCompleteSilenceMs ?? SILENCE_THRESHOLD_MS,
      "turnCompleteSilenceMs",
    ),
  };

  if (typeof resolvedOptions.forceCPU !== "boolean") {
    throw new Error("forceCPU must be a boolean.");
  }

  if (
    resolvedOptions.turnCompleteSilenceMs
    < resolvedOptions.pluginSpeechEndSilenceMs
  ) {
    throw new Error(
      "turnCompleteSilenceMs must be greater than or equal to pluginSpeechEndSilenceMs.",
    );
  }

  return resolvedOptions;
}

/**
 * Validates the injected wall clock used for emitted event timestamps.
 *
 * @param now - Injected clock function.
 * @returns The current wall-clock timestamp in milliseconds.
 * @throws {Error} When the clock returns an invalid value.
 */
function getTimestampMs(now: () => number): number {
  const timestampMs = now();

  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new Error("now() must return a non-negative safe integer timestamp.");
  }

  return timestampMs;
}

/**
 * Ensures a candidate input stream exposes the Web Streams reader contract.
 *
 * @param stream - Candidate input stream.
 * @returns The validated readable stream.
 * @throws {Error} When the stream is invalid.
 */
function normalizeReadableStream(
  stream: ReadableStream<AudioFrame>,
): ReadableStream<AudioFrame> {
  if (
    !stream
    || typeof stream !== "object"
    || typeof stream.getReader !== "function"
  ) {
    throw new Error(
      "stream must be a ReadableStream<AudioFrame> with a getReader() method.",
    );
  }

  return stream;
}

/**
 * Ensures a candidate frame is a LiveKit `AudioFrame`.
 *
 * @param frame - Candidate audio frame.
 * @returns The validated frame.
 * @throws {Error} When the frame is invalid.
 */
function normalizeAudioFrame(frame: AudioFrame): AudioFrame {
  if (!(frame instanceof AudioFrame)) {
    throw new Error("frame must be an instance of AudioFrame.");
  }

  return frame;
}

/**
 * Validates the runtime Silero VAD object returned by the plugin.
 *
 * @param value - Candidate plugin VAD instance.
 * @returns The validated VAD object.
 * @throws {Error} When the plugin returns an unexpected shape.
 */
function normalizeSileroVAD(value: unknown): SileroVADLike {
  if (
    !value
    || typeof value !== "object"
    || typeof (value as SileroVADLike).close !== "function"
    || typeof (value as SileroVADLike).stream !== "function"
  ) {
    throw new Error(
      "silero.VAD.load() must resolve to an object with close() and stream().",
    );
  }

  return value as SileroVADLike;
}

/**
 * Validates the runtime stream returned by the Silero VAD instance.
 *
 * @param value - Candidate VAD stream.
 * @returns The validated stream implementation.
 * @throws {Error} When the stream shape is invalid.
 */
function normalizeSileroStream(value: unknown): SileroVADStreamLike {
  if (
    !value
    || typeof value !== "object"
    || typeof (value as SileroVADStreamLike)[Symbol.asyncIterator] !== "function"
    || typeof (value as SileroVADStreamLike).close !== "function"
    || typeof (value as SileroVADStreamLike).detachInputStream !== "function"
    || typeof (value as SileroVADStreamLike).endInput !== "function"
    || typeof (value as SileroVADStreamLike).flush !== "function"
    || typeof (value as SileroVADStreamLike).pushFrame !== "function"
    || typeof (value as SileroVADStreamLike).updateInputStream !== "function"
  ) {
    throw new Error(
      "silero.VAD.stream() must return an async-iterable stream with Murmur's required delegation methods.",
    );
  }

  return value as SileroVADStreamLike;
}

/**
 * Validates a VAD event emitted by the LiveKit Silero stream.
 *
 * @param event - Candidate runtime VAD event.
 * @returns The validated event.
 * @throws {Error} When the event shape is invalid.
 */
function normalizeVADEvent(event: unknown): VADEvent {
  if (!event || typeof event !== "object") {
    throw new Error("Silero VAD stream yielded a non-object event.");
  }

  const candidateEvent = event as VADEvent;

  if (
    candidateEvent.type !== VADEventType.START_OF_SPEECH
    && candidateEvent.type !== VADEventType.INFERENCE_DONE
    && candidateEvent.type !== VADEventType.END_OF_SPEECH
    && candidateEvent.type !== VADEventType.METRICS_COLLECTED
  ) {
    throw new Error("Silero VAD stream yielded an unsupported event type.");
  }

  if (!Number.isSafeInteger(candidateEvent.samplesIndex) || candidateEvent.samplesIndex < 0) {
    throw new Error("Silero VAD event samplesIndex must be a non-negative safe integer.");
  }

  normalizeNonNegativeNumber(candidateEvent.timestamp, "Silero VAD event timestamp");
  normalizeNonNegativeNumber(
    candidateEvent.speechDuration,
    "Silero VAD event speechDuration",
  );
  normalizeNonNegativeNumber(
    candidateEvent.silenceDuration,
    "Silero VAD event silenceDuration",
  );

  if (!Array.isArray(candidateEvent.frames)) {
    throw new Error("Silero VAD event frames must be an array.");
  }

  for (const [index, frame] of candidateEvent.frames.entries()) {
    if (!(frame instanceof AudioFrame)) {
      throw new Error(
        `Silero VAD event frames[${index}] must be an instance of AudioFrame.`,
      );
    }
  }

  normalizeProbability(candidateEvent.probability, "Silero VAD event probability");
  normalizeNonNegativeNumber(
    candidateEvent.inferenceDuration,
    "Silero VAD event inferenceDuration",
  );

  if (typeof candidateEvent.speaking !== "boolean") {
    throw new Error("Silero VAD event speaking must be a boolean.");
  }

  normalizeNonNegativeNumber(
    candidateEvent.rawAccumulatedSilence,
    "Silero VAD event rawAccumulatedSilence",
  );
  normalizeNonNegativeNumber(
    candidateEvent.rawAccumulatedSpeech,
    "Silero VAD event rawAccumulatedSpeech",
  );

  return candidateEvent;
}

/**
 * Converts a validated plugin VAD event into Murmur's public payload format.
 *
 * @param event - Validated plugin VAD event.
 * @param now - Injected wall-clock function.
 * @returns A Murmur event payload with wall-clock timestamps.
 */
function createEventPayload(
  event: VADEvent,
  now: () => number,
): VADDetectorEventPayload {
  return {
    frames: event.frames,
    inferenceDurationMs: event.inferenceDuration,
    probability: event.probability,
    samplesIndex: event.samplesIndex,
    silenceDurationMs: event.silenceDuration,
    speechDurationMs: event.speechDuration,
    timestampMs: getTimestampMs(now),
  };
}

/**
 * Voice-activity detector that adapts the LiveKit Silero plugin to Murmur's
 * fixed-silence turn-complete contract.
 */
export class VADDetector extends EventEmitter {
  private closed = false;

  private readonly consumeEventsTask: Promise<void>;

  private closing = false;

  private hasActiveUtterance = false;

  private readonly options: ResolvedVADDetectorOptions;

  private readonly stream: SileroVADStreamLike;

  private turnCompleteEmitted = false;

  private readonly vad: SileroVADLike;

  /**
   * Creates the detector around a preloaded Silero plugin instance.
   *
   * @param vad - Loaded Silero VAD runtime returned by the plugin.
   * @param stream - Stream instance created from the loaded VAD runtime.
   * @param options - Fully validated runtime configuration.
   */
  private constructor(
    vad: SileroVADLike,
    stream: SileroVADStreamLike,
    options: ResolvedVADDetectorOptions,
  ) {
    super();

    this.vad = vad;
    this.stream = stream;
    this.options = options;
    this.consumeEventsTask = this.consumeEvents();
    this.consumeEventsTask.catch((error: unknown) => {
      if (this.closing) {
        return;
      }

      const normalizedError = normalizeError(error);

      try {
        super.emit("error", normalizedError);
      } catch (emitError) {
        queueMicrotask(() => {
          throw normalizeError(emitError);
        });
      }
    });
  }

  /**
   * Loads the maintained LiveKit Silero VAD plugin with Murmur's defaults.
   *
   * @param options - Optional overrides for Murmur's detector defaults.
   * @returns A ready-to-use Murmur VAD detector.
   */
  public static async load(
    options: Partial<VADDetectorOptions> = {},
  ): Promise<VADDetector> {
    const resolvedOptions = resolveOptions(options);
    ensureLiveKitLoggerInitialized();
    const loadedVAD = normalizeSileroVAD(
      await silero.VAD.load({
        activationThreshold: resolvedOptions.activationThreshold,
        forceCPU: resolvedOptions.forceCPU,
        minSilenceDuration: resolvedOptions.pluginSpeechEndSilenceMs,
        minSpeechDuration: resolvedOptions.minSpeechDurationMs,
        sampleRate: resolvedOptions.sampleRate,
      }),
    );
    const stream = normalizeSileroStream(loadedVAD.stream());

    return new VADDetector(loadedVAD, stream, resolvedOptions);
  }

  /**
   * Attaches a LiveKit audio stream to the underlying Silero stream.
   *
   * @param stream - Readable stream of LiveKit audio frames.
   */
  public updateInputStream(stream: ReadableStream<AudioFrame>): void {
    this.ensureOpen();
    this.stream.updateInputStream(normalizeReadableStream(stream));
  }

  /**
   * Detaches the currently attached input stream, if any.
   */
  public detachInputStream(): void {
    this.ensureOpen();
    this.stream.detachInputStream();
  }

  /**
   * Pushes a single LiveKit audio frame into the underlying VAD stream.
   *
   * @param frame - Audio frame to process.
   */
  public pushFrame(frame: AudioFrame): void {
    this.ensureOpen();
    this.stream.pushFrame(normalizeAudioFrame(frame));
  }

  /**
   * Flushes buffered audio through the underlying VAD stream.
   */
  public flush(): void {
    this.ensureOpen();
    this.stream.flush();
  }

  /**
   * Signals that no more input audio frames will be written.
   */
  public endInput(): void {
    this.ensureOpen();
    this.stream.endInput();
  }

  /**
   * Closes the wrapper and the underlying plugin runtime.
   */
  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closing = true;
    this.stream.close();
    await this.vad.close();
    await this.consumeEventsTask.catch(() => undefined);
    this.closed = true;
  }

  /**
   * Throws when callers attempt to use a detector that has already been closed.
   *
   * @throws {Error} When the detector is closing or closed.
   */
  private ensureOpen(): void {
    if (this.closing || this.closed) {
      throw new Error("VADDetector is closed.");
    }
  }

  /**
   * Continuously consumes plugin VAD events and translates them into Murmur's
   * public detector events.
   */
  private async consumeEvents(): Promise<void> {
    for await (const rawEvent of this.stream) {
      const event = normalizeVADEvent(rawEvent);

      switch (event.type) {
        case VADEventType.START_OF_SPEECH:
          this.handleSpeechStart(event);
          break;
        case VADEventType.INFERENCE_DONE:
          this.handleInferenceDone(event);
          break;
        case VADEventType.END_OF_SPEECH:
          this.handleSpeechEnd(event);
          break;
        case VADEventType.METRICS_COLLECTED:
          break;
      }
    }
  }

  /**
   * Handles the plugin's speech-start cue and begins a new Murmur utterance.
   *
   * @param event - Validated speech-start event.
   */
  private handleSpeechStart(event: VADEvent): void {
    this.hasActiveUtterance = true;
    this.turnCompleteEmitted = false;
    super.emit("speechStart", createEventPayload(event, this.options.now));
  }

  /**
   * Handles intermediate plugin inference updates and emits Murmur's
   * authoritative `turnComplete` signal only after the full silence threshold.
   *
   * @param event - Validated inference event.
   */
  private handleInferenceDone(event: VADEvent): void {
    if (event.speaking) {
      return;
    }

    this.maybeEmitTurnComplete(event, event.rawAccumulatedSilence);
  }

  /**
   * Handles the plugin's early speech-end cue while keeping Murmur's separate
   * turn-complete threshold intact.
   *
   * @param event - Validated speech-end event.
   */
  private handleSpeechEnd(event: VADEvent): void {
    super.emit("speechEnd", createEventPayload(event, this.options.now));

    this.maybeEmitTurnComplete(
      event,
      Math.max(event.rawAccumulatedSilence, event.silenceDuration),
    );
  }

  /**
   * Emits `turnComplete` at most once for the current utterance when Murmur's
   * fixed silence threshold is met.
   *
   * @param event - Validated plugin event carrying silence information.
   * @param silenceDurationMs - Silence duration to compare against Murmur's threshold.
   */
  private maybeEmitTurnComplete(
    event: VADEvent,
    silenceDurationMs: number,
  ): void {
    if (!this.hasActiveUtterance || this.turnCompleteEmitted) {
      return;
    }

    if (silenceDurationMs < this.options.turnCompleteSilenceMs) {
      return;
    }

    // Murmur intentionally waits longer than the plugin's speech-end heuristic
    // before releasing the floor so short pauses do not prematurely end turns.
    this.turnCompleteEmitted = true;
    this.hasActiveUtterance = false;
    super.emit("turnComplete", createEventPayload(event, this.options.now));
  }
}

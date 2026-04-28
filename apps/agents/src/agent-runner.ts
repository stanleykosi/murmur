/**
 * Individual Murmur agent runner lifecycle.
 *
 * Each runner owns one agent in one room: it connects to LiveKit, composes the
 * production-grade system prompt for each turn, executes the LangGraph loop,
 * publishes transcript side effects, and keeps floor-control cleanup explicit
 * when anything fails.
 */

import {
  SILENCE_THRESHOLD_MS,
  filterContent,
  type TranscriptEntry,
  type TranscriptEvent,
} from "@murmur/shared";
import { voice } from "@livekit/agents";
import {
  AudioFrame,
  AudioResampler,
  Room,
  type LocalTrack,
  type LocalTrackPublication,
  type TrackPublishOptions,
} from "@livekit/rtc-node";
import { EventEmitter } from "node:events";
import { ReadableStream } from "node:stream/web";

import { ContextManager } from "./context/manager.js";
import { env } from "./config/env.js";
import { FloorController } from "./floor/controller.js";
import { VADDetector } from "./floor/vad.js";
import { createAgentGraph } from "./graph/agent-graph.js";
import {
  createInitialAgentGraphState,
  type AgentGraphBindings,
  type AgentGraphState,
  type AgentSessionBridge,
  type FinalizeTurnInput,
  type TurnReadyForPlaybackInput,
} from "./graph/state.js";
import { createLogger } from "./lib/logger.js";
import { captureRuntimeError, normalizeError } from "./lib/sentry.js";
import { createOpenRouterLLMProvider } from "./llm/openrouter.js";
import type { LLMGenerationOptions, LLMProvider } from "./llm/provider.js";
import { buildAgentSystemPrompt } from "./prompts/system.js";
import { TranscriptBuffer } from "./runtime/transcript-buffer.js";
import { normalizeAgentRuntimeProfile, type AgentRuntimeProfile } from "./runtime/agent-profile.js";
import { publishTranscript as publishTranscriptEvent } from "./services/centrifugo.service.js";
import { createAgentToken } from "./services/livekit.service.js";
import type { TranscriptRepository } from "./services/transcript-repository.js";
import { createTTSProvider, type TTSProvider } from "./tts/provider.js";
import { convertPcmAudioToFrames } from "./graph/livekit-session-bridge.js";
import {
  executeSpeakTurn,
} from "./graph/nodes/speak.js";
import {
  normalizeTranscriptSnapshot,
} from "./graph/nodes/listen.js";
import { ensureLiveKitLoggerInitialized } from "./livekit/logger.js";
import {
  AUDIO_OUTPUT_EVENT_PLAYBACK_STARTED,
  AUDIO_OUTPUT_EVENT_PLAYBACK_FINISHED,
  RoomAudioOutput,
  type PlaybackFinishedEvent,
  type PlaybackStartedEvent,
} from "./livekit/room-audio-output.js";

const VAD_SAMPLE_RATE = 16_000;
const VAD_CHANNELS = 1;
const VAD_SILENCE_FRAME_DURATION_MS = 100;
const SYNTHETIC_TURN_BOUNDARY_TIMEOUT_MS = 10_000;
const SYNTHETIC_TURN_BOUNDARY_TIMEOUT_BUFFER_MS = 5_000;
const TRANSCRIPT_PERSIST_TIMEOUT_MS = 3_000;
const TURN_DEADLINE_EXCEEDED_ERROR_NAME = "TurnDeadlineExceededError";

/**
 * Structured payload emitted when one turn misses the room execution budget.
 */
export interface AgentRunnerTurnDeadlineMissedPayload {
  roomId: string;
  agentId: string;
  deadlineMs: number;
}

/**
 * Canonical error used when a room turn exceeds its execution budget.
 */
export class TurnDeadlineExceededError extends Error {
  public constructor(deadlineMs: number) {
    super(
      `Agent turn exceeded the execution deadline of ${deadlineMs}ms and was aborted.`,
    );
    this.name = TURN_DEADLINE_EXCEEDED_ERROR_NAME;
  }
}

/**
 * Minimal logger surface required by the runner.
 */
export interface AgentRunnerLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Room-local transcript publisher used by the runner.
 */
export interface TranscriptPublisher {
  publishTranscript(event: TranscriptEvent): Promise<void>;
}

/**
 * Minimal floor-controller surface required by the runner.
 */
export interface RunnerFloorController {
  getCurrentHolder(): Promise<string | null>;
  releaseFloor(agentId: string): Promise<boolean>;
  setAgentLastSpoke(agentId: string, timestamp: number): Promise<void>;
}

/**
 * Minimal LiveKit speech handle surface required by the runner bridge.
 */
export interface SpeechHandleLike {
  waitForPlayout(): Promise<void>;
}

/**
 * Minimal LiveKit session surface required by the runner.
 */
export interface AgentSessionLike {
  close(): Promise<void>;
  say(
    text: string,
    options: {
      audio: ReadableStream<AudioFrame>;
      allowInterruptions: boolean;
      addToChatCtx: boolean;
    },
  ): SpeechHandleLike;
  start(options: {
    agent: voice.Agent;
  }): Promise<void>;
  input: {
    audio: voice.AgentSession["input"]["audio"];
    setAudioEnabled(enabled: boolean): void;
  };
  output: {
    audio: voice.AgentSession["output"]["audio"];
    transcription: voice.AgentSession["output"]["transcription"];
    setTranscriptionEnabled(enabled: boolean): void;
  };
}

/**
 * Minimal VAD surface required by the runner bridge.
 */
export interface VADDetectorLike {
  beginSyntheticUtterance?(): void;
  pushFrame(frame: AudioFrame): void;
  flush(): void;
  close(): Promise<void>;
  on(eventName: "turnComplete", listener: () => void): this;
  on(eventName: "error", listener: (error: Error) => void): this;
  off(eventName: "turnComplete", listener: () => void): this;
  off(eventName: "error", listener: (error: Error) => void): this;
}

/**
 * Minimal LiveKit room surface required by the runner.
 */
export interface LiveKitRoomLike {
  connect(
    url: string,
    token: string,
    options?: {
      autoSubscribe?: boolean;
      dynacast?: boolean;
    },
  ): Promise<void>;
  disconnect(): Promise<void>;
  localParticipant?: {
    publishTrack(
      track: LocalTrack,
      options: TrackPublishOptions,
    ): Promise<LocalTrackPublication>;
    unpublishTrack(trackSid: string): Promise<void>;
  };
}

/**
 * Minimal room-audio output surface required by the runner.
 */
export interface SessionAudioOutputLike {
  sampleRate: number;
  start(): Promise<void>;
  close(): Promise<void>;
  captureFrame(frame: AudioFrame): Promise<void>;
  flush(): void;
  clearBuffer(): void;
  waitForPlayout(): Promise<PlaybackFinishedEvent>;
  on(
    eventName: typeof AUDIO_OUTPUT_EVENT_PLAYBACK_STARTED,
    listener: (payload: PlaybackStartedEvent) => void,
  ): this;
  on(
    eventName: typeof AUDIO_OUTPUT_EVENT_PLAYBACK_FINISHED,
    listener: (payload: PlaybackFinishedEvent) => void,
  ): this;
  off(
    eventName: typeof AUDIO_OUTPUT_EVENT_PLAYBACK_STARTED,
    listener: (payload: PlaybackStartedEvent) => void,
  ): this;
  off(
    eventName: typeof AUDIO_OUTPUT_EVENT_PLAYBACK_FINISHED,
    listener: (payload: PlaybackFinishedEvent) => void,
  ): this;
}

/**
 * Structured runtime context shared across all runners in one room.
 */
export interface AgentRunnerRoomContext {
  roomId: string;
  title: string;
  topic: string;
  format: "free_for_all" | "moderated";
  agents: AgentRuntimeProfile[];
}

/**
 * Construction options for one runner.
 */
export interface AgentRunnerOptions {
  room: AgentRunnerRoomContext;
  agent: AgentRuntimeProfile;
  floorController: RunnerFloorController;
  transcriptBuffer: TranscriptBuffer;
  transcriptRepository: TranscriptRepository;
  transcriptPublisher?: TranscriptPublisher;
  baseLLMProvider?: LLMProvider;
}

/**
 * Optional dependency-injection hooks for testing the runner.
 */
export interface AgentRunnerDependencies {
  captureRuntimeError?: typeof captureRuntimeError;
  createAgentToken?: typeof createAgentToken;
  createRoom?: () => LiveKitRoomLike;
  createSession?: () => AgentSessionLike;
  createSessionBridge?: (options: CreateRunnerSessionBridgeOptions) => AgentSessionBridge;
  createTranscriptPublisher?: () => TranscriptPublisher;
  createTtsProvider?: (provider: AgentRuntimeProfile["ttsProvider"]) => TTSProvider;
  createVadDetector?: () => Promise<VADDetectorLike>;
  createAudioOutput?: (room: LiveKitRoomLike) => SessionAudioOutputLike;
  logger?: AgentRunnerLogger;
  now?: () => Date;
}

/**
 * Payload emitted when one runner becomes ready for turn execution.
 */
export interface AgentRunnerReadyPayload {
  roomId: string;
  agentId: string;
}

/**
 * Payload emitted after one runner completes a turn.
 */
export interface AgentRunnerTurnCompletedPayload {
  roomId: string;
  agentId: string;
  turnCount: number;
  lastSpokeAt: number;
}

/**
 * Payload emitted when one runner fully stops.
 */
export interface AgentRunnerStoppedPayload {
  roomId: string;
  agentId: string;
}

/**
 * Optional single-turn overrides accepted by the runner.
 */
export interface AgentRunnerTurnRequest {
  promptOverride?: string | null;
}

/**
 * Optional background-preparation overrides used to warm the likely next turn.
 */
export interface AgentRunnerPrepareRequest {
  promptOverride?: string | null;
  transcriptSnapshot?: TranscriptEntry[];
}

/**
 * Public event names emitted by the runner.
 */
export type AgentRunnerEventName =
  | "ready"
  | "turnReadyForPlayback"
  | "turnCompleted"
  | "turnDeadlineMissed"
  | "error"
  | "stopped";

interface AgentRunnerEvents {
  ready: [payload: AgentRunnerReadyPayload];
  turnReadyForPlayback: [payload: TurnReadyForPlaybackInput];
  turnCompleted: [payload: AgentRunnerTurnCompletedPayload];
  turnDeadlineMissed: [payload: AgentRunnerTurnDeadlineMissedPayload];
  error: [error: Error];
  stopped: [payload: AgentRunnerStoppedPayload];
}

interface PreparedTurn {
  audioBuffer: Buffer;
  responseText: string;
  responseWasFiltered: boolean;
  transcriptSignature: string;
}

/**
 * Bridge-construction options for the runner's custom session adapter.
 */
export interface CreateRunnerSessionBridgeOptions {
  vad: VADDetectorLike;
  audioOutput: SessionAudioOutputLike;
  timeoutMs?: number;
}

/**
 * Validates and trims a required string field.
 *
 * @param value - Candidate string value.
 * @param label - Human-readable field label for diagnostics.
 * @returns The trimmed string value.
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
 * Normalizes an optional single-turn prompt override.
 *
 * @param value - Optional override string.
 * @returns The trimmed override or `null` when omitted.
 */
function normalizeOptionalPromptOverride(
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return normalizeRequiredText(value, "promptOverride");
}

/**
 * Wraps 24 kHz audio frames in a `ReadableStream` for `session.say(...)`.
 *
 * @param frames - Synthesized audio frames for one spoken turn.
 * @returns A stream that emits each frame once and then closes.
 */
function createAudioFrameStream(
  frames: ReadonlyArray<AudioFrame>,
): ReadableStream<AudioFrame> {
  return new ReadableStream<AudioFrame>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(frame);
      }

      controller.close();
    },
  });
}

/**
 * Builds one 16 kHz silence frame for the runner-local VAD stream.
 *
 * @returns A zero-valued 100 ms silence frame.
 */
function createVadSilenceFrame(): AudioFrame {
  const samplesPerChannel =
    (VAD_SAMPLE_RATE * VAD_SILENCE_FRAME_DURATION_MS) / 1000;

  return new AudioFrame(
    new Int16Array(samplesPerChannel * VAD_CHANNELS),
    VAD_SAMPLE_RATE,
    VAD_CHANNELS,
    samplesPerChannel,
  );
}

/**
 * Appends enough silence to satisfy Murmur's turn-complete threshold.
 *
 * @param vad - Runner-local VAD detector.
 */
function pushTrailingSilenceToVad(vad: VADDetectorLike): void {
  const silenceFrameCount = Math.ceil(
    SILENCE_THRESHOLD_MS / VAD_SILENCE_FRAME_DURATION_MS,
  );

  for (let index = 0; index < silenceFrameCount; index += 1) {
    vad.pushFrame(createVadSilenceFrame());
  }
}

/**
 * Calculates the synthesized audio duration represented by a frame sequence.
 *
 * The VAD completion watchdog must account for the full spoken turn length plus
 * Murmur's fixed trailing-silence threshold, otherwise long but valid turns can
 * time out before the detector has any chance to emit `turnComplete`.
 *
 * @param frames - PCM frames produced for one synthesized turn.
 * @returns Total audio duration in milliseconds.
 */
function getAudioDurationMs(frames: ReadonlyArray<AudioFrame>): number {
  return Math.ceil(
    frames.reduce((durationMs, frame) => (
      durationMs + ((frame.samplesPerChannel / frame.sampleRate) * 1000)
    ), 0),
  );
}

/**
 * Resolves a per-turn synthetic speech-boundary timeout that scales with audio duration.
 *
 * @param frames - PCM frames produced for one synthesized turn.
 * @param minimumTimeoutMs - Caller-configured minimum timeout floor.
 * @returns A timeout large enough for speech, silence threshold, and buffer.
 */
function resolveSyntheticTurnBoundaryTimeoutMs(
  frames: ReadonlyArray<AudioFrame>,
  minimumTimeoutMs: number,
): number {
  return Math.max(
    minimumTimeoutMs,
    getAudioDurationMs(frames)
      + SILENCE_THRESHOLD_MS
      + SYNTHETIC_TURN_BOUNDARY_TIMEOUT_BUFFER_MS,
  );
}

/**
 * Sleeps for the requested number of milliseconds.
 *
 * @param durationMs - Delay duration in milliseconds.
 * @returns A promise that resolves after the delay completes.
 */
function waitForDelay(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

/**
 * Waits until the session audio output emits its first playback-started event.
 *
 * @param audioOutput - Runner-local LiveKit room audio output.
 * @param timeoutMs - Maximum time to wait before failing.
 * @returns A promise that resolves once playback starts.
 */
function waitForPlaybackStart(
  audioOutput: SessionAudioOutputLike,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      cleanup();
      reject(
        new Error(`Timed out waiting ${timeoutMs}ms for synthetic playback to start.`),
      );
    }, timeoutMs);

    const handlePlaybackStarted = (): void => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      audioOutput.off(
        AUDIO_OUTPUT_EVENT_PLAYBACK_STARTED,
        handlePlaybackStarted,
      );
    };

    audioOutput.on(
      AUDIO_OUTPUT_EVENT_PLAYBACK_STARTED,
      handlePlaybackStarted,
    );
  });
}

/**
 * Creates the runner-specific session bridge that couples `session.say(...)`
 * with Murmur's deterministic synthetic speech boundary: audio playout plus
 * the fixed trailing silence threshold used for room turn-taking.
 *
 * @param options - LiveKit session, VAD detector, and optional timeout config.
 * @returns A graph-facing session bridge used by the speak node.
 */
export function createRunnerSessionBridge(
  options: CreateRunnerSessionBridgeOptions,
): AgentSessionBridge {
  if (!options || typeof options !== "object") {
    throw new Error("options must be an object.");
  }

  const timeoutMs = options.timeoutMs ?? SYNTHETIC_TURN_BOUNDARY_TIMEOUT_MS;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive finite number.");
  }

  if (!options.vad || typeof options.vad.pushFrame !== "function") {
    throw new Error("vad must expose pushFrame().");
  }

  if (
    !options.audioOutput
    || typeof options.audioOutput.captureFrame !== "function"
    || typeof options.audioOutput.flush !== "function"
    || typeof options.audioOutput.waitForPlayout !== "function"
  ) {
    throw new Error(
      "audioOutput must expose captureFrame(), flush(), and waitForPlayout().",
    );
  }

  return {
    async speakText(text: string, pcmAudio: Buffer): Promise<void> {
      normalizeRequiredText(text, "text");

      if (!Buffer.isBuffer(pcmAudio) || pcmAudio.byteLength === 0) {
        throw new Error("pcmAudio must be a non-empty Buffer.");
      }

      const audioFrames = convertPcmAudioToFrames(pcmAudio);
      const resolvedTimeoutMs = resolveSyntheticTurnBoundaryTimeoutMs(
        audioFrames,
        timeoutMs,
      );
      const resampler = new AudioResampler(
        audioFrames[0]?.sampleRate ?? 24_000,
        VAD_SAMPLE_RATE,
        VAD_CHANNELS,
      );
      const playoutAndSilencePromise = new Promise<void>((resolve, reject) => {
        const timeoutHandle = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting ${resolvedTimeoutMs}ms for synthetic turn completion.`));
        }, resolvedTimeoutMs);
        const cleanup = () => {
          clearTimeout(timeoutHandle);
        };
        const waitForSyntheticBoundary = async () => {
          try {
            const playbackStartPromise = waitForPlaybackStart(
              options.audioOutput,
              resolvedTimeoutMs,
            );

            for (const frame of audioFrames) {
              await options.audioOutput.captureFrame(frame);
            }

            options.audioOutput.flush();
            await playbackStartPromise;
            await options.audioOutput.waitForPlayout();
            await waitForDelay(SILENCE_THRESHOLD_MS);
            cleanup();
            resolve();
          } catch (error) {
            try {
              options.audioOutput.clearBuffer();
            } catch {
              // Best-effort cleanup only.
            }
            cleanup();
            reject(normalizeError(error));
          }
        };

        void waitForSyntheticBoundary();
      });

      options.vad.beginSyntheticUtterance?.();

      for (const frame of audioFrames) {
        for (const resampledFrame of resampler.push(frame)) {
          options.vad.pushFrame(resampledFrame);
        }
      }

      for (const resampledFrame of resampler.flush()) {
        options.vad.pushFrame(resampledFrame);
      }

      pushTrailingSilenceToVad(options.vad);
      options.vad.flush();
      await playoutAndSilencePromise;
    },
  };
}

/**
 * Event-driven runner for one agent in one room.
 */
export class AgentRunner extends EventEmitter<AgentRunnerEvents> {
  private readonly agent: AgentRuntimeProfile;

  private readonly baseLLMProvider: LLMProvider;

  private readonly captureRuntimeErrorImpl: typeof captureRuntimeError;

  private readonly floorController: RunnerFloorController;

  private readonly logger: AgentRunnerLogger;

  private readonly now: () => Date;

  private readonly room: AgentRunnerRoomContext;

  private readonly transcriptBuffer: TranscriptBuffer;

  private readonly transcriptPublisher: TranscriptPublisher;

  private graph: ReturnType<typeof createAgentGraph> | null = null;

  private graphBindings: AgentGraphBindings | null = null;

  private graphState: AgentGraphState | null = null;

  private pendingPromptOverride: string | null = null;

  private ready = false;

  private roomConnection: LiveKitRoomLike | null = null;

  private session: AgentSessionLike | null = null;

  private sessionAudioOutput: SessionAudioOutputLike | null = null;

  private turnExecuting = false;

  private turnAbortController: AbortController | null = null;

  private turnDeadlineTimer: NodeJS.Timeout | null = null;

  private stopping = false;

  private turnExecutionPromise: Promise<void> = Promise.resolve();

  private ttsProvider: TTSProvider | null = null;

  private vadDetector: VADDetectorLike | null = null;

  private preparedTurn: PreparedTurn | null = null;

  private preparedTurnPromise: Promise<PreparedTurn | null> | null = null;

  private preparedTurnSignature: string | null = null;

  /**
   * Creates one runner for a specific room-assigned agent.
   *
   * @param options - Room, transcript, and dependency context for the runner.
   * @param dependencies - Optional dependency-injection hooks for tests.
   */
  public constructor(
    private readonly options: AgentRunnerOptions,
    private readonly dependencies: AgentRunnerDependencies = {},
  ) {
    super();

    if (!options || typeof options !== "object") {
      throw new Error("options must be an object.");
    }

    this.room = {
      roomId: normalizeRequiredText(options.room.roomId, "room.roomId"),
      title: normalizeRequiredText(options.room.title, "room.title"),
      topic: normalizeRequiredText(options.room.topic, "room.topic"),
      format: options.room.format,
      agents: options.room.agents.map((agent, index) => normalizeAgentRuntimeProfile(
        agent,
        `room.agents[${index}]`,
      )),
    };
    this.agent = normalizeAgentRuntimeProfile(options.agent, "agent");

    if (!this.room.agents.some((agent) => agent.id === this.agent.id)) {
      throw new Error(
        `room.agents must include the active runner agent "${this.agent.id}".`,
      );
    }

    this.floorController = options.floorController;
    this.transcriptBuffer = options.transcriptBuffer;
    this.baseLLMProvider = options.baseLLMProvider ?? createOpenRouterLLMProvider();
    this.transcriptPublisher = options.transcriptPublisher
      ?? dependencies.createTranscriptPublisher?.()
      ?? {
        publishTranscript: publishTranscriptEvent,
      };
    this.captureRuntimeErrorImpl =
      dependencies.captureRuntimeError ?? captureRuntimeError;
    this.now = dependencies.now ?? (() => new Date());
    this.logger = dependencies.logger
      ?? createLogger({
        component: "agent-runner",
        roomId: this.room.roomId,
        agentId: this.agent.id,
      });
  }

  /**
   * Returns the runner's resolved runtime profile.
   */
  public getAgentProfile(): AgentRuntimeProfile {
    return this.agent;
  }

  /**
   * Returns whether the runner is ready to execute turns.
   */
  public isReady(): boolean {
    return this.ready && !this.stopping;
  }

  /**
   * Returns whether the runner is currently executing one turn.
   */
  public isExecutingTurn(): boolean {
    return this.turnExecuting && !this.stopping;
  }

  /**
   * Starts background preparation for a likely next turn using a projected transcript.
   *
   * @param request - Optional projected transcript snapshot and prompt override.
   */
  public async prepareTurn(request: AgentRunnerPrepareRequest = {}): Promise<void> {
    if (!this.ready || !this.ttsProvider) {
      return;
    }

    if (this.stopping || this.turnExecuting) {
      return;
    }

    const promptOverride = normalizeOptionalPromptOverride(request.promptOverride);
    const transcriptSnapshot = normalizeTranscriptSnapshot(
      request.transcriptSnapshot ?? this.transcriptBuffer.getSnapshot(),
      this.room.roomId,
    );
    const transcriptSignature = createPreparedTurnSignature(
      transcriptSnapshot,
      promptOverride,
    );

    if (this.preparedTurn?.transcriptSignature === transcriptSignature) {
      return;
    }

    if (this.preparedTurnSignature === transcriptSignature && this.preparedTurnPromise) {
      await this.preparedTurnPromise;
      return;
    }

    this.preparedTurnSignature = transcriptSignature;
    this.preparedTurnPromise = this.buildPreparedTurn(
      transcriptSnapshot,
      promptOverride,
      transcriptSignature,
    );

    try {
      this.preparedTurn = await this.preparedTurnPromise;
    } finally {
      this.preparedTurnPromise = null;

      if (this.preparedTurn?.transcriptSignature !== transcriptSignature) {
        this.preparedTurnSignature = this.preparedTurn?.transcriptSignature ?? null;
      }
    }
  }

  /**
   * Starts the LiveKit connection, session runtime, and graph bindings.
   */
  public async start(): Promise<void> {
    if (this.ready) {
      return;
    }

    try {
      ensureLiveKitLoggerInitialized();

      const tokenFactory = this.dependencies.createAgentToken ?? createAgentToken;
      const roomFactory = this.dependencies.createRoom ?? (() => new Room());
      const sessionFactory = this.dependencies.createSession ?? (() => new voice.AgentSession({
        preemptiveGeneration: false,
        userAwayTimeout: null,
      }));
      const audioOutputFactory = this.dependencies.createAudioOutput
        ?? ((room) => new RoomAudioOutput(room as Room));
      const vadFactory = this.dependencies.createVadDetector
        ?? (async () => await VADDetector.load());
      const ttsProviderFactory = this.dependencies.createTtsProvider ?? createTTSProvider;
      const sessionBridgeFactory =
        this.dependencies.createSessionBridge ?? createRunnerSessionBridge;

      const token = await tokenFactory(this.room.roomId, this.agent.id);
      const roomConnection = roomFactory();

      await roomConnection.connect(env.LIVEKIT_URL, token, {
        autoSubscribe: false,
        dynacast: false,
      });
      this.roomConnection = roomConnection;

      const session = sessionFactory();
      this.session = session;
      session.input.audio = null;
      session.input.setAudioEnabled(false);
      session.output.transcription = null;
      session.output.setTranscriptionEnabled(false);

      const sessionAudioOutput = audioOutputFactory(roomConnection);
      this.sessionAudioOutput = sessionAudioOutput;

      session.output.audio = sessionAudioOutput as unknown as AgentSessionLike["output"]["audio"];
      await sessionAudioOutput.start();

      await session.start({
        agent: new voice.Agent({
          instructions:
            "You are the Murmur transport publisher. Speak only through session.say() when instructed.",
        }),
      });

      const vadDetector = await vadFactory();
      this.vadDetector = vadDetector;
      const sessionBridge = sessionBridgeFactory({
        vad: vadDetector,
        audioOutput: sessionAudioOutput,
      });
      const ttsProvider = ttsProviderFactory(this.agent.ttsProvider);
      this.ttsProvider = ttsProvider;
      const llmProvider = this.createPromptAwareLLMProvider();
      const contextManager = new ContextManager({
        now: () => this.now().getTime(),
      });

      this.graphBindings = this.createGraphBindings({
        contextManager,
        llmProvider,
        sessionBridge,
        ttsProvider,
      });
      this.graph = createAgentGraph(this.graphBindings);
      this.graphState = createInitialAgentGraphState({
        agentId: this.agent.id,
        roomId: this.room.roomId,
      });
      this.ready = true;

      this.logger.info(
        {
          roomId: this.room.roomId,
          agentId: this.agent.id,
        },
        "Agent runner started.",
      );
      this.emit("ready", {
        roomId: this.room.roomId,
        agentId: this.agent.id,
      });
    } catch (error) {
      const normalizedError = this.captureRuntimeErrorImpl(
        this.logger,
        error,
        {
          stage: "runner_start",
          roomId: this.room.roomId,
          agentId: this.agent.id,
        },
      );

      await this.stop().catch(() => undefined);
      throw normalizedError;
    }
  }

  /**
   * Queues exactly one turn for execution by the runner.
   *
   * @param request - Optional one-turn override instructions.
   */
  public async requestTurn(request: AgentRunnerTurnRequest = {}): Promise<void> {
    if (!this.ready || !this.graph || !this.graphState) {
      throw new Error("AgentRunner.start() must complete before requestTurn().");
    }

    if (this.stopping) {
      throw new Error("AgentRunner is stopping and cannot accept new turns.");
    }

    const promptOverride = normalizeOptionalPromptOverride(request.promptOverride);
    const currentTranscriptSnapshot = normalizeTranscriptSnapshot(
      this.transcriptBuffer.getSnapshot(),
      this.room.roomId,
    );
    const preparedTurnSignature = createPreparedTurnSignature(
      currentTranscriptSnapshot,
      promptOverride,
    );

    this.turnExecutionPromise = this.turnExecutionPromise
      .catch(() => undefined)
      .then(async () => {
        if (!this.ready || !this.graph || !this.graphState) {
          throw new Error("AgentRunner is no longer available for turn execution.");
        }

        if (this.stopping) {
          throw new Error("AgentRunner is stopping and cannot continue turn execution.");
        }

        this.pendingPromptOverride = promptOverride;
        this.turnExecuting = true;
        this.turnAbortController = new AbortController();
        this.turnDeadlineTimer = setTimeout(() => {
          this.turnAbortController?.abort(
            new TurnDeadlineExceededError(env.AGENT_TURN_DEADLINE_MS),
          );
        }, env.AGENT_TURN_DEADLINE_MS);

        try {
          const preparedTurn = await this.consumePreparedTurn(preparedTurnSignature);

          if (preparedTurn && this.graphBindings) {
            this.graphState = {
              ...this.graphState!,
              ...await executeSpeakTurn(
                this.graphBindings,
                this.graphState!,
                preparedTurn.responseText,
                preparedTurn.responseWasFiltered,
                preparedTurn.audioBuffer,
              ),
            };
          } else {
            this.graphState = await this.graph!.invoke(this.graphState);
          }

          if (!this.stopping) {
            this.emit("turnCompleted", {
              roomId: this.room.roomId,
              agentId: this.agent.id,
              turnCount: this.graphState.turnCount,
              lastSpokeAt: this.graphState.lastSpokeAt,
            });
          }
        } catch (error) {
          if (this.isTurnDeadlineExceeded()) {
            await this.handleTurnDeadlineMiss();
            return;
          }

          this.ready = false;
          await this.ensureFloorReleased();
          const normalizedError = this.captureRuntimeErrorImpl(
            this.logger,
            error,
            {
              stage: "turn_execution",
              roomId: this.room.roomId,
              agentId: this.agent.id,
            },
          );

          if (!this.stopping) {
            this.emit("error", normalizedError);
          }

          throw normalizedError;
        } finally {
          if (this.turnDeadlineTimer) {
            clearTimeout(this.turnDeadlineTimer);
            this.turnDeadlineTimer = null;
          }

          this.turnAbortController = null;
          this.turnExecuting = false;
          this.pendingPromptOverride = null;
        }
      });

    return await this.turnExecutionPromise;
  }

  /**
   * Stops the runner and releases owned runtime resources.
   */
  public async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }

    this.stopping = true;
    this.ready = false;
    this.turnAbortController?.abort(new Error("AgentRunner stop requested."));

    await this.ensureFloorReleased().catch(() => undefined);

    await (this.session?.close() ?? Promise.resolve()).catch(() => undefined);
    await this.turnExecutionPromise.catch(() => undefined);

    await Promise.allSettled([
      this.vadDetector?.close() ?? Promise.resolve(),
      this.sessionAudioOutput?.close() ?? Promise.resolve(),
    ]);

    await this.roomConnection?.disconnect().catch(() => undefined);

    this.graph = null;
    this.graphBindings = null;
    this.graphState = null;
    this.session = null;
    this.vadDetector = null;
    this.sessionAudioOutput = null;
    this.roomConnection = null;
    this.ttsProvider = null;
    this.turnExecuting = false;
    this.turnAbortController = null;
    this.preparedTurn = null;
    this.preparedTurnPromise = null;
    this.preparedTurnSignature = null;

    if (this.turnDeadlineTimer) {
      clearTimeout(this.turnDeadlineTimer);
      this.turnDeadlineTimer = null;
    }

    this.emit("stopped", {
      roomId: this.room.roomId,
      agentId: this.agent.id,
    });
  }

  /**
   * Creates the prompt-aware LLM wrapper used by this runner's graph.
   *
   * @returns A runner-local LLM provider that composes the system prompt per turn.
   */
  private createPromptAwareLLMProvider(): LLMProvider {
    return {
      generateResponse: async (
        _systemPrompt: string,
        transcript: string,
        options?: LLMGenerationOptions,
      ): Promise<string> => {
        const override = this.pendingPromptOverride;

        try {
          const systemPrompt = buildAgentSystemPrompt({
            roomTitle: this.room.title,
            roomTopic: this.room.topic,
            roomFormat: this.room.format,
            agent: this.agent,
            peers: this.room.agents.filter((agent) => agent.id !== this.agent.id),
            turnOverride: override,
          });

          return await this.baseLLMProvider.generateResponse(
            systemPrompt,
            transcript,
            this.turnAbortController
              ? {
                  ...options,
                  signal: this.turnAbortController.signal,
                }
              : options,
          );
        } finally {
          this.pendingPromptOverride = null;
        }
      },
    };
  }

  /**
   * Creates the graph bindings for this runner instance.
   *
   * @param dependencies - Turn-local binding dependencies.
   * @returns The full graph bindings object.
   */
  private createGraphBindings(
    dependencies: {
      contextManager: ContextManager;
      llmProvider: LLMProvider;
      sessionBridge: AgentSessionBridge;
      ttsProvider: TTSProvider;
    },
  ): AgentGraphBindings {
    return {
      agent: this.agent,
      roomId: this.room.roomId,
      contextManager: dependencies.contextManager,
      llmProvider: dependencies.llmProvider,
      sessionBridge: dependencies.sessionBridge,
      ttsProvider: dependencies.ttsProvider,
      getFloorStatus: async () => ({
        isFloorHolder:
          (await this.options.floorController.getCurrentHolder()) === this.agent.id,
      }),
      getTranscriptSnapshot: async (): Promise<TranscriptEntry[]> =>
        this.transcriptBuffer.getSnapshot(),
      publishTranscript: async (event: TranscriptEvent): Promise<void> => {
        this.transcriptBuffer.addEntry({
          id: event.id,
          roomId: event.roomId,
          agentId: event.agentId,
          agentName: event.agentName,
          content: event.content,
          timestamp: event.timestamp,
          accentColor: event.accentColor,
          wasFiltered: event.wasFiltered,
        });

        try {
          await Promise.race([
            this.options.transcriptRepository.insertTranscriptEvent(event),
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => {
                reject(
                  new Error(
                    `Timed out persisting transcript event after ${TRANSCRIPT_PERSIST_TIMEOUT_MS}ms.`,
                  ),
                );
              }, TRANSCRIPT_PERSIST_TIMEOUT_MS);
            }),
          ]);
        } catch (error) {
          this.logger.warn(
            {
              agentId: event.agentId,
              eventId: event.id,
              roomId: event.roomId,
              err: error,
            },
            "Transcript event was buffered locally but could not be persisted to PostgreSQL.",
          );
        }

        try {
          await this.transcriptPublisher.publishTranscript(event);
        } catch (error) {
          this.logger.warn(
            {
              agentId: event.agentId,
              eventId: event.id,
              roomId: event.roomId,
              err: error,
            },
            "Transcript event persisted locally but could not be broadcast to Centrifugo.",
          );
        }
      },
      finalizeTurn: async (input: FinalizeTurnInput): Promise<void> => {
        await this.options.floorController.releaseFloor(input.agentId);

        if (input.spokeAt !== null) {
          await this.options.floorController.setAgentLastSpoke(
            input.agentId,
            input.spokeAt,
          );
        }
      },
      onTurnReadyForPlayback: async (input: TurnReadyForPlaybackInput): Promise<void> => {
        if (this.stopping) {
          return;
        }

        this.emit("turnReadyForPlayback", input);
      },
      logger: this.logger,
      now: this.now,
    };
  }

  /**
   * Best-effort floor release used during stop and turn failures.
   */
  private async ensureFloorReleased(): Promise<void> {
    const currentHolder = await this.floorController.getCurrentHolder();

    if (currentHolder === this.agent.id) {
      await this.floorController.releaseFloor(this.agent.id);
    }
  }

  /**
   * Returns whether the active turn was aborted by the room deadline.
   */
  private isTurnDeadlineExceeded(): boolean {
    return this.turnAbortController?.signal.reason instanceof TurnDeadlineExceededError;
  }

  /**
   * Releases the floor and emits a recoverable timeout event for scheduling.
   */
  private async handleTurnDeadlineMiss(): Promise<void> {
    await this.ensureFloorReleased();

    // Treat a deadline miss as a cooldown so the scheduler rotates instead of
    // immediately reselecting the same speaker on the next pass.
    await this.floorController.setAgentLastSpoke(
      this.agent.id,
      this.now().getTime(),
    );

    this.logger.warn(
      {
        roomId: this.room.roomId,
        agentId: this.agent.id,
        deadlineMs: env.AGENT_TURN_DEADLINE_MS,
      },
      "Agent turn exceeded the execution deadline and was skipped.",
    );

    if (!this.stopping) {
      this.emit("turnDeadlineMissed", {
        roomId: this.room.roomId,
        agentId: this.agent.id,
        deadlineMs: env.AGENT_TURN_DEADLINE_MS,
      });
    }
  }

  /**
   * Builds a speculative prepared turn from a projected transcript snapshot.
   */
  private async buildPreparedTurn(
    transcriptSnapshot: TranscriptEntry[],
    promptOverride: string | null,
    transcriptSignature: string,
  ): Promise<PreparedTurn | null> {
    if (!this.ttsProvider || !this.ready || this.stopping) {
      return null;
    }

    try {
      const systemPrompt = this.buildSystemPrompt(promptOverride);
      const transcriptContext = this.buildTranscriptContext(transcriptSnapshot);
      const responseText = await this.baseLLMProvider.generateResponse(
        systemPrompt,
        transcriptContext,
      );
      const moderationResult = filterContent(responseText);
      const audioBuffer = await this.ttsProvider.synthesize(
        moderationResult.clean,
        this.agent.voiceId,
      );

      return {
        audioBuffer,
        responseText: moderationResult.clean,
        responseWasFiltered: moderationResult.wasFiltered,
        transcriptSignature,
      };
    } catch (error) {
      this.logger.warn(
        {
          agentId: this.agent.id,
          roomId: this.room.roomId,
          err: error,
        },
        "Failed to prepare a speculative turn in the background.",
      );
      return null;
    }
  }

  /**
   * Consumes a prepared turn when it exactly matches the current transcript state.
   */
  private async consumePreparedTurn(
    transcriptSignature: string,
  ): Promise<PreparedTurn | null> {
    if (this.preparedTurn?.transcriptSignature === transcriptSignature) {
      const preparedTurn = this.preparedTurn;

      this.preparedTurn = null;
      this.preparedTurnSignature = null;

      return preparedTurn;
    }

    if (this.preparedTurnSignature === transcriptSignature && this.preparedTurnPromise) {
      const preparedTurn = await this.preparedTurnPromise;

      if (preparedTurn?.transcriptSignature === transcriptSignature) {
        this.preparedTurn = null;
        this.preparedTurnSignature = null;
        return preparedTurn;
      }
    }

    this.preparedTurn = null;

    if (this.preparedTurnSignature !== transcriptSignature) {
      this.preparedTurnSignature = null;
    }

    return null;
  }

  /**
   * Builds the canonical system prompt for this runner and optional override.
   */
  private buildSystemPrompt(promptOverride: string | null): string {
    return buildAgentSystemPrompt({
      roomTitle: this.room.title,
      roomTopic: this.room.topic,
      roomFormat: this.room.format,
      agent: this.agent,
      peers: this.room.agents.filter((agent) => agent.id !== this.agent.id),
      turnOverride: promptOverride,
    });
  }

  /**
   * Formats a transcript snapshot into the canonical rolling prompt context.
   */
  private buildTranscriptContext(transcriptSnapshot: TranscriptEntry[]): string {
    const contextManager = new ContextManager({
      now: () => this.now().getTime(),
    });

    contextManager.clear();

    for (const entry of transcriptSnapshot) {
      contextManager.addEntry({
        agentName: entry.agentName,
        content: entry.content,
        timestamp: entry.timestamp,
      });
    }

    return contextManager.getContext();
  }
}

/**
 * Produces a stable cache signature for one speculative turn input.
 */
function createPreparedTurnSignature(
  transcriptSnapshot: readonly TranscriptEntry[],
  promptOverride: string | null,
): string {
  return JSON.stringify({
    promptOverride,
    transcript: transcriptSnapshot.map((entry) => ({
      agentId: entry.agentId,
      agentName: entry.agentName,
      content: entry.content,
      wasFiltered: entry.wasFiltered,
    })),
  });
}

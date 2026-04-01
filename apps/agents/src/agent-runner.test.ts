/**
 * Unit tests for the Murmur agent runner and runner-local session bridge.
 *
 * These tests pin the runner startup contract, transcript side effects,
 * dead-air prompt overrides, VAD-gated speech completion, and floor cleanup.
 */

import type { TranscriptEntry, TranscriptEvent } from "@murmur/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

import type { AgentRuntimeProfile } from "./runtime/agent-profile.js";
import type { LLMGenerationOptions } from "./llm/provider.js";
import { TranscriptBuffer } from "./runtime/transcript-buffer.js";

const ORIGINAL_ENV = { ...process.env };

type AgentRunnerModule = typeof import("./agent-runner.js");

/**
 * Minimal logger double used by runner tests.
 *
 * @returns A quiet logger backed by Vitest spies.
 */
function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * Builds a complete environment fixture suitable for importing runner modules
 * that depend on the validated agents runtime environment.
 *
 * @param overrides - Optional environment overrides per test.
 * @returns A valid process environment object.
 */
function createValidEnvironment(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...ORIGINAL_ENV,
    DATABASE_URL: "postgresql://postgres:secret@example.com:5432/postgres",
    REDIS_URL: "redis://localhost:6379",
    LIVEKIT_API_KEY: "livekit-key",
    LIVEKIT_API_SECRET: "livekit-secret",
    LIVEKIT_URL: "wss://example.livekit.cloud",
    CENTRIFUGO_API_URL: "http://localhost:8000",
    CENTRIFUGO_API_KEY: "centrifugo-api-key",
    OPENROUTER_API_KEY: "sk-or-example",
    OPENROUTER_DEFAULT_MODEL: "openai/gpt-4o",
    OPENROUTER_DEFAULT_MAX_TOKENS: "420",
    CARTESIA_API_KEY: "cartesia-key",
    ELEVENLABS_API_KEY: "elevenlabs-key",
    MISTRAL_API_KEY: "mistral-key",
    SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
    LOG_LEVEL: "silent",
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete environment[key];
      continue;
    }

    environment[key] = value;
  }

  return environment;
}

/**
 * Imports the runner module after priming `process.env`.
 *
 * @param environment - Environment variables to expose during import.
 * @returns The dynamically imported runner module.
 */
async function importAgentRunnerModule(
  environment = createValidEnvironment(),
): Promise<AgentRunnerModule> {
  vi.resetModules();
  process.env = environment;

  return import("./agent-runner.js");
}

/**
 * Flushes queued promise callbacks created during event-driven runner work.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Canonical host profile used by the runner tests.
 */
const HOST_AGENT: AgentRuntimeProfile = {
  id: "agent-nova",
  name: "Nova",
  personality: "Optimistic, incisive, and able to keep momentum high.",
  voiceId: "voice-nova",
  ttsProvider: "cartesia",
  accentColor: "#00D4FF",
  avatarUrl: "/agents/nova.png",
  role: "host",
};

/**
 * Canonical participant profile used by the runner tests.
 */
const PARTICIPANT_AGENT: AgentRuntimeProfile = {
  id: "agent-rex",
  name: "Rex",
  personality: "Skeptical, analytical, and willing to challenge weak claims.",
  voiceId: "voice-rex",
  ttsProvider: "elevenlabs",
  accentColor: "#FF6B35",
  avatarUrl: "/agents/rex.png",
  role: "participant",
};

/**
 * Creates one transcript entry fixture for the runner tests.
 *
 * @param roomId - Room identifier for the fixture entry.
 * @returns A complete transcript entry.
 */
function createTranscriptEntry(roomId: string): TranscriptEntry {
  return {
    id: "entry-1",
    roomId,
    agentId: PARTICIPANT_AGENT.id,
    agentName: PARTICIPANT_AGENT.name,
    content: "Five years still feels too aggressive unless the benchmarks change first.",
    timestamp: "2026-03-28T12:00:05.000Z",
    accentColor: PARTICIPANT_AGENT.accentColor,
    wasFiltered: false,
  };
}

/**
 * Simple room-audio output double used during runner startup tests.
 */
class FakeAudioOutput extends EventEmitter {
  public readonly sampleRate = 24_000;

  public readonly captureFrame = vi.fn(async () => undefined);

  public readonly close = vi.fn(async () => undefined);

  public readonly clearBuffer = vi.fn(() => undefined);

  public readonly flush = vi.fn(() => undefined);

  public readonly start = vi.fn(async () => undefined);

  public readonly waitForPlayout = vi.fn(async () => ({
    playbackPosition: 0,
    interrupted: false,
  }));
}

/**
 * Minimal VAD detector double used by runner tests.
 */
class FakeVADDetector extends EventEmitter {
  public readonly beginSyntheticUtterance = vi.fn(() => undefined);

  public readonly close = vi.fn(async () => undefined);

  public readonly flush = vi.fn(() => undefined);

  public readonly pushFrame = vi.fn(() => undefined);
}

/**
 * Creates a reusable runner fixture with injected collaborators.
 *
 * @param module - Dynamically imported runner module.
 * @param overrides - Per-test behavior overrides.
 * @returns The runner plus its injected collaborators and spies.
 */
function createRunnerFixture(
  module: AgentRunnerModule,
  overrides: {
    createVadDetectorImplementation?: () => Promise<FakeVADDetector>;
    generateResponseImplementation?: (
      systemPrompt: string,
      transcript: string,
      options?: LLMGenerationOptions,
    ) => Promise<string>;
    llmResponses?: string[];
    publishTranscriptImplementation?: (event: TranscriptEvent) => Promise<void>;
    speakTextImplementation?: (text: string, pcmAudio: Buffer) => Promise<void>;
  } = {},
) {
  const roomId = "room-1";
  const room = {
    roomId,
    title: "Is AGI Five Years Away?",
    topic: "Whether near-term AGI timelines are credible.",
    format: "moderated" as const,
    agents: [HOST_AGENT, PARTICIPANT_AGENT],
  };
  const transcriptBuffer = new TranscriptBuffer(roomId, {
    now: () => Date.parse("2026-03-28T12:00:30.000Z"),
  });
  transcriptBuffer.seed([createTranscriptEntry(roomId)]);

  let currentHolder: string | null = HOST_AGENT.id;
  const floorController = {
    getCurrentHolder: vi.fn(async () => currentHolder),
    releaseFloor: vi.fn(async (agentId: string) => {
      const released = currentHolder === agentId;

      if (released) {
        currentHolder = null;
      }

      return released;
    }),
    setAgentLastSpoke: vi.fn(async () => undefined),
  };
  const transcriptRepository = {
    listRecentByRoomId: vi.fn(async () => transcriptBuffer.getSnapshot()),
    insertTranscriptEvent: vi.fn(async () => undefined),
  };
  const transcriptPublisher = {
    publishTranscript: vi.fn(
      overrides.publishTranscriptImplementation
      ?? (async () => undefined),
    ),
  };
  const llmResponses = [...(overrides.llmResponses ?? [
    "The hard part is not raw capability, it's whether the feedback loops compound fast enough.",
  ])];
  const baseLLMProvider = {
    generateResponse: vi.fn(
      overrides.generateResponseImplementation
      ?? (async () => llmResponses.shift() ?? "Fallback response."),
    ),
  };
  const ttsProvider = {
    synthesize: vi.fn(async () => Buffer.from([0, 0, 1, 0])),
  };
  const sessionBridge = {
    speakText: vi.fn(
      overrides.speakTextImplementation
      ?? (async () => undefined),
    ),
  };
  const session = {
    close: vi.fn(async () => undefined),
    say: vi.fn(() => ({
      waitForPlayout: async () => undefined,
    })),
    start: vi.fn(async () => undefined),
    input: {
      audio: { attached: true },
      setAudioEnabled: vi.fn(() => undefined),
    },
    output: {
      audio: null as unknown,
      transcription: { attached: true },
      setTranscriptionEnabled: vi.fn(() => undefined),
    },
  };
  const roomConnection = {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    localParticipant: {
      publishTrack: vi.fn(async () => ({})),
      unpublishTrack: vi.fn(async () => undefined),
    },
  };
  const audioOutput = new FakeAudioOutput();
  const vadDetector = new FakeVADDetector();
  const createVadDetector = vi.fn(
    overrides.createVadDetectorImplementation
    ?? (async () => vadDetector),
  );
  const createAgentToken = vi.fn(async () => "runner-token");
  const logger = createLogger();
  const runner = new module.AgentRunner(
    {
      room,
      agent: HOST_AGENT,
      floorController,
      transcriptBuffer,
      transcriptRepository,
      transcriptPublisher,
      baseLLMProvider,
    },
    {
      createAgentToken,
      createAudioOutput: () => audioOutput,
      createRoom: () => roomConnection,
      createSession: () => session,
      createSessionBridge: () => sessionBridge,
      createTtsProvider: () => ttsProvider,
      createVadDetector,
      logger,
      now: () => new Date("2026-03-28T12:00:30.000Z"),
    },
  );

  return {
    audioOutput,
    baseLLMProvider,
    createAgentToken,
    createVadDetector,
    floorController,
    logger,
    roomConnection,
    runner,
    session,
    sessionBridge,
    transcriptBuffer,
    transcriptPublisher,
    transcriptRepository,
    ttsProvider,
    setCurrentHolder(value: string | null) {
      currentHolder = value;
    },
  };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.resetModules();
  vi.useRealTimers();
});

describe("AgentRunner", () => {
  /**
   * The LiveKit Agents SDK keeps its logger in process-global state and throws
   * during AgentSession construction when callers forget to initialize it.
   */
  it("initializes the LiveKit logger before runner startup constructs session runtime objects", async () => {
    vi.doMock("./livekit/logger.js", () => ({
      ensureLiveKitLoggerInitialized: vi.fn(),
    }));

    const module = await importAgentRunnerModule();
    const livekitLoggerModule = await import("./livekit/logger.js");
    const fixture = createRunnerFixture(module);

    await fixture.runner.start();

    expect(livekitLoggerModule.ensureLiveKitLoggerInitialized).toHaveBeenCalledTimes(1);

    await fixture.runner.stop();
  }, 20_000);

  /**
   * Startup should wire the token, room, session, and audio output exactly once.
   */
  it("starts the room connection and LiveKit session with the canonical runner wiring", async () => {
    const module = await importAgentRunnerModule();
    const fixture = createRunnerFixture(module);
    const readyListener = vi.fn();

    fixture.runner.on("ready", readyListener);
    await fixture.runner.start();

    expect(fixture.createAgentToken).toHaveBeenCalledWith("room-1", HOST_AGENT.id);
    expect(fixture.roomConnection.connect).toHaveBeenCalledWith(
      "wss://example.livekit.cloud",
      "runner-token",
      {
        autoSubscribe: false,
        dynacast: false,
      },
    );
    expect(fixture.session.input.setAudioEnabled).toHaveBeenCalledWith(false);
    expect(fixture.session.output.setTranscriptionEnabled).toHaveBeenCalledWith(false);
    expect(fixture.audioOutput.start).toHaveBeenCalledTimes(1);
    expect(fixture.session.start).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.any(Object),
      }),
    );
    expect(readyListener).toHaveBeenCalledWith({
      roomId: "room-1",
      agentId: HOST_AGENT.id,
    });

    await fixture.runner.stop();
  }, 15_000);

  /**
   * Late startup failures should still unwind every resource that was already
   * connected before the failure happened.
   */
  it("cleans up connected resources when startup fails after the room is connected", async () => {
    const module = await importAgentRunnerModule();
    const fixture = createRunnerFixture(module, {
      createVadDetectorImplementation: async () => {
        throw new Error("VAD load failed.");
      },
    });

    await expect(fixture.runner.start()).rejects.toThrowError(/VAD load failed/i);

    expect(fixture.roomConnection.connect).toHaveBeenCalledTimes(1);
    expect(fixture.audioOutput.start).toHaveBeenCalledTimes(1);
    expect(fixture.session.start).toHaveBeenCalledTimes(1);
    expect(fixture.session.close).toHaveBeenCalledTimes(1);
    expect(fixture.audioOutput.close).toHaveBeenCalledTimes(1);
    expect(fixture.roomConnection.disconnect).toHaveBeenCalledTimes(1);
  });

  /**
   * A successful turn should synthesize audio, persist the transcript, update
   * the room buffer, publish the event, and release the floor.
   */
  it("executes one turn and persists and broadcasts the resulting transcript", async () => {
    const module = await importAgentRunnerModule();
    const fixture = createRunnerFixture(module);
    const turnCompletedListener = vi.fn();

    fixture.runner.on("turnCompleted", turnCompletedListener);
    await fixture.runner.start();
    await fixture.runner.requestTurn();

    const insertedEvent = fixture.transcriptRepository.insertTranscriptEvent.mock.calls[0]?.[0];

    expect(fixture.baseLLMProvider.generateResponse).toHaveBeenCalledWith(
      expect.stringContaining("Identity"),
      expect.stringContaining("[Rex]: Five years still feels too aggressive"),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fixture.ttsProvider.synthesize).toHaveBeenCalledWith(
      "The hard part is not raw capability, it's whether the feedback loops compound fast enough.",
      HOST_AGENT.voiceId,
    );
    expect(fixture.sessionBridge.speakText).toHaveBeenCalledTimes(1);
    expect(fixture.transcriptRepository.insertTranscriptEvent).toHaveBeenCalledTimes(1);
    expect(fixture.transcriptPublisher.publishTranscript).toHaveBeenCalledWith(insertedEvent);
    expect(insertedEvent).toEqual(
      expect.objectContaining({
        type: "transcript",
        roomId: "room-1",
        agentId: HOST_AGENT.id,
        agentName: HOST_AGENT.name,
        content:
          "The hard part is not raw capability, it's whether the feedback loops compound fast enough.",
      }),
    );
    expect(fixture.transcriptBuffer.getSnapshot()).toHaveLength(2);
    expect(fixture.floorController.releaseFloor).toHaveBeenCalledWith(HOST_AGENT.id);
    expect(fixture.floorController.setAgentLastSpoke).toHaveBeenCalledWith(
      HOST_AGENT.id,
      Date.parse("2026-03-28T12:00:30.000Z"),
    );
    expect(turnCompletedListener).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "room-1",
        agentId: HOST_AGENT.id,
        turnCount: 1,
        lastSpokeAt: Date.parse("2026-03-28T12:00:30.000Z"),
      }),
    );

    await fixture.runner.stop();
  });

  /**
   * Speculative preparation should warm the next turn once, then let the
   * foreground request reuse that prepared text and audio instead of repeating
   * LLM generation and synthesis during handoff.
   */
  it("reuses a prepared turn without performing a second LLM or TTS pass", async () => {
    const module = await importAgentRunnerModule();
    const fixture = createRunnerFixture(module, {
      llmResponses: [
        "The next speaker should challenge the weakest assumption before the room settles too fast.",
      ],
    });

    await fixture.runner.start();
    await fixture.runner.prepareTurn();

    expect(fixture.baseLLMProvider.generateResponse).toHaveBeenCalledTimes(1);
    expect(fixture.ttsProvider.synthesize).toHaveBeenCalledTimes(1);
    expect(fixture.transcriptBuffer.getSnapshot()).toHaveLength(1);

    await fixture.runner.requestTurn();

    expect(fixture.baseLLMProvider.generateResponse).toHaveBeenCalledTimes(1);
    expect(fixture.ttsProvider.synthesize).toHaveBeenCalledTimes(1);
    expect(fixture.sessionBridge.speakText).toHaveBeenCalledWith(
      "The next speaker should challenge the weakest assumption before the room settles too fast.",
      expect.any(Buffer),
    );
    expect(fixture.transcriptRepository.insertTranscriptEvent).toHaveBeenCalledTimes(1);
    expect(fixture.transcriptPublisher.publishTranscript).toHaveBeenCalledTimes(1);

    await fixture.runner.stop();
  });

  /**
   * Speculative preparation should survive the projected-to-persisted
   * transcript transition that happens when a current speaker finishes. The
   * actual published transcript event gets a new id and timestamp, so reuse
   * must depend on stable conversational content rather than those volatile
   * fields.
   */
  it("reuses a prepared turn after the projected transcript becomes a persisted event", async () => {
    const module = await importAgentRunnerModule();
    const fixture = createRunnerFixture(module, {
      llmResponses: [
        "That is exactly where the timeline gets shaky, because the bottleneck is iteration speed rather than headline capability.",
      ],
    });

    await fixture.runner.start();

    await fixture.runner.prepareTurn({
      transcriptSnapshot: [
        ...fixture.transcriptBuffer.getSnapshot(),
        {
          id: "projected-host-turn",
          roomId: "room-1",
          agentId: PARTICIPANT_AGENT.id,
          agentName: PARTICIPANT_AGENT.name,
          content: "Nova just framed the bottleneck as iteration speed, not raw capability.",
          timestamp: "2026-03-28T12:00:30.000Z",
          accentColor: PARTICIPANT_AGENT.accentColor,
          wasFiltered: false,
        },
      ],
    });

    fixture.transcriptBuffer.addEntry({
      id: "persisted-host-turn",
      roomId: "room-1",
      agentId: PARTICIPANT_AGENT.id,
      agentName: PARTICIPANT_AGENT.name,
      content: "Nova just framed the bottleneck as iteration speed, not raw capability.",
      timestamp: "2026-03-28T12:00:47.000Z",
      accentColor: PARTICIPANT_AGENT.accentColor,
      wasFiltered: false,
    });

    await fixture.runner.requestTurn();

    expect(fixture.baseLLMProvider.generateResponse).toHaveBeenCalledTimes(1);
    expect(fixture.ttsProvider.synthesize).toHaveBeenCalledTimes(1);
    expect(fixture.sessionBridge.speakText).toHaveBeenCalledWith(
      "That is exactly where the timeline gets shaky, because the bottleneck is iteration speed rather than headline capability.",
      expect.any(Buffer),
    );

    await fixture.runner.stop();
  });

  /**
   * Realtime broadcast failures should not invalidate a turn after the
   * transcript has already been persisted locally.
   */
  it("keeps the turn successful when Centrifugo transcript broadcast fails", async () => {
    const module = await importAgentRunnerModule();
    const fixture = createRunnerFixture(module, {
      publishTranscriptImplementation: async () => {
        throw new Error("centrifugo unavailable");
      },
    });
    const turnCompletedListener = vi.fn();

    fixture.runner.on("turnCompleted", turnCompletedListener);
    await fixture.runner.start();
    await fixture.runner.requestTurn();

    expect(fixture.transcriptRepository.insertTranscriptEvent).toHaveBeenCalledTimes(1);
    expect(fixture.transcriptPublisher.publishTranscript).toHaveBeenCalledTimes(1);
    expect(fixture.floorController.releaseFloor).toHaveBeenCalledWith(HOST_AGENT.id);
    expect(turnCompletedListener).toHaveBeenCalledTimes(1);
    expect(fixture.baseLLMProvider.generateResponse).toHaveBeenCalledTimes(1);
    expect(fixture.ttsProvider.synthesize).toHaveBeenCalledTimes(1);
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: HOST_AGENT.id,
        roomId: "room-1",
        err: expect.any(Error),
      }),
      "Transcript event persisted locally but could not be broadcast to Centrifugo.",
    );

    await fixture.runner.stop();
  });

  /**
   * Dead-air prompt overrides should affect exactly one turn and then clear.
   */
  it("consumes a dead-air override once and rebuilds the system prompt on every turn", async () => {
    const module = await importAgentRunnerModule();
    const fixture = createRunnerFixture(module, {
      llmResponses: [
        "Someone needs to say what would falsify the five-year claim.",
        "The stronger disagreement is whether the bottleneck is data, compute, or iteration speed.",
      ],
    });

    await fixture.runner.start();
    await fixture.runner.requestTurn({
      promptOverride:
        "The conversation has gone quiet. Re-open the disagreement with a sharper challenge.",
    });
    fixture.setCurrentHolder(HOST_AGENT.id);
    await fixture.runner.requestTurn();

    const firstPrompt = fixture.baseLLMProvider.generateResponse.mock.calls[0]?.[0];
    const secondPrompt = fixture.baseLLMProvider.generateResponse.mock.calls[1]?.[0];

    expect(firstPrompt).toContain("Dead-air recovery is active for this turn.");
    expect(firstPrompt).toContain("Do not open with a generic greeting");
    expect(firstPrompt).toContain(
      "Additional turn-specific instruction: The conversation has gone quiet. Re-open the disagreement with a sharper challenge.",
    );
    expect(secondPrompt).toContain(
      "No special override is active for this turn. Continue the conversation under the rules above.",
    );
    expect(secondPrompt).not.toContain(
      "The conversation has gone quiet. Re-open the disagreement with a sharper challenge.",
    );

    await fixture.runner.stop();
  });

  /**
   * Turn-budget misses should abort the active generation, release the floor,
   * cool down the agent for scheduling, and keep the runner reusable.
   */
  it("treats a turn deadline miss as a recoverable scheduling event", async () => {
    const module = await importAgentRunnerModule(createValidEnvironment({
      AGENT_TURN_DEADLINE_MS: "5",
    }));
    const fixture = createRunnerFixture(module, {
      generateResponseImplementation: async (
        _systemPrompt,
        _transcript,
        options,
      ) => await new Promise<string>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          reject(options.signal?.reason);
        }, { once: true });
      }),
    });
    const errorListener = vi.fn();
    const turnDeadlineMissedListener = vi.fn();

    fixture.runner.on("error", errorListener);
    fixture.runner.on("turnDeadlineMissed", turnDeadlineMissedListener);
    await fixture.runner.start();

    await expect(fixture.runner.requestTurn()).resolves.toBeUndefined();

    expect(turnDeadlineMissedListener).toHaveBeenCalledWith({
      roomId: "room-1",
      agentId: HOST_AGENT.id,
      deadlineMs: 5,
    });
    expect(errorListener).not.toHaveBeenCalled();
    expect(fixture.runner.isReady()).toBe(true);
    expect(fixture.floorController.releaseFloor).toHaveBeenCalledWith(HOST_AGENT.id);
    expect(fixture.floorController.setAgentLastSpoke).toHaveBeenCalledWith(
      HOST_AGENT.id,
      Date.parse("2026-03-28T12:00:30.000Z"),
    );
    expect(fixture.ttsProvider.synthesize).not.toHaveBeenCalled();

    await fixture.runner.stop();
  });

  /**
   * The runner-local bridge should not resolve until audio playout finishes and
   * Murmur's fixed trailing-silence boundary has elapsed.
   */
  it("waits for both playout and the trailing silence boundary in the custom session bridge", async () => {
    vi.useFakeTimers();

    const module = await importAgentRunnerModule();
    const vadDetector = new FakeVADDetector();
    let resolvePlayout!: () => void;
    const playoutPromise = new Promise<void>((resolve) => {
      resolvePlayout = resolve;
    });
    const playbackStartedListeners = new Set<() => void>();
    const audioOutput = {
      sampleRate: 24_000,
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      captureFrame: vi.fn(async () => undefined),
      clearBuffer: vi.fn(() => undefined),
      flush: vi.fn(() => undefined),
      waitForPlayout: vi.fn(() => playoutPromise.then(() => ({
        playbackPosition: 1,
        interrupted: false,
      }))),
      on: vi.fn((eventName: string, listener: () => void) => {
        if (eventName === "playbackStarted") {
          playbackStartedListeners.add(listener);
        }

        return audioOutput;
      }),
      off: vi.fn((eventName: string, listener: () => void) => {
        if (eventName === "playbackStarted") {
          playbackStartedListeners.delete(listener);
        }

        return audioOutput;
      }),
    } as unknown as FakeAudioOutput;
    const bridge = module.createRunnerSessionBridge({
      vad: vadDetector,
      audioOutput: audioOutput as never,
      timeoutMs: 500,
    });
    let settled = false;
    const speakPromise = bridge.speakText("Short turn.", Buffer.from([0, 0, 1, 0]))
      .then(() => {
        settled = true;
      });

    await flushMicrotasks();
    for (const listener of playbackStartedListeners) {
      listener();
    }
    resolvePlayout();
    await flushMicrotasks();

    expect(settled).toBe(false);
    expect(vadDetector.beginSyntheticUtterance).toHaveBeenCalledTimes(1);
    expect(vadDetector.pushFrame).toHaveBeenCalled();
    expect(vadDetector.flush).toHaveBeenCalledTimes(1);
    expect(audioOutput.captureFrame).toHaveBeenCalled();
    expect(audioOutput.flush).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_499);
    await flushMicrotasks();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await speakPromise;

    expect(settled).toBe(true);
    expect(audioOutput.waitForPlayout).toHaveBeenCalledTimes(1);
  });

  /**
   * Long synthesized turns should extend the synthetic turn-boundary watchdog
   * so valid speech does not fail just because the utterance lasts longer than
   * the base timeout floor.
   */
  it("scales the synthetic turn-boundary timeout to the synthesized audio duration", async () => {
    vi.useFakeTimers();

    const module = await importAgentRunnerModule();
    const vadDetector = new FakeVADDetector();
    const playbackStartedListeners = new Set<() => void>();
    const audioOutput = {
      sampleRate: 24_000,
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      captureFrame: vi.fn(async () => undefined),
      clearBuffer: vi.fn(() => undefined),
      flush: vi.fn(() => undefined),
      waitForPlayout: vi.fn(async () => ({
        playbackPosition: 2,
        interrupted: false,
      })),
      on: vi.fn((eventName: string, listener: () => void) => {
        if (eventName === "playbackStarted") {
          playbackStartedListeners.add(listener);
        }

        return audioOutput;
      }),
      off: vi.fn((eventName: string, listener: () => void) => {
        if (eventName === "playbackStarted") {
          playbackStartedListeners.delete(listener);
        }

        return audioOutput;
      }),
    } as unknown as FakeAudioOutput;
    const bridge = module.createRunnerSessionBridge({
      vad: vadDetector,
      audioOutput: audioOutput as never,
      timeoutMs: 500,
    });
    const longPcmAudio = Buffer.alloc(96_000, 0);
    let rejection: Error | null = null;
    let settled = false;
    const speakPromise = bridge.speakText("Long turn.", longPcmAudio)
      .then(() => {
        settled = true;
      })
      .catch((error: Error) => {
        rejection = error;
      });

    for (const listener of playbackStartedListeners) {
      listener();
    }
    await vi.advanceTimersByTimeAsync(600);
    await flushMicrotasks();

    expect(rejection).toBeNull();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1_500);
    await speakPromise;

    expect(rejection).toBeNull();
    expect(settled).toBe(true);
  });

  /**
   * Stop should best-effort release the floor even when no new turn is being executed.
   */
  it("releases the floor when the runner stops", async () => {
    const module = await importAgentRunnerModule();
    const fixture = createRunnerFixture(module);

    await fixture.runner.start();
    await fixture.runner.stop();

    expect(fixture.floorController.releaseFloor).toHaveBeenCalledWith(HOST_AGENT.id);
  });

  /**
   * Stop should wait for any in-flight turn to settle and suppress the
   * teardown-induced error event that would otherwise be emitted mid-shutdown.
   */
  it("waits for an in-flight turn to settle without emitting an error during stop", async () => {
    const module = await importAgentRunnerModule();
    let rejectSpeakText!: (error: Error) => void;
    const fixture = createRunnerFixture(module, {
      speakTextImplementation: async () => await new Promise<void>((_, reject) => {
        rejectSpeakText = (error: Error) => {
          reject(error);
        };
      }),
    });
    const errorListener = vi.fn();
    const stoppedListener = vi.fn();

    fixture.runner.on("error", errorListener);
    fixture.runner.on("stopped", stoppedListener);
    await fixture.runner.start();

    const requestTurnPromise = fixture.runner.requestTurn();

    await vi.waitFor(() => {
      expect(fixture.sessionBridge.speakText).toHaveBeenCalledTimes(1);
    });

    const stopPromise = fixture.runner.stop();

    await flushMicrotasks();
    expect(stoppedListener).not.toHaveBeenCalled();

    rejectSpeakText(new Error("Session closed during stop."));
    await expect(requestTurnPromise).rejects.toThrowError(/Session closed during stop/i);
    await stopPromise;

    expect(errorListener).not.toHaveBeenCalled();
    expect(stoppedListener).toHaveBeenCalledTimes(1);
  });

  /**
   * Stop should not close the room audio output while an in-flight turn is
   * still settling, because the synthetic speech boundary task may still be
   * draining frames through that shared output.
   */
  it("waits for an in-flight turn before closing the room audio output", async () => {
    const module = await importAgentRunnerModule();
    let rejectSpeakText!: (error: Error) => void;
    const fixture = createRunnerFixture(module, {
      speakTextImplementation: async () => await new Promise<void>((_, reject) => {
        rejectSpeakText = (error: Error) => {
          reject(error);
        };
      }),
    });

    await fixture.runner.start();

    const requestTurnPromise = fixture.runner.requestTurn();

    await vi.waitFor(() => {
      expect(fixture.sessionBridge.speakText).toHaveBeenCalledTimes(1);
    });

    const stopPromise = fixture.runner.stop();

    await flushMicrotasks();
    expect(fixture.audioOutput.close).not.toHaveBeenCalled();

    rejectSpeakText(new Error("Synthetic speech bridge interrupted during stop."));
    await expect(requestTurnPromise).rejects.toThrowError(
      /Synthetic speech bridge interrupted during stop/i,
    );
    await stopPromise;

    expect(fixture.audioOutput.close).toHaveBeenCalledTimes(1);
  });

  /**
   * Stop should wait for the session to shut down before tearing down the
   * custom audio output that the session may still be draining.
   */
  it("waits for session shutdown before closing the custom audio output", async () => {
    const module = await importAgentRunnerModule();
    const fixture = createRunnerFixture(module);
    let resolveSessionClose!: () => void;
    const sessionClosePromise = new Promise<void>((resolve) => {
      resolveSessionClose = resolve;
    });

    fixture.session.close.mockImplementation(() => sessionClosePromise);

    await fixture.runner.start();

    const stopPromise = fixture.runner.stop();

    await vi.waitFor(() => {
      expect(fixture.session.close).toHaveBeenCalledTimes(1);
    });
    expect(fixture.audioOutput.close).not.toHaveBeenCalled();

    resolveSessionClose();
    await stopPromise;

    expect(fixture.audioOutput.close).toHaveBeenCalledTimes(1);
  });

  /**
   * Transcript fan-out failures should stay visible in logs without tearing
   * down the runner after the local transcript write already succeeded.
   */
  it("keeps the runner ready when transcript broadcasting fails", async () => {
    const module = await importAgentRunnerModule();
    const fixture = createRunnerFixture(module, {
      publishTranscriptImplementation: async () => {
        throw new Error("Centrifugo is unavailable.");
      },
    });
    const errorListener = vi.fn();

    fixture.runner.on("error", errorListener);
    await fixture.runner.start();

    await expect(fixture.runner.requestTurn()).resolves.toBeUndefined();
    expect(errorListener).not.toHaveBeenCalled();
    expect(fixture.runner.isReady()).toBe(true);
    expect(fixture.floorController.releaseFloor).toHaveBeenCalledWith(HOST_AGENT.id);
    await expect(fixture.runner.requestTurn()).resolves.toBeUndefined();
    expect(fixture.logger.warn).toHaveBeenCalled();

    await fixture.runner.stop();
  });

  /**
   * Transcript persistence failures should not block turn completion or force a
   * runner restart after the live room already heard the spoken turn.
   */
  it("keeps the runner ready when transcript persistence fails", async () => {
    const module = await importAgentRunnerModule();
    const fixture = createRunnerFixture(module);
    const errorListener = vi.fn();

    fixture.transcriptRepository.insertTranscriptEvent.mockRejectedValue(
      new Error("PostgreSQL timed out."),
    );

    fixture.runner.on("error", errorListener);
    await fixture.runner.start();

    await expect(fixture.runner.requestTurn()).resolves.toBeUndefined();
    expect(errorListener).not.toHaveBeenCalled();
    expect(fixture.runner.isReady()).toBe(true);
    expect(fixture.floorController.releaseFloor).toHaveBeenCalledWith(HOST_AGENT.id);
    expect(fixture.logger.warn).toHaveBeenCalled();

    await fixture.runner.stop();
  });
});

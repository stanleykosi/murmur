/**
 * Unit tests for the Murmur agents orchestrator.
 *
 * These assertions pin room bootstrap, scheduling, polling, dead-air routing,
 * runner restart backoff, mute-aware candidate selection, and the health
 * endpoint payload for Step 34.
 */

import type { AgentRuntimeProfile } from "./runtime/agent-profile.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const ORIGINAL_ENV = { ...process.env };

type OrchestratorModule = typeof import("./orchestrator.js");

/**
 * Minimal logger double used by orchestrator tests.
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
 * Builds a valid environment fixture for importing the orchestrator module.
 *
 * @param overrides - Optional environment overrides.
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
 * Imports the orchestrator module after priming `process.env`.
 *
 * @param environment - Environment variables to expose during import.
 * @returns The dynamically imported orchestrator module.
 */
async function importOrchestratorModule(
  environment = createValidEnvironment(),
): Promise<OrchestratorModule> {
  vi.resetModules();
  process.env = environment;

  return import("./orchestrator.js");
}

/**
 * Replaces the real HTTP health-server lifecycle with inert test doubles.
 *
 * This keeps lifecycle-focused tests deterministic in environments where
 * opening sockets is restricted or unnecessary.
 *
 * @param module - Imported orchestrator module to patch.
 */
function stubHealthServerLifecycle(module: OrchestratorModule): void {
  vi.spyOn(module.Orchestrator.prototype as any, "startHealthServer")
    .mockImplementation(async function startHealthServerStub(this: {
      healthServerPort: number | null;
    }) {
      this.healthServerPort = 0;
    });
  vi.spyOn(module.Orchestrator.prototype as any, "closeHealthServer")
    .mockImplementation(async function closeHealthServerStub(this: {
      healthServer: unknown | null;
      healthServerPort: number | null;
    }) {
      this.healthServer = null;
      this.healthServerPort = null;
    });
}

/**
 * Flushes queued microtasks created by async event handlers.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Canonical host fixture used by orchestrator tests.
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
 * Canonical participant fixture used by orchestrator tests.
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
 * Creates one active room fixture with the supplied identifier.
 *
 * @param roomId - Room identifier for the fixture.
 * @returns A complete active-room definition.
 */
function createRoom(roomId: string) {
  return {
    id: roomId,
    title: `Room ${roomId}`,
    topic: `Topic for ${roomId}`,
    format: "moderated" as const,
    agents: [HOST_AGENT, PARTICIPANT_AGENT],
    hostAgentId: HOST_AGENT.id,
    fingerprint: `fingerprint:${roomId}:v1`,
  };
}

/**
 * Runner double used by orchestrator tests.
 */
class FakeRunner extends EventEmitter {
  private ready = false;

  public readonly requestTurn = vi.fn(async () => undefined);

  public readonly start = vi.fn(async () => {
    this.ready = true;
    this.emit("ready", {
      roomId: this.roomId,
      agentId: this.agent.id,
    });
  });

  public readonly stop = vi.fn(async () => {
    this.ready = false;
    this.emit("stopped", {
      roomId: this.roomId,
      agentId: this.agent.id,
    });
  });

  /**
   * Creates a fake runner bound to one room/agent pair.
   *
   * @param roomId - Owning room identifier.
   * @param agent - Room-assigned agent.
   */
  public constructor(
    private readonly roomId: string,
    private readonly agent: AgentRuntimeProfile,
  ) {
    super();
  }

  /**
   * Returns the assigned runtime profile.
   */
  public getAgentProfile(): AgentRuntimeProfile {
    return this.agent;
  }

  /**
   * Returns whether the fake runner is ready.
   */
  public isReady(): boolean {
    return this.ready;
  }
}

/**
 * Silence-timer double used by orchestrator tests.
 */
class FakeSilenceTimer extends EventEmitter {
  public readonly start = vi.fn(() => undefined);

  public readonly stop = vi.fn(() => undefined);
}

/**
 * Creates one deterministic floor-controller double.
 *
 * @param mutedAgents - Agents that should be treated as muted in this room.
 * @returns A controller-like object plus mutable test helpers.
 */
function createFloorController(mutedAgents: ReadonlySet<string> = new Set()) {
  let currentHolder: string | null = null;
  const lastSpoke = new Map<string, number>();

  return {
    claimFloor: vi.fn(async (agentId: string) => {
      if (currentHolder !== null || mutedAgents.has(agentId)) {
        return false;
      }

      currentHolder = agentId;
      return true;
    }),
    getAgentLastSpoke: vi.fn(async (agentId: string) => lastSpoke.get(agentId) ?? null),
    getCurrentHolder: vi.fn(async () => currentHolder),
    isAgentMuted: vi.fn(async (agentId: string) => mutedAgents.has(agentId)),
    releaseFloor: vi.fn(async (agentId: string) => {
      const released = currentHolder === agentId;

      if (released) {
        currentHolder = null;
      }

      return released;
    }),
    setAgentLastSpoke: vi.fn(async (agentId: string, timestamp: number) => {
      lastSpoke.set(agentId, timestamp);
    }),
    setHolder(agentId: string | null) {
      currentHolder = agentId;
    },
  };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.resetModules();
  vi.useRealTimers();
});

describe("Orchestrator", () => {
  /**
   * Bootstrap should start all runners, start the silence timer, and
   * immediately schedule the first speaker.
   */
  it("bootstraps a room runtime and immediately schedules the host first", async () => {
    const module = await importOrchestratorModule();
    const currentRooms = [createRoom("room-a")];
    const runners = new Map<string, FakeRunner[]>();
    const silenceTimers = new Map<string, FakeSilenceTimer>();
    const floorControllers = new Map<string, ReturnType<typeof createFloorController>>();
    const createRunner = vi.fn((options: {
      room: { roomId: string };
      agent: AgentRuntimeProfile;
    }) => {
      const runner = new FakeRunner(options.room.roomId, options.agent);
      const key = `${options.room.roomId}:${options.agent.id}`;
      const entries = runners.get(key) ?? [];

      entries.push(runner);
      runners.set(key, entries);
      return runner;
    });
    const createSilenceTimer = vi.fn((_: unknown, roomId: string) => {
      const timer = new FakeSilenceTimer();

      silenceTimers.set(roomId, timer);
      return timer;
    });
    const createFloorControllerFactory = vi.fn((roomId: string) => {
      const controller = createFloorController();

      floorControllers.set(roomId, controller);
      return controller;
    });
    const orchestrator = new module.Orchestrator({
      captureRuntimeError: (logger, error) => (logger.error(error), error as Error),
      closeDatabasePool: async () => undefined,
      closeRedis: async () => undefined,
      connectRedis: async () => undefined,
      createFloorController: createFloorControllerFactory,
      createRunner,
      createSilenceTimer,
      logger: createLogger(),
      pingRedis: async () => undefined,
      pollIntervalMs: 60_000,
      roomRepository: {
        listActiveRooms: vi.fn(async () => currentRooms),
      },
      testDatabaseConnection: async () => ({
        databaseName: "postgres",
        serverTime: "2026-03-28 12:00:00+00",
      }),
      transcriptRepository: {
        insertTranscriptEvent: vi.fn(async () => undefined),
        listRecentByRoomId: vi.fn(async () => []),
      },
      healthPort: 0,
    });

    await orchestrator.start();

    const hostRunner = runners.get(`room-a:${HOST_AGENT.id}`)?.[0];
    const participantRunner = runners.get(`room-a:${PARTICIPANT_AGENT.id}`)?.[0];

    expect(hostRunner?.start).toHaveBeenCalledTimes(1);
    expect(participantRunner?.start).toHaveBeenCalledTimes(1);
    expect(silenceTimers.get("room-a")?.start).toHaveBeenCalledTimes(1);
    expect(hostRunner?.requestTurn).toHaveBeenCalledTimes(1);
    expect(participantRunner?.requestTurn).not.toHaveBeenCalled();
    expect(orchestrator.getActiveRoomCount()).toBe(1);
    expect(orchestrator.getActiveRunnerCount()).toBe(2);

    await orchestrator.stop();
  }, 15_000);

  /**
   * Startup should recover any stale Redis floor claim before choosing the
   * first speaker for the freshly booted room runtime.
   */
  it("releases a persisted floor claim before bootstrap scheduling", async () => {
    const module = await importOrchestratorModule();
    const currentRooms = [createRoom("room-a")];
    const runners = new Map<string, FakeRunner[]>();
    const floorControllers = new Map<string, ReturnType<typeof createFloorController>>();
    const createRunner = vi.fn((options: {
      room: { roomId: string };
      agent: AgentRuntimeProfile;
    }) => {
      const runner = new FakeRunner(options.room.roomId, options.agent);
      const key = `${options.room.roomId}:${options.agent.id}`;
      const entries = runners.get(key) ?? [];

      entries.push(runner);
      runners.set(key, entries);
      return runner;
    });
    const orchestrator = new module.Orchestrator({
      captureRuntimeError: (logger, error) => (logger.error(error), error as Error),
      closeDatabasePool: async () => undefined,
      closeRedis: async () => undefined,
      connectRedis: async () => undefined,
      createFloorController: (roomId: string) => {
        const controller = createFloorController();

        controller.setHolder(PARTICIPANT_AGENT.id);
        floorControllers.set(roomId, controller);
        return controller;
      },
      createRunner,
      createSilenceTimer: () => new FakeSilenceTimer(),
      logger: createLogger(),
      pingRedis: async () => undefined,
      pollIntervalMs: 60_000,
      roomRepository: {
        listActiveRooms: vi.fn(async () => currentRooms),
      },
      testDatabaseConnection: async () => ({
        databaseName: "postgres",
        serverTime: "2026-03-28 12:00:00+00",
      }),
      transcriptRepository: {
        insertTranscriptEvent: vi.fn(async () => undefined),
        listRecentByRoomId: vi.fn(async () => []),
      },
      healthHost: "127.0.0.1",
      healthPort: 0,
    });

    await orchestrator.start();

    const hostRunner = runners.get(`room-a:${HOST_AGENT.id}`)?.[0];
    const floorController = floorControllers.get("room-a");

    expect(floorController?.releaseFloor).toHaveBeenCalledWith(PARTICIPANT_AGENT.id);
    expect(hostRunner?.requestTurn).toHaveBeenCalledTimes(1);

    await orchestrator.stop();
  });

  /**
   * Room polling should start runtimes for new rooms and stop runtimes for
   * rooms that have ended or left the live set.
   */
  it("adds new rooms on sync and stops runtimes for rooms that disappear", async () => {
    const module = await importOrchestratorModule();
    const roomA = createRoom("room-a");
    const roomB = createRoom("room-b");
    let currentRooms = [roomA];
    const runners = new Map<string, FakeRunner[]>();
    const createRunner = vi.fn((options: {
      room: { roomId: string };
      agent: AgentRuntimeProfile;
    }) => {
      const runner = new FakeRunner(options.room.roomId, options.agent);
      const key = `${options.room.roomId}:${options.agent.id}`;
      const entries = runners.get(key) ?? [];

      entries.push(runner);
      runners.set(key, entries);
      return runner;
    });
    const orchestrator = new module.Orchestrator({
      captureRuntimeError: (logger, error) => (logger.error(error), error as Error),
      closeDatabasePool: async () => undefined,
      closeRedis: async () => undefined,
      connectRedis: async () => undefined,
      createFloorController: () => createFloorController(),
      createRunner,
      createSilenceTimer: () => new FakeSilenceTimer(),
      logger: createLogger(),
      pingRedis: async () => undefined,
      pollIntervalMs: 60_000,
      roomRepository: {
        listActiveRooms: vi.fn(async () => currentRooms),
      },
      testDatabaseConnection: async () => ({
        databaseName: "postgres",
        serverTime: "2026-03-28 12:00:00+00",
      }),
      transcriptRepository: {
        insertTranscriptEvent: vi.fn(async () => undefined),
        listRecentByRoomId: vi.fn(async () => []),
      },
      healthPort: 0,
    });

    await orchestrator.start();
    currentRooms = [roomA, roomB];
    await orchestrator.syncRooms();

    expect(runners.get(`room-b:${HOST_AGENT.id}`)?.[0]?.start).toHaveBeenCalledTimes(1);
    expect(orchestrator.getActiveRoomCount()).toBe(2);

    currentRooms = [roomB];
    await orchestrator.syncRooms();

    expect(runners.get(`room-a:${HOST_AGENT.id}`)?.[0]?.stop).toHaveBeenCalledTimes(1);
    expect(orchestrator.getActiveRoomCount()).toBe(1);

    await orchestrator.stop();
  });

  /**
   * Teardown should keep runner error handlers in place until the runner has
   * finished stopping so late stop-time failures cannot become unhandled.
   */
  it("keeps runner error handlers attached until runner stop completes", async () => {
    const module = await importOrchestratorModule();
    const currentRooms = [createRoom("room-a")];
    const errorListenerCountsAtStop: number[] = [];
    const createRunner = vi.fn((options: {
      room: { roomId: string };
      agent: AgentRuntimeProfile;
    }) => {
      const runner = new EventEmitter();
      let ready = false;

      return Object.assign(runner, {
        getAgentProfile: () => options.agent,
        isReady: () => ready,
        requestTurn: vi.fn(async () => undefined),
        start: vi.fn(async () => {
          ready = true;
          runner.emit("ready", {
            roomId: options.room.roomId,
            agentId: options.agent.id,
          });
        }),
        stop: vi.fn(async () => {
          errorListenerCountsAtStop.push(runner.listenerCount("error"));
          ready = false;
          runner.emit("stopped", {
            roomId: options.room.roomId,
            agentId: options.agent.id,
          });
        }),
      });
    });
    const orchestrator = new module.Orchestrator({
      captureRuntimeError: (logger, error) => (logger.error(error), error as Error),
      closeDatabasePool: async () => undefined,
      closeRedis: async () => undefined,
      connectRedis: async () => undefined,
      createFloorController: () => createFloorController(),
      createRunner,
      createSilenceTimer: () => new FakeSilenceTimer(),
      logger: createLogger(),
      pingRedis: async () => undefined,
      pollIntervalMs: 60_000,
      roomRepository: {
        listActiveRooms: vi.fn(async () => currentRooms),
      },
      testDatabaseConnection: async () => ({
        databaseName: "postgres",
        serverTime: "2026-03-28 12:00:00+00",
      }),
      transcriptRepository: {
        insertTranscriptEvent: vi.fn(async () => undefined),
        listRecentByRoomId: vi.fn(async () => []),
      },
      healthHost: "127.0.0.1",
      healthPort: 0,
    });

    await orchestrator.start();
    await orchestrator.stop();

    expect(errorListenerCountsAtStop).toEqual([1, 1]);
  });

  /**
   * Runner failures should trigger capped exponential restart scheduling.
   */
  it("restarts failed runners with exponential backoff", async () => {
    vi.useFakeTimers();

    const module = await importOrchestratorModule();
    const currentRooms = [createRoom("room-a")];
    const runners = new Map<string, FakeRunner[]>();
    const createRunner = vi.fn((options: {
      room: { roomId: string };
      agent: AgentRuntimeProfile;
    }) => {
      const runner = new FakeRunner(options.room.roomId, options.agent);
      const key = `${options.room.roomId}:${options.agent.id}`;
      const entries = runners.get(key) ?? [];

      entries.push(runner);
      runners.set(key, entries);
      return runner;
    });
    const orchestrator = new module.Orchestrator({
      captureRuntimeError: (logger, error) => (logger.error(error), error as Error),
      closeDatabasePool: async () => undefined,
      closeRedis: async () => undefined,
      connectRedis: async () => undefined,
      createFloorController: () => createFloorController(),
      createRunner,
      createSilenceTimer: () => new FakeSilenceTimer(),
      logger: createLogger(),
      pingRedis: async () => undefined,
      pollIntervalMs: 60_000,
      roomRepository: {
        listActiveRooms: vi.fn(async () => currentRooms),
      },
      testDatabaseConnection: async () => ({
        databaseName: "postgres",
        serverTime: "2026-03-28 12:00:00+00",
      }),
      transcriptRepository: {
        insertTranscriptEvent: vi.fn(async () => undefined),
        listRecentByRoomId: vi.fn(async () => []),
      },
      healthPort: 0,
    });

    await orchestrator.start();

    const initialHostRunner = runners.get(`room-a:${HOST_AGENT.id}`)?.[0];

    initialHostRunner?.emit("error", new Error("runner failure one"));
    await vi.advanceTimersByTimeAsync(999);

    expect(runners.get(`room-a:${HOST_AGENT.id}`)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);

    const afterFirstRestart = runners.get(`room-a:${HOST_AGENT.id}`);

    expect(afterFirstRestart).toHaveLength(2);
    expect(initialHostRunner?.stop).toHaveBeenCalledTimes(1);

    afterFirstRestart?.[1]?.emit("error", new Error("runner failure two"));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(runners.get(`room-a:${HOST_AGENT.id}`)).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(runners.get(`room-a:${HOST_AGENT.id}`)).toHaveLength(3);

    await orchestrator.stop();
  });

  /**
   * A successful replacement runner should immediately re-enter normal speaker
   * scheduling when the failed turn had already released the floor.
   */
  it("schedules the next speaker immediately after a runner restarts", async () => {
    vi.useFakeTimers();

    const module = await importOrchestratorModule();
    const currentRooms = [createRoom("room-a")];
    const runners = new Map<string, FakeRunner[]>();
    const floorControllers = new Map<string, ReturnType<typeof createFloorController>>();
    const createRunner = vi.fn((options: {
      room: { roomId: string };
      agent: AgentRuntimeProfile;
    }) => {
      const runner = new FakeRunner(options.room.roomId, options.agent);
      const key = `${options.room.roomId}:${options.agent.id}`;
      const entries = runners.get(key) ?? [];

      entries.push(runner);
      runners.set(key, entries);
      return runner;
    });
    const orchestrator = new module.Orchestrator({
      captureRuntimeError: (logger, error) => (logger.error(error), error as Error),
      closeDatabasePool: async () => undefined,
      closeRedis: async () => undefined,
      connectRedis: async () => undefined,
      createFloorController: (roomId: string) => {
        const controller = createFloorController();

        floorControllers.set(roomId, controller);
        return controller;
      },
      createRunner,
      createSilenceTimer: () => new FakeSilenceTimer(),
      logger: createLogger(),
      pingRedis: async () => undefined,
      pollIntervalMs: 60_000,
      roomRepository: {
        listActiveRooms: vi.fn(async () => currentRooms),
      },
      testDatabaseConnection: async () => ({
        databaseName: "postgres",
        serverTime: "2026-03-28 12:00:00+00",
      }),
      transcriptRepository: {
        insertTranscriptEvent: vi.fn(async () => undefined),
        listRecentByRoomId: vi.fn(async () => []),
      },
      healthPort: 0,
    });

    await orchestrator.start();

    const floorController = floorControllers.get("room-a");
    const initialHostRunner = runners.get(`room-a:${HOST_AGENT.id}`)?.[0];

    initialHostRunner?.requestTurn.mockClear();
    floorController?.setHolder(null);
    initialHostRunner?.emit("error", new Error("post-turn failure"));

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    const restartedHostRunner = runners.get(`room-a:${HOST_AGENT.id}`)?.[1];

    expect(restartedHostRunner?.start).toHaveBeenCalledTimes(1);
    expect(restartedHostRunner?.requestTurn).toHaveBeenCalledTimes(1);

    await orchestrator.stop();
  });

  /**
   * Muted agents must be filtered out before scoring, even if the host would
   * otherwise win the role-bonus tiebreak.
   */
  it("skips muted agents when selecting the next speaker", async () => {
    const module = await importOrchestratorModule();
    const currentRooms = [createRoom("room-a")];
    const runners = new Map<string, FakeRunner[]>();
    const createRunner = vi.fn((options: {
      room: { roomId: string };
      agent: AgentRuntimeProfile;
    }) => {
      const runner = new FakeRunner(options.room.roomId, options.agent);
      const key = `${options.room.roomId}:${options.agent.id}`;
      const entries = runners.get(key) ?? [];

      entries.push(runner);
      runners.set(key, entries);
      return runner;
    });
    const orchestrator = new module.Orchestrator({
      captureRuntimeError: (logger, error) => (logger.error(error), error as Error),
      closeDatabasePool: async () => undefined,
      closeRedis: async () => undefined,
      connectRedis: async () => undefined,
      createFloorController: () => createFloorController(new Set([HOST_AGENT.id])),
      createRunner,
      createSilenceTimer: () => new FakeSilenceTimer(),
      logger: createLogger(),
      pingRedis: async () => undefined,
      pollIntervalMs: 60_000,
      roomRepository: {
        listActiveRooms: vi.fn(async () => currentRooms),
      },
      testDatabaseConnection: async () => ({
        databaseName: "postgres",
        serverTime: "2026-03-28 12:00:00+00",
      }),
      transcriptRepository: {
        insertTranscriptEvent: vi.fn(async () => undefined),
        listRecentByRoomId: vi.fn(async () => []),
      },
      healthPort: 0,
    });

    await orchestrator.start();

    const hostRunner = runners.get(`room-a:${HOST_AGENT.id}`)?.[0];
    const participantRunner = runners.get(`room-a:${PARTICIPANT_AGENT.id}`)?.[0];

    expect(hostRunner?.requestTurn).not.toHaveBeenCalled();
    expect(participantRunner?.requestTurn).toHaveBeenCalledTimes(1);

    await orchestrator.stop();
  });

  /**
   * Dead-air notifications from the silence timer should be routed to the host
   * runner with a one-turn prompt override.
   */
  it("routes dead-air prompt overrides to the host runner", async () => {
    const module = await importOrchestratorModule();
    const currentRooms = [createRoom("room-a")];
    const runners = new Map<string, FakeRunner[]>();
    const silenceTimers = new Map<string, FakeSilenceTimer>();
    const createRunner = vi.fn((options: {
      room: { roomId: string };
      agent: AgentRuntimeProfile;
    }) => {
      const runner = new FakeRunner(options.room.roomId, options.agent);
      const key = `${options.room.roomId}:${options.agent.id}`;
      const entries = runners.get(key) ?? [];

      entries.push(runner);
      runners.set(key, entries);
      return runner;
    });
    const orchestrator = new module.Orchestrator({
      captureRuntimeError: (logger, error) => (logger.error(error), error as Error),
      closeDatabasePool: async () => undefined,
      closeRedis: async () => undefined,
      connectRedis: async () => undefined,
      createFloorController: () => createFloorController(),
      createRunner,
      createSilenceTimer: (_floorController, roomId) => {
        const timer = new FakeSilenceTimer();

        silenceTimers.set(roomId, timer);
        return timer;
      },
      logger: createLogger(),
      pingRedis: async () => undefined,
      pollIntervalMs: 60_000,
      roomRepository: {
        listActiveRooms: vi.fn(async () => currentRooms),
      },
      testDatabaseConnection: async () => ({
        databaseName: "postgres",
        serverTime: "2026-03-28 12:00:00+00",
      }),
      transcriptRepository: {
        insertTranscriptEvent: vi.fn(async () => undefined),
        listRecentByRoomId: vi.fn(async () => []),
      },
      healthPort: 0,
    });

    await orchestrator.start();

    const hostRunner = runners.get(`room-a:${HOST_AGENT.id}`)?.[0];

    hostRunner?.requestTurn.mockClear();
    silenceTimers.get("room-a")?.emit("deadAirDetected", {
      detectedAt: Date.parse("2026-03-28T12:00:30.000Z"),
      hostAgentId: HOST_AGENT.id,
      prompt: "The room is quiet. Restart the argument with a sharper question.",
      roomId: "room-a",
      silenceDurationMs: 5_000,
      silenceStartedAt: Date.parse("2026-03-28T12:00:25.000Z"),
    });
    await flushMicrotasks();

    expect(hostRunner?.requestTurn).toHaveBeenCalledWith({
      promptOverride: "The room is quiet. Restart the argument with a sharper question.",
    });

    await orchestrator.stop();
  });

  /**
   * If the silence timer already granted the floor to the host but the host
   * runner is down, the orchestrator must release that claim immediately.
   */
  it("releases the dead-air floor claim when the host runner is unavailable", async () => {
    const module = await importOrchestratorModule();
    const currentRooms = [createRoom("room-a")];
    const runners = new Map<string, FakeRunner[]>();
    const silenceTimers = new Map<string, FakeSilenceTimer>();
    const floorControllers = new Map<string, ReturnType<typeof createFloorController>>();
    const createRunner = vi.fn((options: {
      room: { roomId: string };
      agent: AgentRuntimeProfile;
    }) => {
      const runner = new FakeRunner(options.room.roomId, options.agent);
      const key = `${options.room.roomId}:${options.agent.id}`;
      const entries = runners.get(key) ?? [];

      entries.push(runner);
      runners.set(key, entries);
      return runner;
    });
    const orchestrator = new module.Orchestrator({
      captureRuntimeError: (logger, error) => (logger.error(error), error as Error),
      closeDatabasePool: async () => undefined,
      closeRedis: async () => undefined,
      connectRedis: async () => undefined,
      createFloorController: (roomId: string) => {
        const controller = createFloorController();

        floorControllers.set(roomId, controller);
        return controller;
      },
      createRunner,
      createSilenceTimer: (_floorController, roomId) => {
        const timer = new FakeSilenceTimer();

        silenceTimers.set(roomId, timer);
        return timer;
      },
      logger: createLogger(),
      pingRedis: async () => undefined,
      pollIntervalMs: 60_000,
      roomRepository: {
        listActiveRooms: vi.fn(async () => currentRooms),
      },
      testDatabaseConnection: async () => ({
        databaseName: "postgres",
        serverTime: "2026-03-28 12:00:00+00",
      }),
      transcriptRepository: {
        insertTranscriptEvent: vi.fn(async () => undefined),
        listRecentByRoomId: vi.fn(async () => []),
      },
      healthHost: "127.0.0.1",
      healthPort: 0,
    });

    await orchestrator.start();

    const hostRunner = runners.get(`room-a:${HOST_AGENT.id}`)?.[0];
    const floorController = floorControllers.get("room-a");

    await hostRunner?.stop();
    hostRunner?.requestTurn.mockClear();
    floorController?.setHolder(HOST_AGENT.id);
    floorController?.releaseFloor.mockClear();
    silenceTimers.get("room-a")?.emit("deadAirDetected", {
      detectedAt: Date.parse("2026-03-28T12:00:30.000Z"),
      hostAgentId: HOST_AGENT.id,
      prompt: "The room is quiet. Restart the argument with a sharper question.",
      roomId: "room-a",
      silenceDurationMs: 5_000,
      silenceStartedAt: Date.parse("2026-03-28T12:00:25.000Z"),
    });
    await flushMicrotasks();

    expect(hostRunner?.requestTurn).not.toHaveBeenCalled();
    expect(floorController?.releaseFloor).toHaveBeenCalledWith(HOST_AGENT.id);

    await orchestrator.stop();
  });

  /**
   * Detached turn-scheduling failures must be captured explicitly instead of
   * surfacing as unhandled promise rejections.
   */
  it("captures post-turn scheduling failures from detached runner callbacks", async () => {
    const module = await importOrchestratorModule();
    const currentRooms = [createRoom("room-a")];
    const runners = new Map<string, FakeRunner[]>();
    const floorControllers = new Map<string, ReturnType<typeof createFloorController>>();
    const logger = createLogger();
    const createRunner = vi.fn((options: {
      room: { roomId: string };
      agent: AgentRuntimeProfile;
    }) => {
      const runner = new FakeRunner(options.room.roomId, options.agent);
      const key = `${options.room.roomId}:${options.agent.id}`;
      const entries = runners.get(key) ?? [];

      entries.push(runner);
      runners.set(key, entries);
      return runner;
    });
    const orchestrator = new module.Orchestrator({
      closeDatabasePool: async () => undefined,
      closeRedis: async () => undefined,
      connectRedis: async () => undefined,
      createFloorController: (roomId: string) => {
        const controller = createFloorController(new Set([HOST_AGENT.id]));

        floorControllers.set(roomId, controller);
        return controller;
      },
      createRunner,
      createSilenceTimer: () => new FakeSilenceTimer(),
      logger,
      pingRedis: async () => undefined,
      pollIntervalMs: 60_000,
      roomRepository: {
        listActiveRooms: vi.fn(async () => currentRooms),
      },
      testDatabaseConnection: async () => ({
        databaseName: "postgres",
        serverTime: "2026-03-28 12:00:00+00",
      }),
      transcriptRepository: {
        insertTranscriptEvent: vi.fn(async () => undefined),
        listRecentByRoomId: vi.fn(async () => []),
      },
      healthHost: "127.0.0.1",
      healthPort: 0,
    });

    await orchestrator.start();

    const floorController = floorControllers.get("room-a");
    const participantRunner = runners.get(`room-a:${PARTICIPANT_AGENT.id}`)?.[0];

    participantRunner?.requestTurn.mockClear();
    participantRunner?.requestTurn.mockRejectedValueOnce(
      new Error("participant scheduling failed"),
    );
    floorController?.setHolder(null);
    participantRunner?.emit("turnCompleted", {
      roomId: "room-a",
      agentId: PARTICIPANT_AGENT.id,
      turnCount: 1,
      lastSpokeAt: Date.parse("2026-03-28T12:00:30.000Z"),
    });
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "turn_completed_schedule",
          roomId: "room-a",
          agentId: PARTICIPANT_AGENT.id,
          err: expect.any(Error),
        }),
        "Captured agents runtime error.",
      );
    });

    await orchestrator.stop();
  });

  /**
   * Dead-air recovery runs detached from the timer callback, so its failures
   * must also be captured explicitly.
   */
  it("captures dead-air recovery failures from detached timer callbacks", async () => {
    const module = await importOrchestratorModule();
    const currentRooms = [createRoom("room-a")];
    const runners = new Map<string, FakeRunner[]>();
    const silenceTimers = new Map<string, FakeSilenceTimer>();
    const logger = createLogger();
    const createRunner = vi.fn((options: {
      room: { roomId: string };
      agent: AgentRuntimeProfile;
    }) => {
      const runner = new FakeRunner(options.room.roomId, options.agent);
      const key = `${options.room.roomId}:${options.agent.id}`;
      const entries = runners.get(key) ?? [];

      entries.push(runner);
      runners.set(key, entries);
      return runner;
    });
    const orchestrator = new module.Orchestrator({
      closeDatabasePool: async () => undefined,
      closeRedis: async () => undefined,
      connectRedis: async () => undefined,
      createFloorController: () => createFloorController(),
      createRunner,
      createSilenceTimer: (_floorController, roomId) => {
        const timer = new FakeSilenceTimer();

        silenceTimers.set(roomId, timer);
        return timer;
      },
      logger,
      pingRedis: async () => undefined,
      pollIntervalMs: 60_000,
      roomRepository: {
        listActiveRooms: vi.fn(async () => currentRooms),
      },
      testDatabaseConnection: async () => ({
        databaseName: "postgres",
        serverTime: "2026-03-28 12:00:00+00",
      }),
      transcriptRepository: {
        insertTranscriptEvent: vi.fn(async () => undefined),
        listRecentByRoomId: vi.fn(async () => []),
      },
      healthHost: "127.0.0.1",
      healthPort: 0,
    });

    await orchestrator.start();

    const hostRunner = runners.get(`room-a:${HOST_AGENT.id}`)?.[0];

    hostRunner?.requestTurn.mockClear();
    hostRunner?.requestTurn.mockRejectedValueOnce(
      new Error("dead-air recovery failed"),
    );
    silenceTimers.get("room-a")?.emit("deadAirDetected", {
      detectedAt: Date.parse("2026-03-28T12:00:30.000Z"),
      hostAgentId: HOST_AGENT.id,
      prompt: "The room is quiet. Restart the argument with a sharper question.",
      roomId: "room-a",
      silenceDurationMs: 5_000,
      silenceStartedAt: Date.parse("2026-03-28T12:00:25.000Z"),
    });
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "dead_air_recovery",
          roomId: "room-a",
          agentId: HOST_AGENT.id,
          err: expect.any(Error),
        }),
        "Captured agents runtime error.",
      );
    });

    await orchestrator.stop();
  });

  /**
   * Shutdown must wait for any queued room-sync pass to settle so a late
   * database response cannot recreate runtimes or restart polling after stop.
   */
  it("drains an in-flight room sync before shutdown completes", async () => {
    const module = await importOrchestratorModule();

    stubHealthServerLifecycle(module);

    let resolveRooms!: (rooms: ReturnType<typeof createRoom>[]) => void;
    const listActiveRooms = vi.fn(
      async () => await new Promise<ReturnType<typeof createRoom>[]>((resolve) => {
        resolveRooms = resolve;
      }),
    );
    const createRunner = vi.fn((options: {
      room: { roomId: string };
      agent: AgentRuntimeProfile;
    }) => new FakeRunner(options.room.roomId, options.agent));
    const orchestrator = new module.Orchestrator({
      closeDatabasePool: async () => undefined,
      closeRedis: async () => undefined,
      connectRedis: async () => undefined,
      createFloorController: () => createFloorController(),
      createRunner,
      createSilenceTimer: () => new FakeSilenceTimer(),
      logger: createLogger(),
      pingRedis: async () => undefined,
      pollIntervalMs: 60_000,
      roomRepository: {
        listActiveRooms,
      },
      testDatabaseConnection: async () => ({
        databaseName: "postgres",
        serverTime: "2026-03-28 12:00:00+00",
      }),
      transcriptRepository: {
        insertTranscriptEvent: vi.fn(async () => undefined),
        listRecentByRoomId: vi.fn(async () => []),
      },
      healthPort: 0,
    });

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(listActiveRooms).toHaveBeenCalledTimes(1);
    });

    const stopPromise = orchestrator.stop();

    resolveRooms([createRoom("room-a")]);
    await Promise.allSettled([startPromise, stopPromise]);

    expect(createRunner).not.toHaveBeenCalled();
    expect(orchestrator.getActiveRoomCount()).toBe(0);
    expect(orchestrator.getActiveRunnerCount()).toBe(0);
  });

  /**
   * Restart backoff timers must route replacement-construction failures through
   * the normal error-capture path instead of surfacing as detached rejections.
   */
  it("captures runner-construction failures during delayed restart", async () => {
    vi.useFakeTimers();

    const module = await importOrchestratorModule();

    stubHealthServerLifecycle(module);

    const currentRooms = [createRoom("room-a")];
    const logger = createLogger();
    let createRunnerCalls = 0;
    const createRunner = vi.fn((options: {
      room: { roomId: string };
      agent: AgentRuntimeProfile;
    }) => {
      createRunnerCalls += 1;

      if (createRunnerCalls > 3) {
        throw new Error("replacement runner construction failed");
      }

      return new FakeRunner(options.room.roomId, options.agent);
    });
    const orchestrator = new module.Orchestrator({
      closeDatabasePool: async () => undefined,
      closeRedis: async () => undefined,
      connectRedis: async () => undefined,
      createFloorController: () => createFloorController(),
      createRunner,
      createSilenceTimer: () => new FakeSilenceTimer(),
      logger,
      pingRedis: async () => undefined,
      pollIntervalMs: 60_000,
      roomRepository: {
        listActiveRooms: vi.fn(async () => currentRooms),
      },
      testDatabaseConnection: async () => ({
        databaseName: "postgres",
        serverTime: "2026-03-28 12:00:00+00",
      }),
      transcriptRepository: {
        insertTranscriptEvent: vi.fn(async () => undefined),
        listRecentByRoomId: vi.fn(async () => []),
      },
      healthPort: 0,
    });

    await orchestrator.start();

    const initialHostRunner = (createRunner.mock.results[0]?.value ?? null) as FakeRunner | null;

    initialHostRunner?.emit("error", new Error("initial host failure"));
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    const restartedHostRunner = createRunner.mock.results[2]?.value as FakeRunner | undefined;

    restartedHostRunner?.emit("error", new Error("replacement host failure"));
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "runner_failure",
        roomId: "room-a",
        agentId: HOST_AGENT.id,
        err: expect.any(Error),
      }),
      "Captured agents runtime error.",
    );

    await orchestrator.stop();
  });

  /**
   * The health endpoint should report the live runtime counts once the service
   * has started successfully.
   */
  it("serves the health payload with active room and runner counts", async () => {
    const module = await importOrchestratorModule();
    const currentRooms = [createRoom("room-a")];
    const orchestrator = new module.Orchestrator({
      captureRuntimeError: (logger, error) => (logger.error(error), error as Error),
      closeDatabasePool: async () => undefined,
      closeRedis: async () => undefined,
      connectRedis: async () => undefined,
      createFloorController: () => createFloorController(),
      createRunner: (options: {
        room: { roomId: string };
        agent: AgentRuntimeProfile;
      }) => new FakeRunner(options.room.roomId, options.agent),
      createSilenceTimer: () => new FakeSilenceTimer(),
      logger: createLogger(),
      pingRedis: async () => undefined,
      pollIntervalMs: 60_000,
      roomRepository: {
        listActiveRooms: vi.fn(async () => currentRooms),
      },
      testDatabaseConnection: async () => ({
        databaseName: "postgres",
        serverTime: "2026-03-28 12:00:00+00",
      }),
      transcriptRepository: {
        insertTranscriptEvent: vi.fn(async () => undefined),
        listRecentByRoomId: vi.fn(async () => []),
      },
      healthPort: 0,
    });

    await orchestrator.start();

    const response = await fetch(
      `http://127.0.0.1:${orchestrator.getHealthPort()}/health`,
    );
    const payload = await response.json() as {
      status: string;
      service: string;
      timestamp: string;
      uptimeSeconds: number;
      activeRooms: number;
      activeRunners: number;
    };

    expect(response.status).toBe(200);
    expect(payload.status).toBe("ok");
    expect(payload.service).toBe("agents");
    expect(Number.isFinite(Date.parse(payload.timestamp))).toBe(true);
    expect(payload.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(payload.activeRooms).toBe(1);
    expect(payload.activeRunners).toBe(2);

    await orchestrator.stop();
  });
});

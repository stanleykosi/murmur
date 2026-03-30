/**
 * Murmur agent orchestrator process.
 *
 * The orchestrator is the long-running service that discovers active rooms,
 * starts one runner per assigned agent, coordinates turn-taking for each room,
 * exposes a health endpoint, and handles restart behavior when runners fail.
 */

import { selectNextSpeaker } from "./floor/scorer.js";
import { SilenceTimer, type DeadAirDetectedPayload } from "./floor/silence-timer.js";
import { FloorController } from "./floor/controller.js";
import { closeDatabasePool, testDatabaseConnection } from "./db/client.js";
import { closeRedis, connectRedis, pingRedis, redis } from "./lib/redis.js";
import { createLogger } from "./lib/logger.js";
import { captureRuntimeError, normalizeError } from "./lib/runtime-errors.js";
import { AgentRunner, type AgentRunnerTurnRequest } from "./agent-runner.js";
import { TranscriptBuffer } from "./runtime/transcript-buffer.js";
import { RoomRepository, type ActiveRoomRecord } from "./services/room-repository.js";
import {
  PostgresTranscriptRepository,
  type TranscriptRepository,
} from "./services/transcript-repository.js";
import type { AgentRuntimeProfile } from "./runtime/agent-profile.js";
import type { TranscriptEntry } from "@murmur/shared";
import http from "node:http";
import { fileURLToPath } from "node:url";

const HEALTH_HOST = "0.0.0.0";
const HEALTH_PORT = 3001;
const ROOM_POLL_INTERVAL_MS = 5_000;
const RUNNER_RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

/**
 * Resolves the health-server port from Railway's injected `PORT` value when
 * present, otherwise falls back to the local default used during development.
 *
 * @returns The validated TCP port for the HTTP health server.
 * @throws {Error} When `PORT` is present but not a valid TCP port number.
 */
function resolveDefaultHealthPort(): number {
  const rawPort = process.env.PORT?.trim();

  if (!rawPort) {
    return HEALTH_PORT;
  }

  const parsedPort = Number(rawPort);

  if (
    !Number.isInteger(parsedPort)
    || parsedPort < 1
    || parsedPort > 65_535
  ) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  return parsedPort;
}

/**
 * Minimal runner surface required by the orchestrator.
 */
export interface AgentRunnerLike {
  getAgentProfile(): AgentRuntimeProfile;
  isReady(): boolean;
  isExecutingTurn(): boolean;
  prepareTurn(request?: {
    promptOverride?: string | null;
    transcriptSnapshot?: {
      id: string;
      roomId: string;
      agentId: string;
      agentName: string;
      content: string;
      timestamp: string;
      accentColor: string;
      wasFiltered: boolean;
    }[];
  }): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  requestTurn(request?: AgentRunnerTurnRequest): Promise<void>;
  on(
    eventName: "turnReadyForPlayback",
    listener: (payload: {
      roomId: string;
      agentId: string;
      content: string;
      timestamp: string;
      wasFiltered: boolean;
    }) => void,
  ): this;
  on(eventName: "ready", listener: (payload: { roomId: string; agentId: string }) => void): this;
  on(
    eventName: "turnCompleted",
    listener: (payload: { roomId: string; agentId: string; turnCount: number; lastSpokeAt: number }) => void,
  ): this;
  on(
    eventName: "turnDeadlineMissed",
    listener: (payload: { roomId: string; agentId: string; deadlineMs: number }) => void,
  ): this;
  on(eventName: "error", listener: (error: Error) => void): this;
  on(eventName: "stopped", listener: (payload: { roomId: string; agentId: string }) => void): this;
  off(
    eventName: "turnReadyForPlayback",
    listener: (payload: {
      roomId: string;
      agentId: string;
      content: string;
      timestamp: string;
      wasFiltered: boolean;
    }) => void,
  ): this;
  off(eventName: "ready", listener: (payload: { roomId: string; agentId: string }) => void): this;
  off(
    eventName: "turnCompleted",
    listener: (payload: { roomId: string; agentId: string; turnCount: number; lastSpokeAt: number }) => void,
  ): this;
  off(
    eventName: "turnDeadlineMissed",
    listener: (payload: { roomId: string; agentId: string; deadlineMs: number }) => void,
  ): this;
  off(eventName: "error", listener: (error: Error) => void): this;
  off(eventName: "stopped", listener: (payload: { roomId: string; agentId: string }) => void): this;
}

/**
 * Minimal silence-timer surface required by the orchestrator.
 */
export interface RoomSilenceTimerLike {
  start(): void;
  stop(): void;
  on(eventName: "deadAirDetected", listener: (payload: DeadAirDetectedPayload) => void): this;
  on(eventName: "error", listener: (error: Error) => void): this;
  off(eventName: "deadAirDetected", listener: (payload: DeadAirDetectedPayload) => void): this;
  off(eventName: "error", listener: (error: Error) => void): this;
}

/**
 * Minimal floor-controller surface required by the orchestrator.
 */
export interface OrchestratorFloorController {
  clearSilenceStart(): Promise<void>;
  claimFloor(agentId: string): Promise<boolean>;
  getAgentLastSpoke(agentId: string): Promise<number | null>;
  getCurrentHolder(): Promise<string | null>;
  isAgentMuted(agentId: string): Promise<boolean>;
  releaseFloor(agentId: string): Promise<boolean>;
  setAgentLastSpoke(agentId: string, timestamp: number): Promise<void>;
}

/**
 * Minimal room-repository surface required by the orchestrator.
 */
export interface RoomRepositoryLike {
  listActiveRooms(): Promise<ActiveRoomRecord[]>;
}

/**
 * Optional dependency-injection hooks for testing the orchestrator.
 */
export interface OrchestratorDependencies {
  captureRuntimeError?: typeof captureRuntimeError;
  connectRedis?: typeof connectRedis;
  pingRedis?: typeof pingRedis;
  testDatabaseConnection?: typeof testDatabaseConnection;
  closeDatabasePool?: typeof closeDatabasePool;
  closeRedis?: typeof closeRedis;
  roomRepository?: RoomRepositoryLike;
  transcriptRepository?: TranscriptRepository;
  createFloorController?: (roomId: string) => OrchestratorFloorController;
  createSilenceTimer?: (
    floorController: OrchestratorFloorController,
    roomId: string,
    hostAgentId: string,
  ) => RoomSilenceTimerLike;
  createRunner?: (options: ConstructorParameters<typeof AgentRunner>[0]) => AgentRunnerLike;
  logger?: ReturnType<typeof createLogger>;
  now?: () => Date;
  healthHost?: string;
  healthPort?: number;
  pollIntervalMs?: number;
}

interface RunnerEventHandlers {
  handleTurnReadyForPlayback: (payload: {
    roomId: string;
    agentId: string;
    content: string;
    timestamp: string;
    wasFiltered: boolean;
  }) => void;
  handleReady: (payload: { roomId: string; agentId: string }) => void;
  handleTurnCompleted: (payload: { roomId: string; agentId: string; turnCount: number; lastSpokeAt: number }) => void;
  handleTurnDeadlineMissed: (payload: { roomId: string; agentId: string; deadlineMs: number }) => void;
  handleError: (error: Error) => void;
  handleStopped: (payload: { roomId: string; agentId: string }) => void;
}

interface RoomRuntime {
  room: ActiveRoomRecord;
  floorController: OrchestratorFloorController;
  silenceTimer: RoomSilenceTimerLike;
  silenceTimerHandlers: {
    handleDeadAir: (payload: DeadAirDetectedPayload) => void;
    handleError: (error: Error) => void;
  };
  transcriptBuffer: TranscriptBuffer;
  runners: Map<string, AgentRunnerLike>;
  runnerHandlers: Map<string, RunnerEventHandlers>;
  schedulerQueue: Promise<void>;
  restartAttempts: Map<string, number>;
  restartTimers: Map<string, NodeJS.Timeout>;
  directedNextSpeakerId: string | null;
}

interface DetachedTaskContext {
  stage: string;
  roomId?: string;
  agentId?: string;
  [key: string]: unknown;
}

/**
 * Builds the projected transcript entry used for speculative next-turn preparation.
 *
 * @param runtime - Room runtime whose agent roster supplies display metadata.
 * @param agentId - Speaker whose imminent turn should be projected.
 * @param payload - Final moderated turn text and projected timestamp.
 * @returns A transcript entry that mirrors the soon-to-be-published turn.
 */
function createProjectedTranscriptEntry(
  runtime: RoomRuntime,
  agentId: string,
  payload: {
    content: string;
    timestamp: string;
    wasFiltered: boolean;
  },
): TranscriptEntry {
  const agent = runtime.room.agents.find((candidate) => candidate.id === agentId);

  if (!agent) {
    throw new Error(
      `Cannot project transcript entry for unknown room agent "${agentId}".`,
    );
  }

  return {
    id: `projected:${agentId}:${payload.timestamp}`,
    roomId: runtime.room.id,
    agentId,
    agentName: agent.name,
    content: payload.content,
    timestamp: payload.timestamp,
    accentColor: agent.accentColor,
    wasFiltered: payload.wasFiltered,
  };
}

/**
 * Escapes a speaker name for safe inclusion inside a regular expression.
 *
 * @param value - Agent display name.
 * @returns The escaped literal pattern.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Attempts to extract a host-directed handoff target from the just-finished
 * host utterance. This only returns a target when the host clearly calls on
 * exactly one named peer; otherwise scheduling falls back to the canonical
 * fairness scorer.
 *
 * @param runtime - Room runtime whose roster defines valid peer names.
 * @param currentSpeakerId - Agent that produced the current speaking turn.
 * @param content - Final moderated turn text.
 * @returns The explicitly called-on agent id, or `null`.
 */
function extractDirectedNextSpeakerId(
  runtime: RoomRuntime,
  currentSpeakerId: string,
  content: string,
): string | null {
  const currentSpeaker = runtime.room.agents.find(
    (candidate) => candidate.id === currentSpeakerId,
  );

  if (!currentSpeaker || currentSpeaker.role !== "host") {
    return null;
  }

  const normalizedContent = content.trim();

  if (normalizedContent.length === 0) {
    return null;
  }

  const candidateMatches = runtime.room.agents
    .filter((agent) => agent.id !== currentSpeakerId)
    .map((agent) => {
      const escapedName = escapeRegExp(agent.name.trim());
      const directAddressPattern = new RegExp(
        `(?:^|[.!?]\\s+|\\n)\\s*${escapedName}\\s*[,?:-]`,
        "i",
      );
      const addressedQuestionPattern = new RegExp(
        `(?:what do you think|where do you land|how do you see it|take that|respond to that|weigh in|jump in|come in here)\\s*,?\\s*${escapedName}\\b`,
        "i",
      );
      const invitationPattern = new RegExp(
        `${escapedName}\\s*,?\\s*(?:what do you think|where do you land|how do you see it|push back|pressure-test that|respond|jump in|weigh in|take that|go ahead)`,
        "i",
      );

      return {
        agentId: agent.id,
        matched:
          directAddressPattern.test(normalizedContent)
          || addressedQuestionPattern.test(normalizedContent)
          || invitationPattern.test(normalizedContent),
      };
    })
    .filter((candidate) => candidate.matched);

  if (candidateMatches.length !== 1) {
    return null;
  }

  return candidateMatches[0]?.agentId ?? null;
}

/**
 * Long-running orchestrator for all active Murmur rooms.
 */
export class Orchestrator {
  private readonly captureRuntimeErrorImpl: typeof captureRuntimeError;

  private readonly closeDatabasePoolImpl: typeof closeDatabasePool;

  private readonly closeRedisImpl: typeof closeRedis;

  private readonly connectRedisImpl: typeof connectRedis;

  private readonly createFloorController: NonNullable<OrchestratorDependencies["createFloorController"]>;

  private readonly createRunner: NonNullable<OrchestratorDependencies["createRunner"]>;

  private readonly createSilenceTimer: NonNullable<OrchestratorDependencies["createSilenceTimer"]>;

  private readonly healthHost: string;

  private readonly healthPort: number;

  private readonly logger: ReturnType<typeof createLogger>;

  private readonly now: () => Date;

  private readonly pingRedisImpl: typeof pingRedis;

  private readonly pollIntervalMs: number;

  private readonly roomRepository: RoomRepositoryLike;

  private readonly testDatabaseConnectionImpl: typeof testDatabaseConnection;

  private readonly transcriptRepository: TranscriptRepository;

  private healthServer: http.Server | null = null;

  private healthServerPort: number | null = null;

  private pollHandle: NodeJS.Timeout | null = null;

  private roomRuntimes = new Map<string, RoomRuntime>();

  private started = false;

  private stopping = false;

  private syncQueue: Promise<void> = Promise.resolve();

  /**
   * Creates the orchestrator with real or injected dependencies.
   *
   * @param dependencies - Optional dependency overrides for tests.
   */
  public constructor(
    private readonly dependencies: OrchestratorDependencies = {},
  ) {
    this.captureRuntimeErrorImpl =
      dependencies.captureRuntimeError ?? captureRuntimeError;
    this.connectRedisImpl = dependencies.connectRedis ?? connectRedis;
    this.pingRedisImpl = dependencies.pingRedis ?? pingRedis;
    this.testDatabaseConnectionImpl =
      dependencies.testDatabaseConnection ?? testDatabaseConnection;
    this.closeDatabasePoolImpl =
      dependencies.closeDatabasePool ?? closeDatabasePool;
    this.closeRedisImpl = dependencies.closeRedis ?? closeRedis;
    this.roomRepository = dependencies.roomRepository ?? new RoomRepository();
    this.transcriptRepository =
      dependencies.transcriptRepository ?? new PostgresTranscriptRepository();
    this.createFloorController =
      dependencies.createFloorController
      ?? ((roomId) => new FloorController(redis, roomId));
    this.createSilenceTimer =
      dependencies.createSilenceTimer
      ?? ((floorController, roomId, hostAgentId) =>
        new SilenceTimer(
          floorController as FloorController,
          roomId,
          hostAgentId,
          {
            logger: createLogger({
              component: "silence-timer",
              roomId,
            }),
          },
        ));
    this.createRunner =
      dependencies.createRunner
      ?? ((options) => new AgentRunner(options));
    this.logger = dependencies.logger ?? createLogger({ component: "orchestrator" });
    this.now = dependencies.now ?? (() => new Date());
    this.healthHost = dependencies.healthHost ?? HEALTH_HOST;
    this.healthPort = dependencies.healthPort ?? resolveDefaultHealthPort();
    this.pollIntervalMs = dependencies.pollIntervalMs ?? ROOM_POLL_INTERVAL_MS;
  }

  /**
   * Starts the orchestrator process, health server, and room polling loop.
   */
  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    this.stopping = false;

    try {
      await this.connectRedisImpl();
      await this.pingRedisImpl();
      await this.testDatabaseConnectionImpl();
      await this.startHealthServer();
      await this.syncRooms();

      if (this.stopping) {
        return;
      }

      this.startPolling();

      this.logger.info(
        {
          healthHost: this.healthHost,
          healthPort: this.healthServerPort,
          pollIntervalMs: this.pollIntervalMs,
        },
        "Murmur orchestrator started.",
      );
    } catch (error) {
      const normalizedError = this.captureRuntimeErrorImpl(
        this.logger,
        error,
        {
          stage: "orchestrator_start",
        },
      );

      await this.stop().catch(() => undefined);
      throw normalizedError;
    }
  }

  /**
   * Stops polling, health serving, room runtimes, and shared dependencies.
   */
  public async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }

    this.stopping = true;

    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }

    await this.syncQueue.catch(() => undefined);

    await Promise.all(
      Array.from(this.roomRuntimes.keys()).map(async (roomId) => {
        await this.stopRoomRuntime(roomId);
      }),
    );

    await this.closeHealthServer();
    await Promise.allSettled([
      this.closeDatabasePoolImpl(),
      this.closeRedisImpl(),
    ]);

    this.started = false;
  }

  /**
   * Returns the health port currently bound by the HTTP server.
   */
  public getHealthPort(): number | null {
    return this.healthServerPort;
  }

  /**
   * Returns the current number of active room runtimes.
   */
  public getActiveRoomCount(): number {
    return this.roomRuntimes.size;
  }

  /**
   * Returns the total number of active runner instances across all rooms.
   */
  public getActiveRunnerCount(): number {
    return Array.from(this.roomRuntimes.values())
      .reduce((count, runtime) => count + runtime.runners.size, 0);
  }

  /**
   * Queues one room-synchronization pass.
   */
  public async syncRooms(): Promise<void> {
    if (this.stopping) {
      return;
    }

    this.syncQueue = this.syncQueue
      .catch(() => undefined)
      .then(async () => {
        if (this.stopping) {
          return;
        }

        const activeRooms = await this.roomRepository.listActiveRooms();

        if (this.stopping) {
          return;
        }

        const desiredRooms = new Map(
          activeRooms.map((room) => [room.id, room]),
        );

        for (const roomId of this.roomRuntimes.keys()) {
          if (this.stopping) {
            return;
          }

          if (!desiredRooms.has(roomId)) {
            await this.stopRoomRuntime(roomId);
          }
        }

        for (const room of activeRooms) {
          if (this.stopping) {
            return;
          }

          const existingRuntime = this.roomRuntimes.get(room.id);

          if (!existingRuntime) {
            await this.startRoomRuntime(room);
            continue;
          }

          if (existingRuntime.room.fingerprint !== room.fingerprint) {
            await this.restartRoomRuntime(room);
          }
        }
      });

    return await this.syncQueue;
  }

  /**
   * Starts the poll interval that keeps the room-runtime set in sync with PostgreSQL.
   */
  private startPolling(): void {
    if (this.pollHandle) {
      return;
    }

    this.pollHandle = setInterval(() => {
      void this.syncRooms().catch((error) => {
        this.captureRuntimeErrorImpl(this.logger, error, {
          stage: "room_poll",
        });
      });
    }, this.pollIntervalMs);
  }

  /**
   * Starts one room runtime and immediately schedules the first speaker.
   *
   * @param room - Active room definition loaded from PostgreSQL.
   */
  private async startRoomRuntime(room: ActiveRoomRecord): Promise<void> {
    const transcriptBuffer = new TranscriptBuffer(room.id, {
      now: () => this.now().getTime(),
    });
    transcriptBuffer.seed(
      await this.transcriptRepository.listRecentByRoomId(room.id),
    );

    const floorController = this.createFloorController(room.id);
    const silenceTimer = this.createSilenceTimer(
      floorController,
      room.id,
      room.hostAgentId,
    );
    const roomRuntime: RoomRuntime = {
      room,
      floorController,
      silenceTimer,
      silenceTimerHandlers: {
        handleDeadAir: () => undefined,
        handleError: () => undefined,
      },
      transcriptBuffer,
      runners: new Map(),
      runnerHandlers: new Map(),
      schedulerQueue: Promise.resolve(),
      restartAttempts: new Map(),
      restartTimers: new Map(),
      directedNextSpeakerId: null,
    };

    const handleDeadAir = (payload: DeadAirDetectedPayload) => {
      this.runDetachedTask(
        this.handleDeadAir(
          room.id,
          floorController,
          payload,
        ),
        {
          stage: "dead_air_recovery",
          roomId: room.id,
          agentId: payload.hostAgentId,
        },
      );
    };
    const handleSilenceError = (error: Error) => {
      this.captureRuntimeErrorImpl(this.logger, error, {
        stage: "silence_timer",
        roomId: room.id,
      });
    };

    silenceTimer.on("deadAirDetected", handleDeadAir);
    silenceTimer.on("error", handleSilenceError);
    roomRuntime.silenceTimerHandlers = {
      handleDeadAir,
      handleError: handleSilenceError,
    };

    try {
      for (const agent of room.agents) {
        const runner = this.createRunner({
          room: {
            roomId: room.id,
            title: room.title,
            topic: room.topic,
            format: room.format,
            agents: room.agents,
          },
          agent,
          floorController,
          transcriptBuffer,
          transcriptRepository: this.transcriptRepository,
        });
        const handlers = this.createRunnerHandlers(room.id, agent.id);

        runner.on("ready", handlers.handleReady);
        runner.on("turnReadyForPlayback", handlers.handleTurnReadyForPlayback);
        runner.on("turnCompleted", handlers.handleTurnCompleted);
        runner.on("turnDeadlineMissed", handlers.handleTurnDeadlineMissed);
        runner.on("error", handlers.handleError);
        runner.on("stopped", handlers.handleStopped);
        roomRuntime.runners.set(agent.id, runner);
        roomRuntime.runnerHandlers.set(agent.id, handlers);
      }

      for (const runner of roomRuntime.runners.values()) {
        await runner.start();
      }

      await this.reconcileBootstrapRoomState(room.id, floorController);
      this.roomRuntimes.set(room.id, roomRuntime);
      roomRuntime.silenceTimer.start();
      this.runDetachedTask(
        this.scheduleNextSpeaker(room.id, "room_bootstrap"),
        {
          stage: "room_bootstrap_schedule",
          roomId: room.id,
        },
      );
    } catch (error) {
      this.roomRuntimes.delete(room.id);
      await this.disposeRoomRuntime(roomRuntime);
      throw this.captureRuntimeErrorImpl(this.logger, error, {
        stage: "room_start",
        roomId: room.id,
      });
    }
  }

  /**
   * Restarts an existing room runtime with the latest room fingerprint.
   *
   * @param room - Updated room definition loaded from PostgreSQL.
   */
  private async restartRoomRuntime(room: ActiveRoomRecord): Promise<void> {
    await this.stopRoomRuntime(room.id);
    await this.startRoomRuntime(room);
  }

  /**
   * Stops and removes one room runtime.
   *
   * @param roomId - Room identifier whose runtime should be stopped.
   */
  private async stopRoomRuntime(roomId: string): Promise<void> {
    const runtime = this.roomRuntimes.get(roomId);

    if (!runtime) {
      return;
    }

    this.roomRuntimes.delete(roomId);
    await this.disposeRoomRuntime(runtime);
  }

  /**
   * Disposes all resources owned by one room runtime.
   *
   * @param runtime - Room runtime to dispose.
   */
  private async disposeRoomRuntime(runtime: RoomRuntime): Promise<void> {
    runtime.silenceTimer.stop();
    runtime.silenceTimer.off(
      "deadAirDetected",
      runtime.silenceTimerHandlers.handleDeadAir,
    );
    runtime.silenceTimer.off(
      "error",
      runtime.silenceTimerHandlers.handleError,
    );

    for (const timeout of runtime.restartTimers.values()) {
      clearTimeout(timeout);
    }

    runtime.restartTimers.clear();

    await Promise.allSettled(
      Array.from(runtime.runners.entries()).map(async ([agentId, runner]) => {
        const handlers = runtime.runnerHandlers.get(agentId);

        try {
          await runner.stop();
        } finally {
          if (handlers) {
            this.detachRunnerHandlers(runner, handlers);
          }
        }
      }),
    );
  }

  /**
   * Clears persisted bootstrap state left behind by a previous runtime.
   *
   * @param roomId - Room identifier currently being bootstrapped.
   * @param floorController - Room-scoped floor controller used for cleanup.
   */
  private async reconcileBootstrapRoomState(
    roomId: string,
    floorController: OrchestratorFloorController,
  ): Promise<void> {
    await floorController.clearSilenceStart();

    const currentHolder = await floorController.getCurrentHolder();

    if (currentHolder === null) {
      return;
    }

    const released = await floorController.releaseFloor(currentHolder);

    if (released) {
      this.logger.warn(
        {
          roomId,
          agentId: currentHolder,
        },
        "Released a persisted floor claim while bootstrapping the room runtime.",
      );
      return;
    }

    this.logger.warn(
      {
        roomId,
        agentId: currentHolder,
      },
      "Detected a persisted floor claim during room bootstrap, but it changed before cleanup completed.",
    );
  }

  /**
   * Removes the stable event handlers attached to one runner.
   *
   * @param runner - Runner instance whose handlers should be detached.
   * @param handlers - Stable handlers previously attached to the runner.
   */
  private detachRunnerHandlers(
    runner: AgentRunnerLike,
    handlers: RunnerEventHandlers,
  ): void {
    runner.off("ready", handlers.handleReady);
    runner.off("turnReadyForPlayback", handlers.handleTurnReadyForPlayback);
    runner.off("turnCompleted", handlers.handleTurnCompleted);
    runner.off("turnDeadlineMissed", handlers.handleTurnDeadlineMissed);
    runner.off("error", handlers.handleError);
    runner.off("stopped", handlers.handleStopped);
  }

  /**
   * Creates runner-event handlers scoped to one room and one agent.
   *
   * @param roomId - Room identifier.
   * @param agentId - Agent identifier.
   * @returns Stable handler functions suitable for later removal.
   */
  private createRunnerHandlers(roomId: string, agentId: string): RunnerEventHandlers {
    return {
      handleTurnReadyForPlayback: (payload) => {
        this.runDetachedTask(
          this.prepareLikelyNextSpeaker(roomId, agentId, payload),
          {
            stage: "speculative_turn_preparation",
            roomId,
            agentId,
          },
        );
      },
      handleReady: () => {
        this.logger.debug({ roomId, agentId }, "Runner reported ready.");
      },
      handleTurnCompleted: () => {
        this.roomRuntimes.get(roomId)?.restartAttempts.set(agentId, 0);
        this.runDetachedTask(
          this.scheduleNextSpeaker(roomId, "turn_completed"),
          {
            stage: "turn_completed_schedule",
            roomId,
            agentId,
          },
        );
      },
      handleTurnDeadlineMissed: ({ deadlineMs }) => {
        this.roomRuntimes.get(roomId)?.restartAttempts.set(agentId, 0);
        this.logger.warn(
          {
            roomId,
            agentId,
            deadlineMs,
          },
          "Runner turn missed the execution deadline; scheduling the next speaker.",
        );
        this.runDetachedTask(
          this.scheduleNextSpeaker(roomId, "turn_deadline_missed"),
          {
            stage: "turn_deadline_missed_schedule",
            roomId,
            agentId,
          },
        );
      },
      handleError: (error) => {
        this.runDetachedTask(
          this.handleRunnerFailure(roomId, agentId, error),
          {
            stage: "runner_failure_handler",
            roomId,
            agentId,
          },
        );
      },
      handleStopped: () => {
        this.logger.debug({ roomId, agentId }, "Runner reported stopped.");
      },
    };
  }

  /**
   * Serializes one room-local scheduling operation.
   *
   * @param roomId - Room identifier whose scheduler should be used.
   * @param task - Async scheduler task to execute serially.
   */
  private async enqueueRoomSchedule(
    roomId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const runtime = this.roomRuntimes.get(roomId);

    if (!runtime) {
      return;
    }

    runtime.schedulerQueue = runtime.schedulerQueue
      .catch(() => undefined)
      .then(task);

    await runtime.schedulerQueue;
  }

  /**
   * Runs detached async work with explicit error capture so lifecycle callbacks
   * never surface as unhandled promise rejections.
   *
   * @param task - Detached async task to observe.
   * @param context - Structured error-capture context.
   */
  private runDetachedTask(
    task: Promise<void>,
    context: DetachedTaskContext,
  ): void {
    void task.catch((error) => {
      this.captureRuntimeErrorImpl(this.logger, error, context);
    });
  }

  /**
   * Chooses and triggers the next speaker for one room.
   *
   * @param roomId - Room identifier to schedule.
   * @param reason - Structured reason logged for diagnostics.
   */
  private async scheduleNextSpeaker(roomId: string, reason: string): Promise<void> {
    if (this.stopping) {
      return;
    }

    await this.enqueueRoomSchedule(roomId, async () => {
      if (this.stopping) {
        return;
      }

      const runtime = this.roomRuntimes.get(roomId);

      if (!runtime) {
        return;
      }

      if ([...runtime.runners.values()].some((runner) => runner.isExecutingTurn())) {
        return;
      }

      const currentHolder = await runtime.floorController.getCurrentHolder();

      if (currentHolder !== null) {
        return;
      }

      const directedNextSpeakerId = runtime.directedNextSpeakerId;

      if (directedNextSpeakerId) {
        const directedRunner = runtime.runners.get(directedNextSpeakerId);

        if (
          directedRunner
          && directedRunner.isReady()
          && !directedRunner.isExecutingTurn()
          && !await runtime.floorController.isAgentMuted(directedNextSpeakerId)
        ) {
          const claimed = await runtime.floorController.claimFloor(
            directedNextSpeakerId,
          );

          if (claimed) {
            runtime.directedNextSpeakerId = null;

            this.logger.info(
              {
                roomId,
                agentId: directedNextSpeakerId,
                reason,
              },
              "Scheduled next speaker from an explicit host-directed handoff.",
            );

            try {
              await directedRunner.requestTurn();
            } catch (error) {
              await runtime.floorController.releaseFloor(
                directedNextSpeakerId,
              ).catch(() => undefined);
              throw error;
            }

            return;
          }
        }

        runtime.directedNextSpeakerId = null;
      }

      const candidates = await Promise.all(
        runtime.room.agents.map(async (agent) => {
          const runner = runtime.runners.get(agent.id);

          if (!runner || !runner.isReady()) {
            return null;
          }

          if (await runtime.floorController.isAgentMuted(agent.id)) {
            return null;
          }

          return {
            id: agent.id,
            role: agent.role,
            lastSpokeAt: await runtime.floorController.getAgentLastSpoke(agent.id),
          };
        }),
      );
      const nextSpeaker = selectNextSpeaker(
        candidates.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null),
        {
          now: () => this.now().getTime(),
        },
      );

      if (!nextSpeaker) {
        return;
      }

      const claimed = await runtime.floorController.claimFloor(nextSpeaker.id);

      if (!claimed) {
        return;
      }

      const runner = runtime.runners.get(nextSpeaker.id);

      if (!runner || !runner.isReady()) {
        await runtime.floorController.releaseFloor(nextSpeaker.id);
        return;
      }

      this.logger.info(
        {
          roomId,
          agentId: nextSpeaker.id,
          reason,
        },
        "Scheduled next speaker.",
      );

      try {
        await runner.requestTurn();
      } catch (error) {
        await runtime.floorController.releaseFloor(nextSpeaker.id).catch(() => undefined);
        throw error;
      }
    });
  }

  /**
   * Prepares the most likely next speaker while the current turn is still
   * synthesizing or playing, so handoff can start with a warm response.
   *
   * @param roomId - Room identifier whose next speaker should be prepared.
   * @param currentSpeakerId - Agent currently entering playback.
   * @param payload - Final moderated text for the current speaking turn.
   */
  private async prepareLikelyNextSpeaker(
    roomId: string,
    currentSpeakerId: string,
    payload: {
      roomId: string;
      agentId: string;
      content: string;
      timestamp: string;
      wasFiltered: boolean;
    },
  ): Promise<void> {
    if (this.stopping) {
      return;
    }

    const runtime = this.roomRuntimes.get(roomId);

    if (!runtime) {
      return;
    }

    runtime.directedNextSpeakerId = extractDirectedNextSpeakerId(
      runtime,
      currentSpeakerId,
      payload.content,
    );

    const projectedTranscript = [
      ...runtime.transcriptBuffer.getSnapshot(),
      createProjectedTranscriptEntry(runtime, currentSpeakerId, payload),
    ];
    const directedNextSpeakerId = runtime.directedNextSpeakerId;

    if (directedNextSpeakerId) {
      const directedRunner = runtime.runners.get(directedNextSpeakerId);

      if (
        directedRunner
        && directedRunner.isReady()
        && !directedRunner.isExecutingTurn()
        && !await runtime.floorController.isAgentMuted(directedNextSpeakerId)
      ) {
        await directedRunner.prepareTurn({
          transcriptSnapshot: projectedTranscript,
        });
        return;
      }

      runtime.directedNextSpeakerId = null;
    }

    const candidates = await Promise.all(
      runtime.room.agents.map(async (agent) => {
        if (agent.id === currentSpeakerId) {
          return null;
        }

        const runner = runtime.runners.get(agent.id);

        if (!runner || !runner.isReady() || runner.isExecutingTurn()) {
          return null;
        }

        if (await runtime.floorController.isAgentMuted(agent.id)) {
          return null;
        }

        return {
          id: agent.id,
          role: agent.role,
          lastSpokeAt: await runtime.floorController.getAgentLastSpoke(agent.id),
        };
      }),
    );
    const nextSpeaker = selectNextSpeaker(
      candidates.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null),
      {
        now: () => Date.parse(payload.timestamp),
      },
    );

    if (!nextSpeaker) {
      return;
    }

    const runner = runtime.runners.get(nextSpeaker.id);

    if (!runner || !runner.isReady() || runner.isExecutingTurn()) {
      return;
    }

    await runner.prepareTurn({
      transcriptSnapshot: projectedTranscript,
    });
  }

  /**
   * Handles runner failure with floor cleanup and capped backoff restart.
   *
   * @param roomId - Room identifier whose runner failed.
   * @param agentId - Agent identifier whose runner failed.
   * @param error - Normalized runner failure.
   */
  private async handleRunnerFailure(
    roomId: string,
    agentId: string,
    error: Error,
  ): Promise<void> {
    if (this.stopping) {
      return;
    }

    const runtime = this.roomRuntimes.get(roomId);

    if (!runtime) {
      return;
    }

    this.captureRuntimeErrorImpl(this.logger, error, {
      stage: "runner_failure",
      roomId,
      agentId,
    });

    await runtime.floorController.releaseFloor(agentId).catch(() => undefined);

    if (runtime.restartTimers.has(agentId)) {
      return;
    }

    const attempt = runtime.restartAttempts.get(agentId) ?? 0;
    const delayMs =
      RUNNER_RESTART_BACKOFF_MS[Math.min(attempt, RUNNER_RESTART_BACKOFF_MS.length - 1)];
    const restartTimer = setTimeout(() => {
      runtime.restartTimers.delete(agentId);

      if (this.stopping) {
        return;
      }

      this.runDetachedTask(
        this.restartRunner(roomId, agentId),
        {
          stage: "runner_restart",
          roomId,
          agentId,
          attempt: attempt + 1,
        },
      );
    }, delayMs);

    runtime.restartTimers.set(agentId, restartTimer);
    runtime.restartAttempts.set(agentId, attempt + 1);
  }

  /**
   * Restarts one failed runner within an existing room runtime.
   *
   * @param roomId - Room identifier whose runner should be restarted.
   * @param agentId - Agent identifier whose runner should be restarted.
   */
  private async restartRunner(roomId: string, agentId: string): Promise<void> {
    if (this.stopping) {
      return;
    }

    const runtime = this.roomRuntimes.get(roomId);

    if (!runtime) {
      return;
    }

    const agent = runtime.room.agents.find((candidate) => candidate.id === agentId);

    if (!agent) {
      return;
    }

    const previousRunner = runtime.runners.get(agentId);
    const previousHandlers = runtime.runnerHandlers.get(agentId);

    if (previousRunner && previousHandlers) {
      try {
        await previousRunner.stop();
      } catch {
        // Best-effort runner teardown should not block replacement startup.
      } finally {
        this.detachRunnerHandlers(previousRunner, previousHandlers);
      }
    }

    try {
      const runner = this.createRunner({
        room: {
          roomId: runtime.room.id,
          title: runtime.room.title,
          topic: runtime.room.topic,
          format: runtime.room.format,
          agents: runtime.room.agents,
        },
        agent,
        floorController: runtime.floorController,
        transcriptBuffer: runtime.transcriptBuffer,
        transcriptRepository: this.transcriptRepository,
      });
      const handlers = this.createRunnerHandlers(roomId, agentId);

      runner.on("ready", handlers.handleReady);
      runner.on("turnReadyForPlayback", handlers.handleTurnReadyForPlayback);
      runner.on("turnCompleted", handlers.handleTurnCompleted);
      runner.on("turnDeadlineMissed", handlers.handleTurnDeadlineMissed);
      runner.on("error", handlers.handleError);
      runner.on("stopped", handlers.handleStopped);
      runtime.runners.set(agentId, runner);
      runtime.runnerHandlers.set(agentId, handlers);

      if (this.stopping) {
        await runner.stop().catch(() => undefined);
        this.detachRunnerHandlers(runner, handlers);
        return;
      }

      await runner.start();
      await this.scheduleNextSpeaker(roomId, "runner_restart");
    } catch (error) {
      await this.handleRunnerFailure(roomId, agentId, normalizeError(error));
    }
  }

  /**
   * Handles a successful dead-air detection by asking the host runner to speak.
   *
   * @param roomId - Room identifier that went quiet.
   * @param payload - Dead-air recovery payload emitted by the silence timer.
   */
  private async handleDeadAir(
    roomId: string,
    floorController: OrchestratorFloorController,
    payload: DeadAirDetectedPayload,
  ): Promise<void> {
    if (this.stopping) {
      await floorController.releaseFloor(payload.hostAgentId).catch(() => undefined);
      return;
    }

    const runtime = this.roomRuntimes.get(roomId);

    if (!runtime) {
      await floorController.releaseFloor(payload.hostAgentId).catch(() => undefined);
      return;
    }

    const hostRunner = runtime.runners.get(payload.hostAgentId);

    if ([...runtime.runners.values()].some((runner) => runner.isExecutingTurn())) {
      await floorController.releaseFloor(payload.hostAgentId).catch(() => undefined);
      return;
    }

    if (!hostRunner || !hostRunner.isReady()) {
      await floorController.releaseFloor(payload.hostAgentId).catch(() => undefined);
      return;
    }

    try {
      await hostRunner.requestTurn({
        promptOverride: payload.prompt,
      });
    } catch (error) {
      await floorController.releaseFloor(payload.hostAgentId).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Starts the HTTP health server.
   */
  private async startHealthServer(): Promise<void> {
    if (this.healthServer) {
      return;
    }

    this.healthServer = http.createServer((request, response) => {
      if (request.url !== "/health") {
        response.statusCode = 404;
        response.end("Not Found");
        return;
      }

      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        status: "ok",
        service: "agents",
        timestamp: this.now().toISOString(),
        uptimeSeconds: Number(process.uptime().toFixed(3)),
        activeRooms: this.getActiveRoomCount(),
        activeRunners: this.getActiveRunnerCount(),
      }));
    });

    await new Promise<void>((resolve, reject) => {
      this.healthServer!.once("error", reject);
      this.healthServer!.listen(this.healthPort, this.healthHost, () => {
        this.healthServer!.off("error", reject);
        resolve();
      });
    });

    const address = this.healthServer.address();

    if (!address || typeof address === "string") {
      throw new Error("Health server did not expose a numeric bound port.");
    }

    this.healthServerPort = address.port;
  }

  /**
   * Closes the HTTP health server if it is running.
   */
  private async closeHealthServer(): Promise<void> {
    if (!this.healthServer) {
      return;
    }

    const server = this.healthServer;

    this.healthServer = null;
    this.healthServerPort = null;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

/**
 * Starts the orchestrator process when executed as the package entrypoint.
 */
async function main(): Promise<void> {
  const orchestrator = new Orchestrator();

  process.once("SIGINT", () => {
    void orchestrator.stop();
  });
  process.once("SIGTERM", () => {
    void orchestrator.stop();
  });

  await orchestrator.start();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    const logger = createLogger({ component: "orchestrator-main" });
    captureRuntimeError(logger, error, {
      stage: "orchestrator_main",
    });
    process.exitCode = 1;
  });
}

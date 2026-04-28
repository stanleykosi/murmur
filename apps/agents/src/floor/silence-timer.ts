/**
 * Redis-backed dead-air detection for Murmur rooms.
 *
 * This module watches one room's floor state using the canonical
 * `FloorController`. When the floor stays empty for longer than the shared
 * dead-air timeout, it attempts to assign the floor to the room's host agent
 * and emits a structured recovery event for later orchestration work.
 */

import { DEAD_AIR_TIMEOUT_MS } from "@murmur/shared";
import { EventEmitter } from "node:events";

import {
  FloorController,
  type FloorControllerLogger,
} from "./controller.js";

/**
 * Canonical prompt delivered when a room goes quiet for too long.
 */
export const DEAD_AIR_PROMPT =
  "The conversation has gone quiet. Introduce a new angle on the topic or ask the other agents a provocative question.";

/**
 * Public event names emitted by the silence timer.
 */
export type SilenceTimerEventName = "deadAirDetected" | "error";

/**
 * Structured payload emitted when dead air is successfully recovered.
 */
export interface DeadAirDetectedPayload {
  detectedAt: number;
  hostAgentId: string;
  prompt: string;
  roomId: string;
  silenceDurationMs: number;
  silenceStartedAt: number;
}

interface SilenceTimerEvents {
  deadAirDetected: [payload: DeadAirDetectedPayload];
  error: [error: Error];
}

/**
 * Runtime configuration supported by the silence timer.
 */
export interface SilenceTimerOptions {
  logger?: FloorControllerLogger;
  now?: () => number;
  pollIntervalMs?: number;
}

/**
 * Fully validated silence-timer configuration.
 */
interface ResolvedSilenceTimerOptions {
  logger: FloorControllerLogger;
  now: () => number;
  pollIntervalMs: number;
}

const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * Converts an unknown thrown value into a concrete `Error`.
 *
 * @param value - Arbitrary thrown value from a dependency or caller.
 * @returns A normalized error instance with a useful message.
 */
function normalizeError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  return new Error(`Unexpected non-Error value: ${String(value)}.`);
}

/**
 * Validates a required string input.
 *
 * @param value - Candidate string value.
 * @param label - Human-readable field name for diagnostics.
 * @returns The trimmed string value.
 * @throws {Error} When the value is not a non-empty string.
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
 * Validates a positive polling duration.
 *
 * @param value - Candidate duration in milliseconds.
 * @param label - Human-readable field name for diagnostics.
 * @returns The validated duration.
 * @throws {Error} When the duration is not a positive finite number.
 */
function normalizePositiveDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number.`);
  }

  return value;
}

/**
 * Validates a timestamp supplied by the configured clock.
 *
 * @param value - Candidate epoch-millisecond timestamp.
 * @returns The validated timestamp.
 * @throws {Error} When the timestamp is invalid.
 */
function normalizeTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("now() must return a non-negative safe integer timestamp.");
  }

  return value;
}

/**
 * Resolves the timer options with Murmur defaults and validation.
 *
 * @param options - Partial caller overrides.
 * @returns Fully validated timer options.
 */
function resolveOptions(
  options: SilenceTimerOptions,
): ResolvedSilenceTimerOptions {
  const now = options.now ?? Date.now;

  if (typeof now !== "function") {
    throw new Error("now must be a function.");
  }

  return {
    logger: options.logger ?? console,
    now,
    pollIntervalMs: normalizePositiveDuration(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
    ),
  };
}

/**
 * Poll-based dead-air detector for one Murmur room.
 */
export class SilenceTimer extends EventEmitter<SilenceTimerEvents> {
  private activePollToken: number | null = null;

  private intervalHandle: NodeJS.Timeout | null = null;

  private readonly hostAgentId: string;

  private isStopped = true;

  private readonly options: ResolvedSilenceTimerOptions;

  private readonly roomId: string;

  private runToken = 0;

  /**
   * Creates a dead-air detector for one room and its host agent.
   *
   * @param floorController - Canonical room floor controller.
   * @param roomId - Room identifier whose silence should be monitored.
   * @param hostAgentId - Host agent that should revive the conversation.
   * @param options - Optional polling, clock, and logging overrides.
   */
  public constructor(
    private readonly floorController: FloorController,
    roomId: string,
    hostAgentId: string,
    options: SilenceTimerOptions = {},
  ) {
    super();

    if (!(floorController instanceof FloorController)) {
      throw new Error("floorController must be an instance of FloorController.");
    }

    this.roomId = normalizeRequiredText(roomId, "roomId");
    this.hostAgentId = normalizeRequiredText(hostAgentId, "hostAgentId");
    this.options = resolveOptions(options);
  }

  /**
   * Starts the polling loop and immediately performs one state check.
   */
  public start(): void {
    if (!this.isStopped) {
      return;
    }

    this.isStopped = false;
    this.runToken += 1;
    const runToken = this.runToken;

    this.intervalHandle = setInterval(() => {
      this.runPoll(runToken);
    }, this.options.pollIntervalMs);
    this.runPoll(runToken);
  }

  /**
   * Stops future polling without mutating persisted Redis silence state.
   */
  public stop(): void {
    this.stopRun(this.runToken);
  }

  /**
   * Indicates whether the timer is actively polling.
   *
   * @returns `true` when polling is active, otherwise `false`.
   */
  public isRunning(): boolean {
    return !this.isStopped;
  }

  /**
   * Starts one poll iteration unless another poll is already in flight.
   */
  private runPoll(runToken: number): void {
    if (!this.isRunActive(runToken) || this.activePollToken === runToken) {
      return;
    }

    this.activePollToken = runToken;
    void this.poll(runToken).catch((error: unknown) => {
      if (!this.isRunActive(runToken)) {
        return;
      }

      this.stopRun(runToken);
      const normalizedError = normalizeError(error);

      try {
        this.emit("error", normalizedError);
      } catch (emitError) {
        queueMicrotask(() => {
          throw normalizeError(emitError);
        });
      }
    }).finally(() => {
      if (this.activePollToken === runToken) {
        this.activePollToken = null;
      }
    });
  }

  /**
   * Performs one canonical silence-state evaluation.
   */
  private async poll(runToken: number): Promise<void> {
    const floorState = await this.floorController.getFloorState();

    if (!this.isRunActive(runToken)) {
      return;
    }

    if (floorState.roomId !== this.roomId) {
      throw new Error(
        `Floor state roomId "${floorState.roomId}" does not match timer roomId "${this.roomId}".`,
      );
    }

    if (floorState.currentHolder !== null) {
      if (floorState.lastSilenceStart !== null) {
        if (!this.isRunActive(runToken)) {
          return;
        }

        await this.floorController.clearSilenceStart();
      }

      return;
    }

    const now = normalizeTimestamp(this.options.now());

    if (floorState.lastSilenceStart === null) {
      if (!this.isRunActive(runToken)) {
        return;
      }

      await this.floorController.setSilenceStart(now);
      return;
    }

    const silenceDurationMs = now - floorState.lastSilenceStart;

    if (silenceDurationMs < DEAD_AIR_TIMEOUT_MS) {
      return;
    }

    await this.handleDeadAir(
      runToken,
      now,
      floorState.lastSilenceStart,
      silenceDurationMs,
    );
  }

  /**
   * Attempts to recover an empty room once the silence threshold is exceeded.
   *
   * @param detectedAt - Timestamp when the timeout was observed.
   * @param silenceStartedAt - Timestamp when the empty-floor window began.
   * @param silenceDurationMs - Elapsed silence duration in milliseconds.
   */
  private async handleDeadAir(
    runToken: number,
    detectedAt: number,
    silenceStartedAt: number,
    silenceDurationMs: number,
  ): Promise<void> {
    const claimed = await this.floorController.claimFloor(this.hostAgentId);

    if (!this.isRunActive(runToken)) {
      if (claimed) {
        await this.floorController.releaseFloor(this.hostAgentId);
      }

      return;
    }

    if (claimed) {
      await this.floorController.clearSilenceStart();

      if (!this.isRunActive(runToken)) {
        const released = await this.floorController.releaseFloor(this.hostAgentId);

        if (released) {
          await this.floorController.setSilenceStart(silenceStartedAt);
        }

        return;
      }

      const payload: DeadAirDetectedPayload = {
        detectedAt,
        hostAgentId: this.hostAgentId,
        prompt: DEAD_AIR_PROMPT,
        roomId: this.roomId,
        silenceDurationMs,
        silenceStartedAt,
      };

      this.options.logger.warn(
        {
          hostAgentId: this.hostAgentId,
          roomId: this.roomId,
          silenceDurationMs,
        },
        "Dead air detected; granted floor to host agent.",
      );
      this.emit("deadAirDetected", payload);
      return;
    }

    const currentHolder = await this.floorController.getCurrentHolder();

    if (!this.isRunActive(runToken)) {
      return;
    }

    if (currentHolder !== null) {
      await this.floorController.clearSilenceStart();

      this.options.logger.debug(
        {
          currentHolder,
          hostAgentId: this.hostAgentId,
          roomId: this.roomId,
        },
        "Dead air resolved before host recovery claim completed.",
      );
      return;
    }

    await this.floorController.setSilenceStart(detectedAt);

    if (!this.isRunActive(runToken)) {
      return;
    }

    this.options.logger.warn(
      {
        hostAgentId: this.hostAgentId,
        roomId: this.roomId,
        silenceDurationMs,
      },
      "Dead-air recovery claim did not succeed while floor stayed empty; restarting the silence window.",
    );
  }

  private isRunActive(runToken: number): boolean {
    return !this.isStopped && this.runToken === runToken;
  }

  private stopRun(runToken: number): void {
    if (this.runToken !== runToken) {
      return;
    }

    this.isStopped = true;
    this.activePollToken = null;

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }
}

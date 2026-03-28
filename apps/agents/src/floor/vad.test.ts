/**
 * Unit tests for Murmur's LiveKit Silero VAD wrapper.
 *
 * These assertions lock in the contract that LiveKit Silero provides low-level
 * speech activity while Murmur alone owns the authoritative 1.5-second
 * turn-complete boundary.
 */

import {
  VADEventType,
  type VADEvent,
} from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import { ReadableStream } from "node:stream/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SILENCE_THRESHOLD_MS } from "@murmur/shared";

const {
  initializeLoggerMock,
  liveKitLoggerState,
  loggerOptionsMock,
  sileroLoadMock,
} = vi.hoisted(() => {
  const state: {
    options: { level?: string; pretty: boolean } | undefined;
  } = {
    options: undefined,
  };

  return {
    initializeLoggerMock: vi.fn((options: { level?: string; pretty: boolean }) => {
      state.options = options;
    }),
    liveKitLoggerState: state,
    loggerOptionsMock: vi.fn(() => state.options),
    sileroLoadMock: vi.fn(),
  };
});

vi.mock("@livekit/agents", async () => {
  const actual = await vi.importActual<typeof import("@livekit/agents")>(
    "@livekit/agents",
  );

  return {
    ...actual,
    initializeLogger: initializeLoggerMock,
    loggerOptions: loggerOptionsMock,
  };
});

vi.mock("@livekit/agents-plugin-silero", () => ({
  VAD: {
    load: sileroLoadMock,
  },
}));

import {
  VADDetector,
  type VADDetectorEventPayload,
} from "./vad.js";

/**
 * Test double for the LiveKit Silero async-iterable VAD stream.
 */
class FakeSileroVADStream implements AsyncIterableIterator<VADEvent> {
  public readonly close = vi.fn(() => {
    this.closed = true;
    this.resolvePendingReads();
  });

  public readonly detachInputStream = vi.fn();

  public readonly endInput = vi.fn();

  public readonly flush = vi.fn();

  public readonly pushFrame = vi.fn();

  public readonly updateInputStream = vi.fn();

  private closed = false;

  private readonly pendingReads: Array<
    (result: IteratorResult<VADEvent>) => void
  > = [];

  private readonly queuedResults: Array<IteratorResult<VADEvent>> = [];

  /**
   * Queues the next event that the wrapper should receive.
   *
   * @param event - Synthetic VAD event to deliver.
   */
  public enqueue(event: VADEvent): void {
    const iteratorResult: IteratorResult<VADEvent> = {
      done: false,
      value: event,
    };

    if (this.pendingReads.length > 0) {
      const resolveRead = this.pendingReads.shift();

      resolveRead?.(iteratorResult);
      return;
    }

    this.queuedResults.push(iteratorResult);
  }

  /**
   * Marks the iterator as exhausted.
   */
  public finish(): void {
    this.closed = true;
    this.resolvePendingReads();
  }

  public [Symbol.asyncIterator](): AsyncIterableIterator<VADEvent> {
    return this;
  }

  public async next(): Promise<IteratorResult<VADEvent>> {
    if (this.queuedResults.length > 0) {
      return this.queuedResults.shift() as IteratorResult<VADEvent>;
    }

    if (this.closed) {
      return {
        done: true,
        value: undefined,
      };
    }

    return await new Promise<IteratorResult<VADEvent>>((resolve) => {
      this.pendingReads.push(resolve);
    });
  }

  /**
   * Resolves any pending async-iterator reads when the stream is closed.
   */
  private resolvePendingReads(): void {
    while (this.pendingReads.length > 0) {
      const resolveRead = this.pendingReads.shift();

      resolveRead?.({
        done: true,
        value: undefined,
      });
    }
  }
}

/**
 * Minimal Silero VAD double returned from the mocked plugin loader.
 */
interface FakeSileroVAD {
  close: () => Promise<void>;
  stream: () => FakeSileroVADStream;
}

/**
 * Creates a basic mono frame for VAD payloads and delegation checks.
 *
 * @returns A valid LiveKit audio frame.
 */
function createAudioFrame(): AudioFrame {
  return new AudioFrame(new Int16Array([1, 2, 3, 4]), 16_000, 1, 4);
}

/**
 * Creates a synthetic LiveKit VAD event with sensible defaults.
 *
 * @param type - Event type to generate.
 * @param overrides - Partial field overrides for the event.
 * @returns A fully populated VAD event object.
 */
function createVADEvent(
  type: VADEventType,
  overrides: Partial<VADEvent> = {},
): VADEvent {
  return {
    frames: [createAudioFrame()],
    inferenceDuration: 32,
    probability: 0.9,
    rawAccumulatedSilence: 0,
    rawAccumulatedSpeech: 96,
    samplesIndex: 512,
    silenceDuration: 0,
    speaking: type !== VADEventType.END_OF_SPEECH,
    speechDuration: 96,
    timestamp: 100,
    type,
    ...overrides,
  };
}

/**
 * Flushes the microtask queue so the wrapper's async event-consumption loop can
 * observe newly enqueued fake stream events.
 */
async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Creates a mocked Silero runtime pair for one test case.
 *
 * @returns The fake runtime and stream used by the wrapper.
 */
function createSileroFixture(): {
  stream: FakeSileroVADStream;
  vad: FakeSileroVAD;
} {
  const stream = new FakeSileroVADStream();
  const vad: FakeSileroVAD = {
    close: vi.fn(async () => undefined),
    stream: vi.fn(() => stream),
  };

  return {
    stream,
    vad,
  };
}

beforeEach(() => {
  liveKitLoggerState.options = undefined;
  initializeLoggerMock.mockReset();
  initializeLoggerMock.mockImplementation((options) => {
    liveKitLoggerState.options = options;
  });
  loggerOptionsMock.mockReset();
  loggerOptionsMock.mockImplementation(() => liveKitLoggerState.options);
  sileroLoadMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VADDetector", () => {
  it("initializes the LiveKit logger before creating the plugin stream", async () => {
    const fixture = createSileroFixture();

    fixture.vad.stream = vi.fn(() => {
      expect(loggerOptionsMock()).toEqual({
        level: "info",
        pretty: false,
      });

      return fixture.stream;
    });
    sileroLoadMock.mockResolvedValue(fixture.vad);

    const detector = await VADDetector.load();

    expect(initializeLoggerMock).toHaveBeenCalledTimes(1);
    expect(initializeLoggerMock).toHaveBeenCalledWith({
      level: "info",
      pretty: false,
    });

    await detector.close();
  });

  it("reuses an existing LiveKit logger configuration", async () => {
    const fixture = createSileroFixture();

    liveKitLoggerState.options = {
      level: "debug",
      pretty: false,
    };
    sileroLoadMock.mockResolvedValue(fixture.vad);

    const detector = await VADDetector.load();

    expect(initializeLoggerMock).not.toHaveBeenCalled();

    await detector.close();
  });

  it("loads LiveKit Silero with Murmur's default thresholds", async () => {
    const fixture = createSileroFixture();

    sileroLoadMock.mockResolvedValue(fixture.vad);

    const detector = await VADDetector.load();

    expect(sileroLoadMock).toHaveBeenCalledWith({
      activationThreshold: 0.5,
      forceCPU: true,
      minSilenceDuration: 550,
      minSpeechDuration: 96,
      sampleRate: 16_000,
    });
    expect(fixture.vad.stream).toHaveBeenCalledTimes(1);

    await detector.close();
    expect(fixture.stream.close).toHaveBeenCalledTimes(1);
    expect(fixture.vad.close).toHaveBeenCalledTimes(1);
  });

  it("emits speechStart when the plugin reports start of speech", async () => {
    const fixture = createSileroFixture();

    sileroLoadMock.mockResolvedValue(fixture.vad);

    const detector = await VADDetector.load({
      now: () => 123,
    });
    const speechStartHandler = vi.fn<(payload: VADDetectorEventPayload) => void>();

    detector.on("speechStart", speechStartHandler);
    fixture.stream.enqueue(createVADEvent(VADEventType.START_OF_SPEECH));

    await vi.waitFor(() => {
      expect(speechStartHandler).toHaveBeenCalledTimes(1);
    });

    expect(speechStartHandler).toHaveBeenCalledWith({
      frames: expect.any(Array),
      inferenceDurationMs: 32,
      probability: 0.9,
      samplesIndex: 512,
      silenceDurationMs: 0,
      speechDurationMs: 96,
      timestampMs: 123,
    });

    await detector.close();
  });

  it("emits speechEnd on the plugin's early speech-end cue", async () => {
    const fixture = createSileroFixture();

    sileroLoadMock.mockResolvedValue(fixture.vad);

    const detector = await VADDetector.load({
      now: () => 456,
    });
    const speechEndHandler = vi.fn<(payload: VADDetectorEventPayload) => void>();

    detector.on("speechEnd", speechEndHandler);
    fixture.stream.enqueue(createVADEvent(VADEventType.START_OF_SPEECH));
    fixture.stream.enqueue(
      createVADEvent(VADEventType.END_OF_SPEECH, {
        probability: 0.1,
        rawAccumulatedSilence: 550,
        silenceDuration: 550,
        speaking: false,
        speechDuration: 0,
      }),
    );

    await vi.waitFor(() => {
      expect(speechEndHandler).toHaveBeenCalledTimes(1);
    });

    expect(speechEndHandler).toHaveBeenCalledWith({
      frames: expect.any(Array),
      inferenceDurationMs: 32,
      probability: 0.1,
      samplesIndex: 512,
      silenceDurationMs: 550,
      speechDurationMs: 0,
      timestampMs: 456,
    });

    await detector.close();
  });

  it("emits turnComplete exactly once when silence reaches 1.5 seconds", async () => {
    const fixture = createSileroFixture();

    sileroLoadMock.mockResolvedValue(fixture.vad);

    const detector = await VADDetector.load({
      now: () => 789,
    });
    const turnCompleteHandler = vi.fn<(payload: VADDetectorEventPayload) => void>();

    detector.on("turnComplete", turnCompleteHandler);
    fixture.stream.enqueue(createVADEvent(VADEventType.START_OF_SPEECH));
    fixture.stream.enqueue(
      createVADEvent(VADEventType.END_OF_SPEECH, {
        probability: 0.1,
        rawAccumulatedSilence: 550,
        silenceDuration: 550,
        speaking: false,
        speechDuration: 0,
      }),
    );
    fixture.stream.enqueue(
      createVADEvent(VADEventType.INFERENCE_DONE, {
        probability: 0.05,
        rawAccumulatedSilence: SILENCE_THRESHOLD_MS,
        silenceDuration: SILENCE_THRESHOLD_MS,
        speaking: false,
        speechDuration: 0,
      }),
    );
    fixture.stream.enqueue(
      createVADEvent(VADEventType.INFERENCE_DONE, {
        probability: 0.02,
        rawAccumulatedSilence: SILENCE_THRESHOLD_MS + 200,
        silenceDuration: SILENCE_THRESHOLD_MS + 200,
        speaking: false,
        speechDuration: 0,
      }),
    );

    await vi.waitFor(() => {
      expect(turnCompleteHandler).toHaveBeenCalledTimes(1);
    });

    expect(turnCompleteHandler).toHaveBeenCalledWith({
      frames: expect.any(Array),
      inferenceDurationMs: 32,
      probability: 0.05,
      samplesIndex: 512,
      silenceDurationMs: SILENCE_THRESHOLD_MS,
      speechDurationMs: 0,
      timestampMs: 789,
    });

    await detector.close();
  });

  it("does not emit turnComplete early at the plugin's 550ms speech-end cue", async () => {
    const fixture = createSileroFixture();

    sileroLoadMock.mockResolvedValue(fixture.vad);

    const detector = await VADDetector.load();
    const turnCompleteHandler = vi.fn<(payload: VADDetectorEventPayload) => void>();

    detector.on("turnComplete", turnCompleteHandler);
    fixture.stream.enqueue(createVADEvent(VADEventType.START_OF_SPEECH));
    fixture.stream.enqueue(
      createVADEvent(VADEventType.END_OF_SPEECH, {
        probability: 0.1,
        rawAccumulatedSilence: 550,
        silenceDuration: 550,
        speaking: false,
        speechDuration: 0,
      }),
    );
    fixture.stream.enqueue(
      createVADEvent(VADEventType.INFERENCE_DONE, {
        probability: 0.05,
        rawAccumulatedSilence: 1_200,
        silenceDuration: 1_200,
        speaking: false,
        speechDuration: 0,
      }),
    );

    await flushAsyncWork();

    expect(turnCompleteHandler).not.toHaveBeenCalled();

    await detector.close();
  });

  it("cancels a pending completion when speech resumes before the 1.5s threshold", async () => {
    const fixture = createSileroFixture();

    sileroLoadMock.mockResolvedValue(fixture.vad);

    const detector = await VADDetector.load();
    const turnCompleteHandler = vi.fn<(payload: VADDetectorEventPayload) => void>();

    detector.on("turnComplete", turnCompleteHandler);
    fixture.stream.enqueue(createVADEvent(VADEventType.START_OF_SPEECH));
    fixture.stream.enqueue(
      createVADEvent(VADEventType.END_OF_SPEECH, {
        probability: 0.1,
        rawAccumulatedSilence: 550,
        silenceDuration: 550,
        speaking: false,
        speechDuration: 0,
      }),
    );
    fixture.stream.enqueue(
      createVADEvent(VADEventType.INFERENCE_DONE, {
        probability: 0.08,
        rawAccumulatedSilence: 1_200,
        silenceDuration: 1_200,
        speaking: false,
        speechDuration: 0,
      }),
    );
    fixture.stream.enqueue(
      createVADEvent(VADEventType.START_OF_SPEECH, {
        probability: 0.95,
        rawAccumulatedSilence: 0,
        silenceDuration: 0,
        speaking: true,
        speechDuration: 96,
      }),
    );
    fixture.stream.enqueue(
      createVADEvent(VADEventType.END_OF_SPEECH, {
        probability: 0.1,
        rawAccumulatedSilence: 550,
        silenceDuration: 550,
        speaking: false,
        speechDuration: 0,
      }),
    );
    fixture.stream.enqueue(
      createVADEvent(VADEventType.INFERENCE_DONE, {
        probability: 0.05,
        rawAccumulatedSilence: SILENCE_THRESHOLD_MS,
        silenceDuration: SILENCE_THRESHOLD_MS,
        speaking: false,
        speechDuration: 0,
      }),
    );

    await vi.waitFor(() => {
      expect(turnCompleteHandler).toHaveBeenCalledTimes(1);
    });

    await detector.close();
  });

  it("delegates stream attachment and frame-control methods to the plugin stream", async () => {
    const fixture = createSileroFixture();

    sileroLoadMock.mockResolvedValue(fixture.vad);

    const detector = await VADDetector.load();
    const inputStream = new ReadableStream<AudioFrame>();
    const frame = createAudioFrame();

    detector.updateInputStream(inputStream);
    detector.detachInputStream();
    detector.pushFrame(frame);
    detector.flush();
    detector.endInput();

    expect(fixture.stream.updateInputStream).toHaveBeenCalledWith(inputStream);
    expect(fixture.stream.detachInputStream).toHaveBeenCalledTimes(1);
    expect(fixture.stream.pushFrame).toHaveBeenCalledWith(frame);
    expect(fixture.stream.flush).toHaveBeenCalledTimes(1);
    expect(fixture.stream.endInput).toHaveBeenCalledTimes(1);

    await detector.close();
  });

  it("fails fast on invalid options", async () => {
    await expect(
      VADDetector.load({
        pluginSpeechEndSilenceMs: 600,
        turnCompleteSilenceMs: 500,
      }),
    ).rejects.toThrow(/turnCompleteSilenceMs/i);
  });

  it("emits an error when the plugin stream yields malformed events", async () => {
    const fixture = createSileroFixture();

    sileroLoadMock.mockResolvedValue(fixture.vad);

    const detector = await VADDetector.load();
    const errorHandler = vi.fn<(error: Error) => void>();

    detector.on("error", errorHandler);
    fixture.stream.enqueue({
      ...createVADEvent(VADEventType.START_OF_SPEECH),
      frames: ["not-a-frame"] as unknown as AudioFrame[],
    });

    await vi.waitFor(() => {
      expect(errorHandler).toHaveBeenCalledTimes(1);
    });
    expect(errorHandler.mock.calls[0]?.[0].message).toMatch(/frames\[0\]/i);

    await detector.close();
  });

  it("rejects plugin runtimes that do not expose a valid stream shape", async () => {
    sileroLoadMock.mockResolvedValue({
      close: vi.fn(async () => undefined),
      stream: vi.fn(() => ({})),
    });

    await expect(VADDetector.load()).rejects.toThrow(/async-iterable stream/i);
  });
});

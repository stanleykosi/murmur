/**
 * LiveKit session bridge for the Murmur agent graph.
 *
 * Step 30 keeps session startup outside the graph, but the graph still owns the
 * final speech handoff for the `speak` node. This bridge adapts an already
 * started LiveKit `AgentSession`-like object to the graph's simple
 * `AgentSessionBridge` contract.
 */

import { AudioFrame } from "@livekit/rtc-node";
import { ReadableStream } from "node:stream/web";

import type { AgentSessionBridge } from "./state.js";

/**
 * Canonical sample rate of Murmur's synthesized PCM audio.
 */
export const LIVEKIT_TTS_SAMPLE_RATE = 24_000;

/**
 * Canonical number of channels in Murmur's synthesized PCM audio.
 */
export const LIVEKIT_TTS_CHANNELS = 1;

/**
 * Default frame size used when chunking synthesized PCM audio for LiveKit.
 */
export const LIVEKIT_TTS_SAMPLES_PER_CHANNEL = LIVEKIT_TTS_SAMPLE_RATE / 10;

/**
 * Audio frame type emitted to LiveKit session speech methods.
 */
type LiveKitAudioFrame = AudioFrame;

/**
 * Minimal speech-handle surface returned by LiveKit session speech methods.
 */
export interface SpeechHandleLike {
  waitForPlayout(): Promise<void>;
}

/**
 * Minimal LiveKit session surface required by the graph bridge.
 */
export interface LiveKitSessionLike {
  say(
    text: string,
    options: {
      audio: ReadableStream<LiveKitAudioFrame>;
      allowInterruptions: boolean;
      addToChatCtx: boolean;
    },
  ): SpeechHandleLike;
}

/**
 * Validates a required speech text value before publishing it.
 *
 * @param text - Candidate spoken text.
 * @returns The trimmed speech text.
 * @throws {Error} When the text is not a non-empty string.
 */
function normalizeSpeechText(text: string): string {
  if (typeof text !== "string") {
    throw new Error("text must be a string.");
  }

  const normalizedText = text.trim();

  if (normalizedText.length === 0) {
    throw new Error("text must be a non-empty string.");
  }

  return normalizedText;
}

/**
 * Validates a raw PCM payload before translating it into audio frames.
 *
 * @param pcmAudio - Candidate PCM audio payload.
 * @returns The same buffer when it is valid.
 * @throws {Error} When the payload is missing, empty, or not s16le-aligned.
 */
function normalizePcmAudio(pcmAudio: Buffer): Buffer {
  if (!Buffer.isBuffer(pcmAudio)) {
    throw new Error("pcmAudio must be a Buffer.");
  }

  if (pcmAudio.byteLength === 0) {
    throw new Error("pcmAudio must be a non-empty Buffer.");
  }

  if (pcmAudio.byteLength % 2 !== 0) {
    throw new Error("pcmAudio must contain an even number of bytes for PCM s16le audio.");
  }

  return pcmAudio;
}

/**
 * Converts a PCM byte buffer into LiveKit audio frames.
 *
 * @param pcmAudio - Raw 24 kHz mono PCM audio bytes.
 * @returns Audio frames that can be published through a LiveKit session.
 * @throws {Error} When the PCM payload cannot be translated into frames.
 */
export function convertPcmAudioToFrames(
  pcmAudio: Buffer,
): LiveKitAudioFrame[] {
  const normalizedAudio = normalizePcmAudio(pcmAudio);
  const bytesPerSample = 2;
  const bytesPerFrame =
    LIVEKIT_TTS_SAMPLES_PER_CHANNEL * LIVEKIT_TTS_CHANNELS * bytesPerSample;
  const frames: LiveKitAudioFrame[] = [];

  for (
    let frameStartOffset = 0;
    frameStartOffset < normalizedAudio.byteLength;
    frameStartOffset += bytesPerFrame
  ) {
    const frameEndOffset = Math.min(
      frameStartOffset + bytesPerFrame,
      normalizedAudio.byteLength,
    );
    const frameBytes = normalizedAudio.subarray(frameStartOffset, frameEndOffset);
    const exactFrameBytes = Uint8Array.from(frameBytes);
    const samplesPerChannel =
      exactFrameBytes.byteLength / (bytesPerSample * LIVEKIT_TTS_CHANNELS);

    frames.push(
      new AudioFrame(
        new Int16Array(exactFrameBytes.buffer),
        LIVEKIT_TTS_SAMPLE_RATE,
        LIVEKIT_TTS_CHANNELS,
        samplesPerChannel,
      ),
    );
  }

  if (frames.length === 0) {
    throw new Error("pcmAudio did not contain any publishable audio frames.");
  }

  return frames;
}

/**
 * Wraps a frame list in a `ReadableStream` for `session.say(...)`.
 *
 * @param frames - Audio frames that should be streamed to the session.
 * @returns A stream that emits each frame once and then closes.
 */
function createAudioFrameStream(
  frames: LiveKitAudioFrame[],
): ReadableStream<LiveKitAudioFrame> {
  return new ReadableStream<LiveKitAudioFrame>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(frame);
      }

      controller.close();
    },
  });
}

/**
 * Creates the graph-facing bridge for a started LiveKit session.
 *
 * @param session - Started LiveKit session or test double that exposes `say`.
 * @returns A simple `speakText` bridge used by the graph's `speak` node.
 * @throws {Error} When the supplied session does not expose the required API.
 */
export function createLiveKitSessionBridge(
  session: LiveKitSessionLike,
): AgentSessionBridge {
  if (!session || typeof session.say !== "function") {
    throw new Error("session must expose a LiveKit-compatible say() method.");
  }

  return {
    async speakText(text: string, pcmAudio: Buffer): Promise<void> {
      const normalizedText = normalizeSpeechText(text);
      const frames = convertPcmAudioToFrames(pcmAudio);
      const speechHandle = session.say(normalizedText, {
        audio: createAudioFrameStream(frames),
        allowInterruptions: false,
        addToChatCtx: false,
      });

      if (
        !speechHandle
        || typeof speechHandle.waitForPlayout !== "function"
      ) {
        throw new Error(
          "session.say(...) must return a speech handle with waitForPlayout().",
        );
      }

      await speechHandle.waitForPlayout();
    },
  };
}

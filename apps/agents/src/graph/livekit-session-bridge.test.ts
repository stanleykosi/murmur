/**
 * Unit tests for the Murmur LiveKit session bridge.
 *
 * These assertions pin the PCM-to-frame conversion path so graph speech
 * handoff stays independent from LiveKit's global logger initialization.
 */

import { describe, expect, it, vi } from "vitest";

import {
  LIVEKIT_TTS_CHANNELS,
  LIVEKIT_TTS_SAMPLE_RATE,
  LIVEKIT_TTS_SAMPLES_PER_CHANNEL,
  convertPcmAudioToFrames,
  createLiveKitSessionBridge,
} from "./livekit-session-bridge.js";

describe("convertPcmAudioToFrames", () => {
  it("converts PCM bytes without requiring LiveKit logger setup", () => {
    const frames = convertPcmAudioToFrames(Buffer.from([0, 1, 2, 3]));

    expect(frames).toHaveLength(1);
    expect(frames[0]?.sampleRate).toBe(LIVEKIT_TTS_SAMPLE_RATE);
    expect(frames[0]?.channels).toBe(LIVEKIT_TTS_CHANNELS);
    expect(frames[0]?.samplesPerChannel).toBe(2);
  });

  it("chunks long PCM buffers into 100 ms audio frames", () => {
    const bytesPerFrame = LIVEKIT_TTS_SAMPLES_PER_CHANNEL * LIVEKIT_TTS_CHANNELS * 2;
    const frames = convertPcmAudioToFrames(Buffer.alloc(bytesPerFrame * 2 + 8));

    expect(frames.map((frame) => frame.samplesPerChannel)).toEqual([
      LIVEKIT_TTS_SAMPLES_PER_CHANNEL,
      LIVEKIT_TTS_SAMPLES_PER_CHANNEL,
      4,
    ]);
  });
});

describe("createLiveKitSessionBridge", () => {
  it("publishes converted frames through session.say()", async () => {
    const speechHandle = {
      waitForPlayout: vi.fn(async () => Promise.resolve()),
    };
    const say = vi.fn((_text: string, options: { audio: ReadableStream<unknown> }) => {
      void options;
      return speechHandle;
    });
    const session = { say };
    const bridge = createLiveKitSessionBridge(session);

    await bridge.speakText("Hello from Murmur.", Buffer.from([0, 1, 2, 3]));

    expect(say).toHaveBeenCalledTimes(1);
    expect(speechHandle.waitForPlayout).toHaveBeenCalledTimes(1);
  });
});

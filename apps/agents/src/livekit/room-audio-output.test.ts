/**
 * Unit tests for the custom room-bound LiveKit audio output.
 *
 * These assertions pin playout lifecycle behavior that runner shutdown depends
 * on, especially when output is closed while a segment is still in flight.
 */

import { AudioFrame } from "@livekit/rtc-node";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoomAudioOutput } from "./room-audio-output.js";

/**
 * Builds one 100 ms 24 kHz mono audio frame for deterministic tests.
 *
 * @returns A valid synthesized audio frame.
 */
function createAudioFrame(): AudioFrame {
  const samplesPerChannel = 2_400;

  return new AudioFrame(
    new Int16Array(samplesPerChannel),
    24_000,
    1,
    samplesPerChannel,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("RoomAudioOutput", () => {
  /**
   * Closing the output during an active segment must settle any pending
   * `waitForPlayout()` call so runner teardown cannot hang indefinitely.
   */
  it("resolves pending playout waits when closed mid-segment", async () => {
    vi.useFakeTimers();

    const localParticipant = {
      publishTrack: vi.fn(async () => ({
        sid: "publication-1",
      })),
      unpublishTrack: vi.fn(async () => undefined),
    };
    const output = new RoomAudioOutput({
      localParticipant,
    } as never);

    await output.start();
    await output.captureFrame(createAudioFrame());
    output.flush();

    const waitForPlayoutPromise = output.waitForPlayout();

    await output.close();

    await expect(waitForPlayoutPromise).resolves.toEqual({
      playbackPosition: 0,
      interrupted: true,
    });
    expect(localParticipant.unpublishTrack).toHaveBeenCalledWith("publication-1");
  });
});

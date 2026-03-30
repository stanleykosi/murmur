import { env } from "../config/env.js";
import type { TTSProvider } from "./provider.js";
import {
  createTtsLogger,
  getErrorStatusCode,
  getRetryDelayMs,
  isRetryableTtsError,
  normalizeError,
  normalizeSynthesisText,
  normalizeVoiceId,
  readResponseBodyAsBuffer,
  TTS_MAX_ATTEMPTS,
  TTS_REQUEST_TIMEOUT_MS,
  TtsMissingBodyError,
  TtsResponseError,
  type DelayImplementation,
  type FetchImplementation,
  waitForRetryDelay,
} from "./shared.js";

import type { Logger } from "pino";

export const MISTRAL_TTS_ENDPOINT = "https://api.mistral.ai/v1/audio/speech";

export const MISTRAL_MODEL_ID = "voxtral-mini-tts-2603";

export const MISTRAL_OUTPUT_FORMAT = "wav" as const;

const mistralLogger = createTtsLogger("tts-mistral");

function parseWavAudio(wavBuffer: Buffer): Buffer {
  const riff = wavBuffer.toString("ascii", 0, 4);
  if (riff !== "RIFF") {
    throw new Error("Invalid WAV file: missing RIFF header");
  }

  const wave = wavBuffer.toString("ascii", 8, 12);
  if (wave !== "WAVE") {
    throw new Error("Invalid WAV file: missing WAVE header");
  }

  let offset = 12;
  let audioData: Buffer | null = null;
  let bitDepth = 16;
  let numChannels = 1;

  while (offset < wavBuffer.length - 8) {
    const chunkId = wavBuffer.toString("ascii", offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);

    if (chunkId === "fmt ") {
      const audioFormat = wavBuffer.readUInt16LE(offset + 8);
      numChannels = wavBuffer.readUInt16LE(offset + 10);
      bitDepth = wavBuffer.readUInt16LE(offset + 22);

      if (audioFormat !== 1 && audioFormat !== 3) {
        throw new Error(
          `Unsupported WAV audio format: ${audioFormat}. Only PCM (1) and float32 (3) are supported.`,
        );
      }
    }

    if (chunkId === "data") {
      audioData = wavBuffer.subarray(offset + 8, offset + 8 + chunkSize);
      break;
    }

    offset += 8 + chunkSize;
  }

  if (!audioData) {
    throw new Error("Invalid WAV file: no data chunk found");
  }

  if (bitDepth === 32) {
    const floatSamples = new Float32Array(audioData.buffer, audioData.byteOffset, audioData.length / 4);
    const int16Samples = new Int16Array(floatSamples.length);
    for (let i = 0; i < floatSamples.length; i++) {
      const sample = Math.max(-1, Math.min(1, floatSamples[i] ?? 0));
      int16Samples[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return Buffer.from(int16Samples.buffer);
  }

  return audioData;
}

export class MistralTTSProvider implements TTSProvider {
  public constructor(
    private readonly fetchImplementation: FetchImplementation = globalThis.fetch,
    private readonly logger: Logger = mistralLogger,
    private readonly delay: DelayImplementation = waitForRetryDelay,
  ) {}

  public async synthesize(text: string, voiceId: string): Promise<Buffer> {
    const normalizedText = normalizeSynthesisText(text);
    const normalizedVoiceId = normalizeVoiceId(voiceId);
    const requestStartedAt = Date.now();

    this.logger.info(
      {
        attempt: 1,
        provider: "mistral",
        textLength: normalizedText.length,
        voiceId: normalizedVoiceId,
      },
      "Started TTS synthesis.",
    );

    for (let attempt = 1; attempt <= TTS_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.fetchImplementation(MISTRAL_TTS_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            input: normalizedText,
            model: MISTRAL_MODEL_ID,
            voice_id: normalizedVoiceId,
            response_format: MISTRAL_OUTPUT_FORMAT,
          }),
          signal: AbortSignal.timeout(TTS_REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
          const responseText = await response.text();
          throw new TtsResponseError("Mistral", response.status, responseText);
        }

        const wavBuffer = await readResponseBodyAsBuffer(
          response,
          "Mistral",
        );

        const audioBuffer = parseWavAudio(wavBuffer);

        this.logger.info(
          {
            attempt,
            bytes: audioBuffer.length,
            latencyMs: Date.now() - requestStartedAt,
            provider: "mistral",
            textLength: normalizedText.length,
            voiceId: normalizedVoiceId,
          },
          "Completed TTS synthesis.",
        );

        return audioBuffer;
      } catch (error) {
        if (attempt < TTS_MAX_ATTEMPTS && isRetryableTtsError(error)) {
          const delayMs = getRetryDelayMs(attempt);

          this.logger.warn(
            {
              attempt,
              delayMs,
              latencyMs: Date.now() - requestStartedAt,
              provider: "mistral",
              statusCode: getErrorStatusCode(error),
              textLength: normalizedText.length,
              voiceId: normalizedVoiceId,
            },
            "Retrying TTS synthesis after a retryable upstream failure.",
          );

          await this.delay(delayMs);
          continue;
        }

        const normalizedError = normalizeError(
          "Unknown Mistral TTS synthesis failure.",
          error,
        );

        this.logger.error(
          {
            attempt,
            err: normalizedError,
            latencyMs: Date.now() - requestStartedAt,
            provider: "mistral",
            statusCode: getErrorStatusCode(error),
            textLength: normalizedText.length,
            voiceId: normalizedVoiceId,
          },
          "TTS synthesis failed.",
        );

        throw buildMistralFailure(normalizedVoiceId, normalizedError);
      }
    }

    throw new Error(
      `Mistral TTS synthesis failed for voice "${normalizedVoiceId}" after ${TTS_MAX_ATTEMPTS} attempts.`,
    );
  }
}

function buildMistralFailure(voiceId: string, error: Error): Error {
  if (error instanceof TtsResponseError) {
    return new Error(
      `Mistral TTS synthesis failed for voice "${voiceId}" with status ${error.statusCode}: ${error.responseBody || "No response body returned."}`,
      {
        cause: error,
      },
    );
  }

  if (error instanceof TtsMissingBodyError) {
    return new Error(
      `Mistral TTS synthesis failed for voice "${voiceId}": ${error.message}`,
      {
        cause: error,
      },
    );
  }

  return new Error(
    `Mistral TTS synthesis failed for voice "${voiceId}" after ${TTS_MAX_ATTEMPTS} attempts.`,
    {
      cause: error,
    },
  );
}
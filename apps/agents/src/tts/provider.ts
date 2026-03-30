/**
 * Shared abstractions for Murmur text-to-speech providers.
 *
 * This module exposes the canonical synthesis contract used by the agent
 * orchestrator and the single factory function that maps Murmur's shared
 * provider identifiers to concrete implementations.
 */

import type { TtsProvider } from "@murmur/shared";

import { CartesiaTTSProvider } from "./cartesia.js";
import { ElevenLabsTTSProvider } from "./elevenlabs.js";
import { MistralTTSProvider } from "./mistral.js";

/**
 * Minimal interface every Murmur TTS backend must satisfy.
 */
export interface TTSProvider {
  /**
   * Synthesizes the supplied text into raw PCM audio bytes.
   *
   * @param text - Text content that should be spoken by the provider voice.
   * @param voiceId - Provider-specific voice identifier.
   * @returns A buffer containing 24 kHz PCM audio bytes.
   */
  synthesize(text: string, voiceId: string): Promise<Buffer>;
}

/**
 * Creates a canonical Murmur TTS provider for the requested backend.
 *
 * @param provider - Shared Murmur provider identifier.
 * @returns A concrete provider implementation for the selected backend.
 * @throws {Error} When the supplied provider string is unsupported at runtime.
 */
export function createTTSProvider(provider: TtsProvider): TTSProvider {
  switch (provider) {
    case "cartesia":
      return new CartesiaTTSProvider();
    case "elevenlabs":
      return new ElevenLabsTTSProvider();
    case "mistral":
      return new MistralTTSProvider();
    default:
      throw new Error(
        `Unsupported TTS provider "${provider}". Expected one of: cartesia, elevenlabs, mistral.`,
      );
  }
}

/**
 * Regex-based content moderation service for Murmur agent output.
 *
 * The moderation blocklist is loaded from a JSON asset at module evaluation
 * time so invalid patterns fail fast during process startup instead of causing
 * partial moderation behavior at runtime.
 */

import { readFileSync } from "node:fs";

/**
 * Result returned after moderating a candidate text string.
 */
export interface ModerationResult {
  clean: string;
  wasFiltered: boolean;
}

const BLOCKLIST_CONFIG_URL = new URL("../config/blocklist.json", import.meta.url);

/**
 * Loads and compiles the blocklist regex patterns from disk.
 *
 * @returns The compiled blocklist patterns used by `filterContent`.
 * @throws {Error} When the JSON asset is malformed or a regex cannot be compiled.
 */
function loadBlocklistPatterns(): RegExp[] {
  const rawFileContents = readFileSync(BLOCKLIST_CONFIG_URL, "utf8");
  const parsedConfig = JSON.parse(rawFileContents) as unknown;

  if (!Array.isArray(parsedConfig)) {
    throw new Error("Moderation blocklist must be a JSON array of regex strings.");
  }

  return parsedConfig.map((pattern, index) => {
    if (typeof pattern !== "string" || pattern.trim().length === 0) {
      throw new Error(
        `Moderation blocklist entry ${index} must be a non-empty regex string.`,
      );
    }

    try {
      return new RegExp(pattern, "giu");
    } catch (error) {
      throw new Error(
        `Moderation blocklist entry ${index} could not be compiled: ${String(error)}`,
      );
    }
  });
}

/**
 * Compiled moderation regexes loaded once during module initialization.
 */
export const BLOCKLIST_PATTERNS = loadBlocklistPatterns();

/**
 * Replaces blocked words or phrases in a text string with `[filtered]`.
 *
 * @param text - Candidate text to moderate before TTS synthesis.
 * @returns The filtered text plus a flag describing whether moderation changed it.
 */
export function filterContent(text: string): ModerationResult {
  let filteredText = text;
  let wasFiltered = false;

  for (const pattern of BLOCKLIST_PATTERNS) {
    const nextText = filteredText.replace(pattern, "[filtered]");

    if (nextText !== filteredText) {
      filteredText = nextText;
      wasFiltered = true;
    }

    // Global regexes keep mutable `lastIndex` state between uses.
    pattern.lastIndex = 0;
  }

  return {
    clean: filteredText,
    wasFiltered,
  };
}

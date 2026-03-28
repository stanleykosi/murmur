/**
 * Canonical moderation helpers shared by the Murmur API and agent runtime.
 *
 * This module owns the single blocklist and filtering implementation used
 * across the monorepo so agent-output moderation stays consistent everywhere.
 * The regexes are compiled eagerly during module evaluation to fail fast when
 * the canonical blocklist configuration is invalid.
 */

/**
 * Result returned after moderating a candidate text string.
 */
export interface ModerationResult {
  clean: string;
  wasFiltered: boolean;
}

/**
 * Canonical regex source strings for Murmur's starter moderation blocklist.
 */
export const MODERATION_BLOCKLIST_SOURCES = [
  "\\bassholes?\\b",
  "\\bbastards?\\b",
  "\\bbitch(?:es)?\\b",
  "\\bfuck(?:er|ers|ed|ing|s)?\\b",
  "\\bmotherfuck(?:er|ers|ing)?\\b",
  "\\bshit(?:head|heads|ty|ting|s)?\\b",
] as const;

/**
 * Validates a blocklist regex source before compilation.
 *
 * @param source - Raw regex source string.
 * @param index - Source index used in validation diagnostics.
 * @returns The trimmed regex source.
 * @throws {Error} When the source is not a non-empty string.
 */
function normalizePatternSource(source: string, index: number): string {
  if (typeof source !== "string") {
    throw new Error(
      `Moderation blocklist entry ${index} must be a non-empty regex string.`,
    );
  }

  const normalizedSource = source.trim();

  if (normalizedSource.length === 0) {
    throw new Error(
      `Moderation blocklist entry ${index} must be a non-empty regex string.`,
    );
  }

  return normalizedSource;
}

/**
 * Compiles the supplied blocklist regex sources into reusable `RegExp` objects.
 *
 * @param sources - Regex source strings that should be compiled.
 * @returns The compiled blocklist patterns.
 * @throws {Error} When a regex source is malformed.
 */
export function compileModerationPatterns(
  sources: readonly string[] = MODERATION_BLOCKLIST_SOURCES,
): RegExp[] {
  return sources.map((source, index) => {
    const normalizedSource = normalizePatternSource(source, index);

    try {
      return new RegExp(normalizedSource, "giu");
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
export const BLOCKLIST_PATTERNS = compileModerationPatterns();

/**
 * Replaces blocked words or phrases in a text string with `[filtered]`.
 *
 * @param text - Candidate text to moderate before TTS synthesis.
 * @returns The filtered text plus a flag describing whether moderation changed it.
 * @throws {Error} When the text is not a string.
 */
export function filterContent(text: string): ModerationResult {
  if (typeof text !== "string") {
    throw new Error("text must be a string.");
  }

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

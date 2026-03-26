/**
 * Shared frontend utility helpers for the Murmur web application.
 *
 * This module centralizes lightweight formatting and class-name helpers needed
 * by upcoming lobby, room, and admin features without introducing additional
 * runtime dependencies.
 */

const FIVE_SECONDS_IN_MS = 5_000;
const MINUTE_IN_MS = 60_000;
const HOUR_IN_MS = 3_600_000;
const DAY_IN_MS = 86_400_000;
const MIN_TRUNCATE_LENGTH = 4;
const TRUNCATION_SUFFIX = "...";

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});

const relativeTimeFormatter = new Intl.RelativeTimeFormat("en-US", {
  numeric: "auto",
});

const graphemeSegmenter = new Intl.Segmenter("en-US", {
  granularity: "grapheme",
});

/**
 * Supported primitive class-name values for `cn()`.
 */
type ClassNameValue = string | false | null | undefined;

/**
 * Normalizes a timestamp-like value into a valid `Date` instance.
 *
 * @param value - The candidate timestamp supplied by the caller.
 * @param label - Human-readable label used in thrown error messages.
 * @returns A valid `Date` instance for downstream formatting.
 * @throws {TypeError} When the value is not a supported timestamp input.
 * @throws {Error} When the value cannot be parsed into a valid date.
 */
function parseTimestamp(
  value: string | number | Date,
  label: string,
): Date {
  if (!(value instanceof Date) && typeof value !== "string" && typeof value !== "number") {
    throw new TypeError(`${label} must be a Date, string, or number timestamp.`);
  }

  const normalizedDate = value instanceof Date ? new Date(value.getTime()) : new Date(value);

  if (Number.isNaN(normalizedDate.getTime())) {
    throw new Error(`${label} must be a valid timestamp.`);
  }

  return normalizedDate;
}

/**
 * Merges truthy class names into a single space-delimited string.
 *
 * @param values - Candidate class-name values, including falsy entries.
 * @returns A normalized class-name string.
 */
export function cn(...values: ClassNameValue[]): string {
  return values.filter(Boolean).join(" ");
}

/**
 * Formats a timestamp as a short local time for transcript and room metadata.
 *
 * @param timestamp - The timestamp to format.
 * @returns A localized time string such as `3:42 PM`.
 * @throws {TypeError | Error} When the timestamp is invalid.
 */
export function formatTimestamp(timestamp: string | number | Date): string {
  return timeFormatter.format(parseTimestamp(timestamp, "timestamp"));
}

/**
 * Converts a timestamp into a short relative label like `2 minutes ago`.
 *
 * @param timestamp - The timestamp being described relative to `now`.
 * @param now - Reference point used for deterministic comparisons in tests and UI.
 * @returns A relative time label with Murmur's custom "just now" bucket.
 * @throws {TypeError | Error} When either timestamp is invalid.
 */
export function formatRelativeTime(
  timestamp: string | number | Date,
  now: string | number | Date = new Date(),
): string {
  const targetTime = parseTimestamp(timestamp, "timestamp");
  const referenceTime = parseTimestamp(now, "now");
  const differenceInMilliseconds =
    targetTime.getTime() - referenceTime.getTime();
  const absoluteDifference = Math.abs(differenceInMilliseconds);

  if (absoluteDifference < FIVE_SECONDS_IN_MS) {
    return "just now";
  }

  const direction = differenceInMilliseconds < 0 ? -1 : 1;

  if (absoluteDifference < MINUTE_IN_MS) {
    const seconds = Math.floor(absoluteDifference / 1_000);

    return relativeTimeFormatter.format(direction * seconds, "second");
  }

  if (absoluteDifference < HOUR_IN_MS) {
    const minutes = Math.floor(absoluteDifference / MINUTE_IN_MS);

    return relativeTimeFormatter.format(direction * minutes, "minute");
  }

  if (absoluteDifference < DAY_IN_MS) {
    const hours = Math.floor(absoluteDifference / HOUR_IN_MS);

    return relativeTimeFormatter.format(direction * hours, "hour");
  }

  const days = Math.floor(absoluteDifference / DAY_IN_MS);

  return relativeTimeFormatter.format(direction * days, "day");
}

/**
 * Truncates a string to a maximum visible length using an ASCII ellipsis.
 *
 * The original string content is preserved exactly when it fits within the
 * limit; no trimming or whitespace normalization is applied.
 *
 * @param value - The string to preserve or truncate.
 * @param maxLength - Maximum output length, including the trailing ellipsis.
 * @returns The original string or its truncated equivalent.
 * @throws {TypeError} When the value is not a string.
 * @throws {RangeError} When `maxLength` is not an integer greater than or equal to 4.
 */
export function truncateText(value: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new TypeError("value must be a string.");
  }

  if (!Number.isInteger(maxLength) || maxLength < MIN_TRUNCATE_LENGTH) {
    throw new RangeError(
      `maxLength must be an integer greater than or equal to ${MIN_TRUNCATE_LENGTH}.`,
    );
  }

  const graphemes = Array.from(
    graphemeSegmenter.segment(value),
    ({ segment }) => segment,
  );

  if (graphemes.length <= maxLength) {
    return value;
  }

  return `${graphemes.slice(0, maxLength - TRUNCATION_SUFFIX.length).join("")}${TRUNCATION_SUFFIX}`;
}

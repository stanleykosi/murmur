/**
 * Shared Murmur runtime constants for turn-taking, transcript retention, and
 * voice activity detection thresholds.
 */

/**
 * Consecutive silence duration required to consider a speaking turn complete.
 */
export const SILENCE_THRESHOLD_MS = 1500;

/**
 * Maximum empty-floor duration before the host agent revives the room.
 */
export const DEAD_AIR_TIMEOUT_MS = 5000;

/**
 * Rolling transcript window size used for agent conversational context.
 */
export const ROLLING_WINDOW_SECONDS = 60;

/**
 * Maximum number of transcript entries retained in client state.
 */
export const MAX_TRANSCRIPT_ENTRIES = 200;

/**
 * Upper bound for engagement debt scoring in seconds.
 */
export const ENGAGEMENT_DEBT_CAP = 60;

/**
 * Additional score granted to host agents during speaker selection.
 */
export const HOST_ROLE_BONUS = 10;

/**
 * Minimum positive classification threshold for voice activity detection.
 */
export const VAD_POSITIVE_THRESHOLD = 0.5;

/**
 * Minimum number of positive VAD frames required to confirm speech.
 */
export const VAD_MIN_SPEECH_FRAMES = 3;

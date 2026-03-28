/**
 * Canonical LiveKit logger bootstrap for the Murmur agents workspace.
 *
 * LiveKit Agents keeps its logger in global process state and expects callers
 * to initialize it before constructing runtime objects such as VAD streams.
 * Murmur owns that initialization here so feature modules can depend on one
 * canonical setup path instead of repeating ad hoc bootstrap code.
 */

import {
  initializeLogger,
  loggerOptions,
} from "@livekit/agents";

/**
 * Default log level inherited from the agents workspace environment.
 */
const LIVEKIT_LOG_LEVEL = process.env.LOG_LEVEL?.trim() || "info";

/**
 * Ensures the global LiveKit logger has been initialized exactly once.
 */
export function ensureLiveKitLoggerInitialized(): void {
  if (loggerOptions()) {
    return;
  }

  initializeLogger({
    pretty: false,
    level: LIVEKIT_LOG_LEVEL,
  });
}

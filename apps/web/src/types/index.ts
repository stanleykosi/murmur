/**
 * Frontend type surface for the Murmur web application.
 *
 * This module re-exports the shared Murmur domain contracts used across the
 * monorepo and adds the web-specific API and UI types needed by the Next.js
 * client and server components.
 */

export * from "@murmur/shared";

/**
 * Canonical connection states used by realtime frontend hooks and views.
 */
export type ConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

/**
 * Connection retry metadata exposed by the LiveKit room hook.
 *
 * The room UI uses this to distinguish an in-flight connection attempt from a
 * scheduled retry delay, keeping the transport overlay truthful without
 * introducing duplicate retry bookkeeping in the component tree.
 */
export interface LiveKitRetryState {
  phase: "idle" | "waiting" | "connecting" | "failed";
  attempt: number;
  maxAttempts: number;
  nextRetryDelayMs: number | null;
}

/**
 * Minimal authentication contract required by protected frontend API calls.
 *
 * Client and server components can satisfy this either with a Clerk `getToken`
 * function or with a previously resolved session token when a request must be
 * dispatched during unload-safe cleanup.
 */
export interface ApiAuthContext {
  getToken?: () => Promise<string | null>;
  token?: string | null;
}

/**
 * Frontend type surface for the Murmur web application.
 *
 * This module re-exports the shared Murmur domain contracts used across the
 * monorepo and adds the web-specific API and UI types needed by the Next.js
 * client and server components.
 */

import type { AgentSummary, Room } from "@murmur/shared";

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
 * Minimal authentication contract required by protected frontend API calls.
 *
 * Client components can satisfy this with `useAuth().getToken`, while server
 * components can pass through the `getToken` function returned by Clerk's
 * server auth helper.
 */
export interface ApiAuthContext {
  getToken: () => Promise<string | null>;
}

/**
 * Canonical error envelope returned by the Murmur Fastify API.
 */
export interface ApiErrorShape {
  error: {
    code: string;
    message: string;
    statusCode: number;
    requestId: string;
    details?: unknown;
  };
}

/**
 * Response payload returned after a listener joins a room.
 */
export interface JoinRoomResponse {
  room: Room;
  agents: AgentSummary[];
  livekitToken: string;
  centrifugoToken: string;
}

/**
 * Response payload returned after a listener leaves a room.
 */
export interface LeaveRoomResponse {
  roomId: string;
  listenerCount: number;
}

/**
 * Response payload returned after muting or unmuting an agent in a room.
 */
export interface AdminAgentMutationResponse {
  roomId: string;
  agentId: string;
  muted: boolean;
  changed: boolean;
}

/**
 * Response payload returned after ending a room through the admin API.
 */
export interface EndRoomResponse {
  alreadyEnded: boolean;
  room: Room;
}

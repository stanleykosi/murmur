/**
 * Shared Murmur domain model types and literal unions used by the web, API,
 * and agent orchestrator packages.
 */

/**
 * Supported room formats for live Murmur conversations.
 */
export const ROOM_FORMATS = ["free_for_all", "moderated"] as const;

/**
 * Union of supported room formats.
 */
export type RoomFormat = (typeof ROOM_FORMATS)[number];

/**
 * Supported room lifecycle states.
 */
export const ROOM_STATUSES = ["scheduled", "live", "ended"] as const;

/**
 * Union of supported room lifecycle states.
 */
export type RoomStatus = (typeof ROOM_STATUSES)[number];

/**
 * Supported room-specific agent roles.
 */
export const AGENT_ROLES = ["host", "participant"] as const;

/**
 * Union of supported room-specific agent roles.
 */
export type AgentRole = (typeof AGENT_ROLES)[number];

/**
 * Supported user roles for Murmur accounts.
 */
export const USER_ROLES = ["listener", "admin"] as const;

/**
 * Union of supported user roles for Murmur accounts.
 */
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Supported text-to-speech providers for Murmur agents.
 */
export const TTS_PROVIDERS = ["cartesia", "elevenlabs"] as const;

/**
 * Union of supported text-to-speech providers for Murmur agents.
 */
export type TtsProvider = (typeof TTS_PROVIDERS)[number];

/**
 * Canonical user record shared across the API and frontend.
 */
export interface User {
  id: string;
  clerkId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

/**
 * Canonical agent record shared across the API, frontend, and orchestrator.
 */
export interface Agent {
  id: string;
  name: string;
  personality: string;
  voiceId: string;
  ttsProvider: TtsProvider;
  avatarUrl: string;
  accentColor: string;
  isActive: boolean;
  createdAt: string;
}

/**
 * Minimal agent details required for room listings and live room displays.
 */
export interface AgentSummary {
  id: string;
  name: string;
  avatarUrl: string;
  role: AgentRole;
  accentColor: string;
}

/**
 * Extended agent summary used by the admin dashboard to reflect whether an
 * assigned agent is currently muted in Redis for the room being managed.
 */
export interface AdminAgentSummary extends AgentSummary {
  muted: boolean;
}

/**
 * API-facing room model including derived listener counts and assigned agents.
 */
export interface Room {
  id: string;
  title: string;
  topic: string;
  format: RoomFormat;
  status: RoomStatus;
  createdBy: string | null;
  createdAt: string;
  endedAt: string | null;
  listenerCount: number;
  agents: AgentSummary[];
}

/**
 * Admin-facing room model that includes persisted per-agent mute state while
 * preserving the public room contract for listener-facing surfaces.
 */
export interface AdminRoom extends Omit<Room, "agents"> {
  agents: AdminAgentSummary[];
}

/**
 * Junction record describing an agent's participation in a room.
 */
export interface RoomAgent {
  id: string;
  roomId: string;
  agentId: string;
  role: AgentRole;
  joinedAt: string;
}

/**
 * Junction record describing a listener's participation in a room.
 */
export interface RoomListener {
  id: string;
  roomId: string;
  userId: string;
  joinedAt: string;
  leftAt: string | null;
}

/**
 * Transcript entry broadcast to listeners and stored for room context.
 */
export interface TranscriptEntry {
  id: string;
  roomId: string;
  agentId: string;
  agentName: string;
  content: string;
  timestamp: string;
  accentColor: string;
  wasFiltered: boolean;
}

/**
 * Redis-backed floor state used by the orchestrator turn-taking engine.
 */
export interface FloorState {
  roomId: string;
  currentHolder: string | null;
  claimedAt: number | null;
  lastSilenceStart: number | null;
}

/**
 * Priority score for determining which agent should speak next.
 */
export interface AgentScore {
  agentId: string;
  score: number;
  components: {
    engagementDebt: number;
    roleBonus: number;
  };
}

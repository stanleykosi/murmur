import type { AdminRoom, AgentSummary, Room } from "./types.js";

export interface ValidationIssueDetail {
  message: string;
  path: string;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    statusCode: number;
    requestId: string;
    details?: unknown;
  };
}

export interface RoomsListResponse {
  rooms: Room[];
}

export interface RoomDetailsResponse {
  room: Room;
}

export interface AdminRoomsResponse {
  rooms: AdminRoom[];
}

export interface JoinRoomResponse {
  room: Room;
  agents: AgentSummary[];
  livekitToken: string;
  centrifugoToken: string;
}

export interface LeaveRoomResponse {
  roomId: string;
  listenerCount: number;
}

export interface AdminAgentMutationResponse {
  roomId: string;
  agentId: string;
  muted: boolean;
  changed: boolean;
}

export interface EndRoomResponse {
  alreadyEnded: boolean;
  room: Room;
}

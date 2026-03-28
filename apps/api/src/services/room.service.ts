/**
 * Room-domain service layer for the Murmur API.
 *
 * This module owns the canonical room read/write flows used by the Fastify
 * routes: room listing/detail queries, admin room creation, and listener
 * join/leave membership updates. PostgreSQL remains the source of truth for
 * persisted room state, while Redis holds the real-time listener presence set
 * used for fast count lookups.
 */

import type {
  AgentRole,
  AdminAgentSummary,
  AdminRoom,
  AgentSummary,
  Room,
  RoomFormat,
  RoomStatus,
} from "@murmur/shared";
import { getMutedAgentsKey } from "@murmur/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  agents,
  roomAgents,
  roomListeners,
  rooms,
  users,
  type AgentRecord,
  type RoomAgentRecord,
  type RoomRecord,
  type UserRecord,
} from "../db/schema.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { createLogger } from "../lib/logger.js";
import { redis } from "../lib/redis.js";

const roomServiceLogger = createLogger({ component: "room-service" });
const MIN_ROOM_AGENT_COUNT = 2;
const MAX_ROOM_AGENT_COUNT = 3;
const HOST_ASSIGNMENT_COUNT = 1;

/**
 * Room-agent assignment supplied by the room-creation API.
 */
export interface CreateRoomAgentAssignmentInput {
  agentId: string;
  role: AgentRole;
}

/**
 * Input contract for creating a new room and assigning its participating
 * agents.
 */
export interface CreateRoomInput {
  agents: CreateRoomAgentAssignmentInput[];
  createdByClerkUserId: string;
  format: RoomFormat;
  status?: Extract<RoomStatus, "live" | "scheduled">;
  title: string;
  topic: string;
}

/**
 * Response payload returned after a successful leave operation.
 */
export interface LeaveRoomResult {
  listenerCount: number;
  roomId: string;
}

/**
 * Result returned after ending a room through the admin control flow.
 */
export interface EndRoomResult {
  alreadyEnded: boolean;
  room: Room;
}

/**
 * Result returned after a listener join completes successfully.
 *
 * The response includes the updated room payload plus the canonical persisted
 * user ID that downstream real-time transports should use for listener
 * identity. `presenceAdded` reflects whether Redis presence changed during
 * this call so the route layer can compensate safely if later work fails.
 */
export interface JoinRoomResult {
  listenerUserId: string;
  presenceAdded: boolean;
  room: Room;
}

/**
 * Database room record loaded alongside its assigned agent rows.
 */
interface RoomWithAssignedAgents extends RoomRecord {
  assignedAgents: Array<
    RoomAgentRecord & {
      agent: AgentRecord;
    }
  >;
}

/**
 * Builds the canonical Redis listener-set key for a room.
 *
 * @param roomId - Room UUID used to namespace the presence set.
 * @returns The Redis key containing active listener IDs for the room.
 */
export function buildRoomListenersKey(roomId: string): string {
  const normalizedRoomId = roomId.trim();

  if (normalizedRoomId.length === 0) {
    throw new ValidationError("roomId must be a non-empty string.");
  }

  return `room:${normalizedRoomId}:listeners`;
}

/**
 * Enforces the canonical room-agent assignment rules for the MVP.
 *
 * Rooms must contain 2-3 unique agents and exactly one host assignment. The
 * route layer validates request shape, but this service-level guard keeps the
 * business invariant intact for all callers.
 *
 * @param assignments - Requested room-agent assignments.
 * @throws {ValidationError} When the assignments violate Murmur room rules.
 */
export function assertValidRoomAssignments(
  assignments: ReadonlyArray<CreateRoomAgentAssignmentInput>,
): void {
  if (
    assignments.length < MIN_ROOM_AGENT_COUNT ||
    assignments.length > MAX_ROOM_AGENT_COUNT
  ) {
    throw new ValidationError(
      `Rooms must assign between ${MIN_ROOM_AGENT_COUNT} and ${MAX_ROOM_AGENT_COUNT} agents.`,
    );
  }

  const uniqueAgentIds = new Set(assignments.map((assignment) => assignment.agentId));

  if (uniqueAgentIds.size !== assignments.length) {
    throw new ValidationError("Room agent assignments must not contain duplicate agents.");
  }

  const hostCount = assignments.filter(
    (assignment) => assignment.role === "host",
  ).length;

  if (hostCount !== HOST_ASSIGNMENT_COUNT) {
    throw new ValidationError("Rooms must have exactly one host agent.");
  }
}

/**
 * Loads the authenticated user row from PostgreSQL via the Clerk user ID stored
 * in the auth token.
 *
 * Until the webhook sync step is implemented, callers must provision matching
 * `users.clerk_id` rows manually. This intentionally fails fast rather than
 * creating hidden side effects in protected room endpoints.
 *
 * @param clerkUserId - Clerk subject identifier from the verified JWT.
 * @returns The persisted Murmur user row.
 * @throws {ValidationError} When the Clerk user has not been synced locally.
 */
async function getPersistedUserByClerkId(clerkUserId: string): Promise<UserRecord> {
  const userRecord = await db.query.users.findFirst({
    where: eq(users.clerkId, clerkUserId),
  });

  if (!userRecord) {
    throw new ValidationError(
      `Authenticated Clerk user "${clerkUserId}" has not been synced into PostgreSQL yet. Provision the user record first, then retry.`,
    );
  }

  return userRecord;
}

/**
 * Fetches a room with its assigned agents or throws a 404 when it does not
 * exist.
 *
 * @param roomId - Room UUID to load.
 * @returns The persisted room record with nested agent assignments.
 * @throws {NotFoundError} When the room does not exist.
 */
async function getRoomRecordWithAgents(roomId: string): Promise<RoomWithAssignedAgents> {
  const roomRecord = await db.query.rooms.findFirst({
    where: eq(rooms.id, roomId),
    with: {
      assignedAgents: {
        with: {
          agent: true,
        },
      },
    },
  });

  if (!roomRecord) {
    throw new NotFoundError(`Room "${roomId}" was not found.`);
  }

  return roomRecord;
}

/**
 * Converts the nested room-agent relation rows into the shared API-facing agent
 * summary shape.
 *
 * @param assignedAgents - Persisted room-agent relations with nested agents.
 * @returns Stable room agent summaries ordered with the host first.
 */
function mapAssignedAgentsToSummaries(
  assignedAgents: RoomWithAssignedAgents["assignedAgents"],
): AgentSummary[] {
  return assignedAgents
    .map((assignedAgent) => ({
      accentColor: assignedAgent.agent.accentColor,
      avatarUrl: assignedAgent.agent.avatarUrl,
      id: assignedAgent.agent.id,
      name: assignedAgent.agent.name,
      role: assignedAgent.role,
    }))
    .sort((leftAgent, rightAgent) => {
      if (leftAgent.role !== rightAgent.role) {
        return leftAgent.role === "host" ? -1 : 1;
      }

      return leftAgent.name.localeCompare(rightAgent.name);
    });
}

/**
 * Converts the nested room-agent rows into the admin-facing summary shape that
 * includes the persisted muted state sourced from Redis.
 *
 * @param assignedAgents - Persisted room-agent relations with nested agents.
 * @param mutedAgentIds - Agent IDs currently muted for the room.
 * @returns Stable admin agent summaries ordered with the host first.
 */
function mapAssignedAgentsToAdminSummaries(
  assignedAgents: RoomWithAssignedAgents["assignedAgents"],
  mutedAgentIds: ReadonlySet<string>,
): AdminAgentSummary[] {
  return mapAssignedAgentsToSummaries(assignedAgents).map((agentSummary) => ({
    ...agentSummary,
    muted: mutedAgentIds.has(agentSummary.id),
  }));
}

/**
 * Maps a persisted room record into the shared transport shape consumed by the
 * web application.
 *
 * @param roomRecord - Persisted room row with nested agent assignments.
 * @param listenerCount - Real-time active listener count from Redis.
 * @returns The serialized room payload returned by the API.
 */
function mapRoomRecordToRoom(
  roomRecord: RoomWithAssignedAgents,
  listenerCount: number,
): Room {
  return {
    agents: mapAssignedAgentsToSummaries(roomRecord.assignedAgents),
    createdAt: roomRecord.createdAt,
    createdBy: roomRecord.createdBy,
    endedAt: roomRecord.endedAt,
    format: roomRecord.format,
    id: roomRecord.id,
    listenerCount,
    status: roomRecord.status,
    title: roomRecord.title,
    topic: roomRecord.topic,
  };
}

/**
 * Maps a persisted room record into the admin transport shape consumed by the
 * web dashboard.
 *
 * @param roomRecord - Persisted room row with nested agent assignments.
 * @param listenerCount - Real-time active listener count from Redis.
 * @param mutedAgentIds - Set of agent IDs muted for the current room.
 * @returns The serialized admin room payload returned by the API.
 */
function mapRoomRecordToAdminRoom(
  roomRecord: RoomWithAssignedAgents,
  listenerCount: number,
  mutedAgentIds: ReadonlySet<string>,
): AdminRoom {
  return {
    agents: mapAssignedAgentsToAdminSummaries(
      roomRecord.assignedAgents,
      mutedAgentIds,
    ),
    createdAt: roomRecord.createdAt,
    createdBy: roomRecord.createdBy,
    endedAt: roomRecord.endedAt,
    format: roomRecord.format,
    id: roomRecord.id,
    listenerCount,
    status: roomRecord.status,
    title: roomRecord.title,
    topic: roomRecord.topic,
  };
}

/**
 * Reads Redis listener counts for multiple rooms in a single pipeline.
 *
 * @param roomIds - Room IDs whose listener counts should be resolved.
 * @returns A lookup of room ID to active listener count.
 */
async function getListenerCountsByRoomId(
  roomIds: ReadonlyArray<string>,
): Promise<Map<string, number>> {
  if (roomIds.length === 0) {
    return new Map<string, number>();
  }

  const pipeline = redis.pipeline();

  for (const roomId of roomIds) {
    pipeline.scard(buildRoomListenersKey(roomId));
  }

  const results = await pipeline.exec();

  if (results === null) {
    throw new Error("Redis pipeline for room listener counts returned no results.");
  }

  return roomIds.reduce((countsByRoomId, roomId, index) => {
    const result = results[index];

    if (!result) {
      throw new Error(`Redis did not return a listener count for room "${roomId}".`);
    }

    const [error, count] = result;

    if (error) {
      throw error;
    }

    if (typeof count !== "number") {
      throw new Error(
        `Redis returned an unexpected listener count for room "${roomId}".`,
      );
    }

    countsByRoomId.set(roomId, count);
    return countsByRoomId;
  }, new Map<string, number>());
}

/**
 * Resolves muted-agent membership for multiple rooms in one Redis pipeline so
 * the admin dashboard can render truthful mute state after refresh.
 *
 * @param roomIds - Room IDs whose muted-agent sets should be loaded.
 * @returns A lookup of room ID to muted agent ID set.
 */
async function getMutedAgentIdsByRoomId(
  roomIds: ReadonlyArray<string>,
): Promise<Map<string, Set<string>>> {
  if (roomIds.length === 0) {
    return new Map<string, Set<string>>();
  }

  const pipeline = redis.pipeline();

  for (const roomId of roomIds) {
    pipeline.smembers(getMutedAgentsKey(roomId));
  }

  const results = await pipeline.exec();

  if (results === null) {
    throw new Error("Redis pipeline for muted-agent lookups returned no results.");
  }

  return roomIds.reduce((mutedByRoomId, roomId, index) => {
    const result = results[index];

    if (!result) {
      throw new Error(`Redis did not return a muted-agent set for room "${roomId}".`);
    }

    const [error, members] = result;

    if (error) {
      throw error;
    }

    if (!Array.isArray(members) || !members.every((member) => typeof member === "string")) {
      throw new Error(
        `Redis returned an unexpected muted-agent payload for room "${roomId}".`,
      );
    }

    mutedByRoomId.set(roomId, new Set(members));
    return mutedByRoomId;
  }, new Map<string, Set<string>>());
}

/**
 * Loads the persisted room rows used by both the public and admin room-listing
 * flows so their ordering and database projection stay aligned.
 *
 * @param status - Optional room-status filter.
 * @returns The matching rooms ordered by creation time descending.
 */
async function getRoomRecordsWithAssignedAgents(
  status?: RoomStatus,
): Promise<RoomWithAssignedAgents[]> {
  return db.query.rooms.findMany({
    orderBy: (roomTable, { desc }) => [desc(roomTable.createdAt)],
    where:
      status === undefined
        ? undefined
        : eq(rooms.status, status),
    with: {
      assignedAgents: {
        with: {
          agent: true,
        },
      },
    },
  });
}

/**
 * Ensures all requested agent assignments point at existing active agents.
 *
 * @param assignments - Requested room-agent assignments.
 * @throws {NotFoundError} When one or more agent IDs do not exist.
 * @throws {ValidationError} When one or more agents are inactive.
 */
async function assertAgentsExistAndAreActive(
  assignments: ReadonlyArray<CreateRoomAgentAssignmentInput>,
): Promise<void> {
  const requestedAgentIds = assignments.map((assignment) => assignment.agentId);
  const persistedAgents = await db
    .select({
      id: agents.id,
      isActive: agents.isActive,
    })
    .from(agents)
    .where(inArray(agents.id, requestedAgentIds));

  const persistedAgentsById = new Map(
    persistedAgents.map((agentRecord) => [agentRecord.id, agentRecord]),
  );
  const missingAgentIds: string[] = [];
  const inactiveAgentIds: string[] = [];

  for (const requestedAgentId of requestedAgentIds) {
    const persistedAgent = persistedAgentsById.get(requestedAgentId);

    if (!persistedAgent) {
      missingAgentIds.push(requestedAgentId);
      continue;
    }

    if (!persistedAgent.isActive) {
      inactiveAgentIds.push(requestedAgentId);
    }
  }

  if (missingAgentIds.length > 0) {
    throw new NotFoundError(
      `These agent IDs were not found: ${missingAgentIds.join(", ")}.`,
    );
  }

  if (inactiveAgentIds.length > 0) {
    throw new ValidationError(
      `These agents are inactive and cannot be assigned to a room: ${inactiveAgentIds.join(", ")}.`,
    );
  }
}

/**
 * Ensures a room exists and is currently live before a listener join flow
 * proceeds.
 *
 * @param roomId - Room UUID to validate.
 * @returns The persisted room row.
 * @throws {NotFoundError} When the room does not exist.
 * @throws {ValidationError} When the room is not live.
 */
async function getJoinableRoom(roomId: string): Promise<RoomRecord> {
  const roomRecord = await db.query.rooms.findFirst({
    where: eq(rooms.id, roomId),
  });

  if (!roomRecord) {
    throw new NotFoundError(`Room "${roomId}" was not found.`);
  }

  if (roomRecord.status !== "live") {
    throw new ValidationError(
      `Room "${roomId}" is ${roomRecord.status} and cannot be joined.`,
    );
  }

  return roomRecord;
}

/**
 * Lists rooms with their assigned agents and real-time listener counts.
 *
 * @param status - Optional room-status filter.
 * @returns The matching rooms ordered by most recent creation time first.
 */
export async function listRooms(status?: RoomStatus): Promise<Room[]> {
  const roomRecords = await getRoomRecordsWithAssignedAgents(status);
  const listenerCountsByRoomId = await getListenerCountsByRoomId(
    roomRecords.map((roomRecord) => roomRecord.id),
  );

  return roomRecords.map((roomRecord) =>
    mapRoomRecordToRoom(
      roomRecord,
      listenerCountsByRoomId.get(roomRecord.id) ?? 0,
    ),
  );
}

/**
 * Lists rooms for the admin dashboard with real-time listener counts and
 * persisted per-agent mute state.
 *
 * @returns The matching admin room payloads ordered by most recent creation
 * time first.
 */
export async function listAdminRooms(): Promise<AdminRoom[]> {
  const roomRecords = await getRoomRecordsWithAssignedAgents();
  const roomIds = roomRecords.map((roomRecord) => roomRecord.id);
  const [listenerCountsByRoomId, mutedAgentIdsByRoomId] = await Promise.all([
    getListenerCountsByRoomId(roomIds),
    getMutedAgentIdsByRoomId(roomIds),
  ]);

  return roomRecords.map((roomRecord) =>
    mapRoomRecordToAdminRoom(
      roomRecord,
      listenerCountsByRoomId.get(roomRecord.id) ?? 0,
      mutedAgentIdsByRoomId.get(roomRecord.id) ?? new Set<string>(),
    ),
  );
}

/**
 * Loads a single room with its assigned agents and current listener count.
 *
 * @param roomId - Room UUID to load.
 * @returns The requested room.
 * @throws {NotFoundError} When the room does not exist.
 */
export async function getRoomById(roomId: string): Promise<Room> {
  const roomRecord = await getRoomRecordWithAgents(roomId);
  const listenerCount = await getListenerCount(roomId);

  return mapRoomRecordToRoom(roomRecord, listenerCount);
}

/**
 * Creates a new room and persists its agent assignments in a single database
 * transaction.
 *
 * @param input - Validated room-creation payload plus the authenticated Clerk
 * user ID of the admin creating the room.
 * @returns The newly created room with its assigned agents.
 */
export async function createRoom(input: CreateRoomInput): Promise<Room> {
  assertValidRoomAssignments(input.agents);
  await assertAgentsExistAndAreActive(input.agents);

  const creator = await getPersistedUserByClerkId(input.createdByClerkUserId);
  const persistedRoom = await db.transaction(async (transaction) => {
    const [createdRoom] = await transaction
      .insert(rooms)
      .values({
        createdBy: creator.id,
        format: input.format,
        status: input.status ?? "live",
        title: input.title,
        topic: input.topic,
      })
      .returning();

    if (!createdRoom) {
      throw new Error("Creating a room did not return a persisted row.");
    }

    await transaction.insert(roomAgents).values(
      input.agents.map((assignment) => ({
        agentId: assignment.agentId,
        role: assignment.role,
        roomId: createdRoom.id,
      })),
    );

    return createdRoom;
  });

  return getRoomById(persistedRoom.id);
}

/**
 * Marks a room as ended while preserving the original `endedAt` timestamp on
 * retries.
 *
 * The data mutation is intentionally idempotent so admin operators can retry
 * later cleanup steps if LiveKit teardown or event publishing fails after the
 * room status has already been persisted.
 *
 * @param roomId - Room UUID to end.
 * @returns The ended room payload plus an idempotency flag.
 * @throws {NotFoundError} When the room does not exist.
 */
export async function endRoom(roomId: string): Promise<EndRoomResult> {
  const roomRecord = await getRoomRecordWithAgents(roomId);

  if (roomRecord.status === "ended") {
    return {
      alreadyEnded: true,
      room: mapRoomRecordToRoom(roomRecord, await getListenerCount(roomId)),
    };
  }

  const endedAt = new Date().toISOString();
  const [updatedRoom] = await db
    .update(rooms)
    .set({
      endedAt,
      status: "ended",
    })
    .where(eq(rooms.id, roomId))
    .returning({
      id: rooms.id,
    });

  if (!updatedRoom) {
    throw new Error(`Ending room "${roomId}" did not return an updated row.`);
  }

  return {
    alreadyEnded: false,
    room: await getRoomById(roomId),
  };
}

/**
 * Reads the active listener count for a room from Redis.
 *
 * @param roomId - Room UUID whose presence set should be counted.
 * @returns The number of active listeners tracked in Redis.
 */
export async function getListenerCount(roomId: string): Promise<number> {
  return redis.scard(buildRoomListenersKey(roomId));
}

/**
 * Joins a listener to a room by updating Redis presence and the canonical
 * `room_listeners` row.
 *
 * Redis is updated first so the listener count becomes visible immediately.
 * If the PostgreSQL write fails afterwards, the method compensates by removing
 * the listener from Redis again unless the user was already present.
 *
 * @param roomId - Room UUID being joined.
 * @param clerkUserId - Authenticated Clerk user ID from the request context.
 * @returns The joined room plus the persisted listener identity used by
 * downstream token-generation flows.
 */
export async function joinRoom(
  roomId: string,
  clerkUserId: string,
): Promise<JoinRoomResult> {
  await getJoinableRoom(roomId);

  const userRecord = await getPersistedUserByClerkId(clerkUserId);
  const listenerKey = buildRoomListenersKey(roomId);
  const joinedAt = new Date().toISOString();
  const redisAddCount = await redis.sadd(listenerKey, userRecord.id);

  try {
    await db
      .insert(roomListeners)
      .values({
        joinedAt,
        leftAt: null,
        roomId,
        userId: userRecord.id,
      })
      .onConflictDoUpdate({
        target: [roomListeners.roomId, roomListeners.userId],
        set: {
          joinedAt,
          leftAt: null,
        },
      });

    return {
      listenerUserId: userRecord.id,
      presenceAdded: redisAddCount === 1,
      room: await getRoomById(roomId),
    };
  } catch (error) {
    if (redisAddCount === 1) {
      try {
        await redis.srem(listenerKey, userRecord.id);
      } catch (rollbackError) {
        roomServiceLogger.error(
          {
            clerkUserId,
            err: rollbackError,
            roomId,
            userId: userRecord.id,
          },
          "Failed to roll back Redis listener membership after join-room persistence failure.",
        );
      }
    }

    throw error;
  }
}

/**
 * Removes a listener from a room in Redis and marks the listener session as
 * left in PostgreSQL.
 *
 * If the database update fails after Redis membership has been removed, the
 * method re-adds the listener to Redis to preserve consistency. Leaving a room
 * that the user is not actively joined to is treated as a client error so the
 * caller can repair its state explicitly.
 *
 * @param roomId - Room UUID being left.
 * @param clerkUserId - Authenticated Clerk user ID from the request context.
 * @returns The room ID and updated listener count.
 */
export async function leaveRoom(
  roomId: string,
  clerkUserId: string,
): Promise<LeaveRoomResult> {
  await getRoomRecordWithAgents(roomId);

  const userRecord = await getPersistedUserByClerkId(clerkUserId);
  const listenerKey = buildRoomListenersKey(roomId);
  const leftAt = new Date().toISOString();
  const redisRemoveCount = await redis.srem(listenerKey, userRecord.id);

  try {
    const [updatedListener] = await db
      .update(roomListeners)
      .set({
        leftAt,
      })
      .where(
        and(
          eq(roomListeners.roomId, roomId),
          eq(roomListeners.userId, userRecord.id),
          isNull(roomListeners.leftAt),
        ),
      )
      .returning({
        id: roomListeners.id,
      });

    if (!updatedListener) {
      throw new ValidationError(
        `Listener "${userRecord.id}" is not currently joined to room "${roomId}".`,
      );
    }

    const listenerCount = await getListenerCount(roomId);

    return {
      listenerCount,
      roomId,
    };
  } catch (error) {
    if (redisRemoveCount === 1) {
      try {
        await redis.sadd(listenerKey, userRecord.id);
      } catch (rollbackError) {
        roomServiceLogger.error(
          {
            clerkUserId,
            err: rollbackError,
            roomId,
            userId: userRecord.id,
          },
          "Failed to restore Redis listener membership after leave-room persistence failure.",
        );
      }
    }

    throw error;
  }
}

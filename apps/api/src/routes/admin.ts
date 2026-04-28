/**
 * Fastify admin routes for the Murmur API.
 *
 * This plugin exposes the canonical admin control surface for room management:
 * listing all rooms, muting or unmuting assigned agents, and ending rooms with
 * Redis cleanup, LiveKit teardown, and Centrifugo notification.
 */

import {
  getAgentLastSpokeKey,
  getFloorStateKey,
  getMutedAgentsKey,
  getRoomSilenceKey,
} from "@murmur/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { AppError, ValidationError } from "../lib/errors.js";
import { parseWithSchema } from "../lib/validation.js";
import { adminPreHandler } from "../middleware/admin.js";
import { authPreHandler } from "../middleware/auth.js";
import { redis } from "../lib/redis.js";
import { publishRoomEnded } from "../services/centrifugo.service.js";
import { deleteRoom as deleteLiveKitRoom } from "../services/livekit.service.js";
import { endRoom, getRoomById, listAdminRooms } from "../services/room.service.js";

const ROOM_END_CLEANUP_ERROR_CODE = "room_end_cleanup_failed";

const roomIdParamsSchema = z
  .object({
    roomId: z.string().uuid("Room id must be a valid UUID."),
  })
  .strict();

const roomAgentParamsSchema = z
  .object({
    agentId: z.string().uuid("Agent id must be a valid UUID."),
    roomId: z.string().uuid("Room id must be a valid UUID."),
  })
  .strict();

type RoomEndCleanupStep = "listener_notification" | "livekit_teardown";

/**
 * Builds the explicit 500 error returned when downstream end-room cleanup only
 * partially succeeds.
 *
 * @param roomId - Room UUID whose cleanup failed.
 * @param failedSteps - Cleanup steps that did not complete successfully.
 * @param causes - Underlying thrown errors for diagnostics.
 * @returns An exposed application error with retry guidance.
 */
function buildRoomEndCleanupError(
  roomId: string,
  failedSteps: ReadonlyArray<RoomEndCleanupStep>,
  causes: ReadonlyArray<unknown>,
): AppError {
  const message =
    failedSteps.length === 2
      ? "Room ended, but LiveKit teardown and listener notification failed. Retry the end-room request to finish cleanup."
      : failedSteps[0] === "livekit_teardown"
        ? "Room ended and listeners were notified, but LiveKit teardown failed. Retry the end-room request to finish cleanup."
        : "Room ended, but notifying listeners failed. Retry the end-room request to finish cleanup.";

  return new AppError(message, {
    cause:
      causes.length === 1
        ? causes[0]
        : new AggregateError(causes, message),
    code: ROOM_END_CLEANUP_ERROR_CODE,
    details: {
      failedSteps,
      roomId,
    },
    expose: true,
    statusCode: 500,
  });
}

/**
 * Ensures a room is live and that the targeted agent is assigned to it.
 *
 * @param roomId - Room UUID being managed.
 * @param agentId - Agent UUID being targeted.
 * @throws {ValidationError} When the room is not live or the agent is unassigned.
 */
async function assertLiveRoomHasAssignedAgent(
  roomId: string,
  agentId: string,
): Promise<void> {
  const room = await getRoomById(roomId);

  if (room.status !== "live") {
    throw new ValidationError(
      `Room "${roomId}" is ${room.status} and cannot accept mute controls.`,
    );
  }

  if (!room.agents.some((agent) => agent.id === agentId)) {
    throw new ValidationError(
      `Agent "${agentId}" is not assigned to room "${roomId}".`,
    );
  }
}

/**
 * Clears Redis runtime keys associated with a room after it is ended.
 *
 * @param roomId - Room UUID whose transient runtime state should be removed.
 * @param agentIds - Agent UUIDs assigned to the room, used to delete per-agent keys.
 */
async function clearRoomRuntimeKeys(
  roomId: string,
  agentIds: ReadonlyArray<string>,
): Promise<void> {
  const keysToDelete = [
    `room:${roomId}:listeners`,
    getMutedAgentsKey(roomId),
    getFloorStateKey(roomId),
    getRoomSilenceKey(roomId),
    ...agentIds.map((agentId) => getAgentLastSpokeKey(roomId, agentId)),
  ];

  await redis.del(...keysToDelete);
}

/**
 * Runs the downstream transport cleanup for an ended room, ensuring the
 * listener notification is attempted even if LiveKit teardown fails.
 *
 * @param roomId - Room UUID whose transport state should be finalized.
 * @throws {AppError} When one or more downstream cleanup steps fail.
 */
async function finalizeEndedRoom(roomId: string): Promise<void> {
  const [liveKitTeardownResult, listenerNotificationResult] =
    await Promise.allSettled([
      deleteLiveKitRoom(roomId),
      publishRoomEnded(roomId),
    ]);
  const failedSteps: RoomEndCleanupStep[] = [];
  const causes: unknown[] = [];

  if (liveKitTeardownResult.status === "rejected") {
    failedSteps.push("livekit_teardown");
    causes.push(liveKitTeardownResult.reason);
  }

  if (listenerNotificationResult.status === "rejected") {
    failedSteps.push("listener_notification");
    causes.push(listenerNotificationResult.reason);
  }

  if (failedSteps.length > 0) {
    throw buildRoomEndCleanupError(roomId, failedSteps, causes);
  }
}

/**
 * Fastify route plugin exposing `/api/admin` endpoints.
 */
export const adminRoutes: FastifyPluginAsync = async (app) => {
  const adminPreHandlers = [authPreHandler, adminPreHandler];

  app.get(
    "/rooms",
    {
      preHandler: adminPreHandlers,
    },
    async () => ({
      rooms: await listAdminRooms(),
    }),
  );

  app.post(
    "/rooms/:roomId/agents/:agentId/mute",
    {
      preHandler: adminPreHandlers,
    },
    async (request) => {
      const params = parseWithSchema(
        roomAgentParamsSchema,
        request.params,
        "Invalid admin mute request parameters.",
      );

      await assertLiveRoomHasAssignedAgent(params.roomId, params.agentId);

      const changed = await redis.sadd(
        getMutedAgentsKey(params.roomId),
        params.agentId,
      );

      return {
        agentId: params.agentId,
        changed: changed === 1,
        muted: true,
        roomId: params.roomId,
      };
    },
  );

  app.post(
    "/rooms/:roomId/agents/:agentId/unmute",
    {
      preHandler: adminPreHandlers,
    },
    async (request) => {
      const params = parseWithSchema(
        roomAgentParamsSchema,
        request.params,
        "Invalid admin unmute request parameters.",
      );

      await assertLiveRoomHasAssignedAgent(params.roomId, params.agentId);

      const changed = await redis.srem(
        getMutedAgentsKey(params.roomId),
        params.agentId,
      );

      return {
        agentId: params.agentId,
        changed: changed === 1,
        muted: false,
        roomId: params.roomId,
      };
    },
  );

  app.post(
    "/rooms/:roomId/end",
    {
      preHandler: adminPreHandlers,
    },
    async (request) => {
      const params = parseWithSchema(
        roomIdParamsSchema,
        request.params,
        "Invalid admin end-room request parameters.",
      );
      const endResult = await endRoom(params.roomId);

      await clearRoomRuntimeKeys(
        endResult.room.id,
        endResult.room.agents.map((agent) => agent.id),
      );
      await finalizeEndedRoom(endResult.room.id);

      return {
        alreadyEnded: endResult.alreadyEnded,
        room: await getRoomById(endResult.room.id),
      };
    },
  );
};

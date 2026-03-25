/**
 * Fastify room routes for the Murmur API.
 *
 * This plugin exposes the canonical room-management endpoints used by the web
 * lobby and live-room flows: listing rooms, reading room details, creating
 * rooms as an admin, and joining or leaving as an authenticated listener.
 */

import type { Room, RoomStatus } from "@murmur/shared";
import {
  AGENT_ROLES,
  ROOM_FORMATS,
  ROOM_STATUSES,
} from "@murmur/shared";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z, type ZodType } from "zod";

import {
  adminPreHandler,
  assertAuthenticatedRequest,
} from "../middleware/admin.js";
import { createClientToken } from "../services/centrifugo.service.js";
import { createListenerToken } from "../services/livekit.service.js";
import { authPreHandler } from "../middleware/auth.js";
import { UnauthorizedError, ValidationError } from "../lib/errors.js";
import {
  createRoom,
  getRoomById,
  joinRoom,
  leaveRoom,
  listRooms,
} from "../services/room.service.js";

const CREATEABLE_ROOM_STATUSES = ["live", "scheduled"] as const;

const roomIdParamsSchema = z
  .object({
    id: z.string().uuid("Room id must be a valid UUID."),
  })
  .strict();

const listRoomsQuerySchema = z
  .object({
    status: z.enum(ROOM_STATUSES).optional(),
  })
  .strict();

const createRoomAgentSchema = z
  .object({
    agentId: z.string().uuid("Agent id must be a valid UUID."),
    role: z.enum(AGENT_ROLES),
  })
  .strict();

const createRoomBodySchema = z
  .object({
    agents: z.array(createRoomAgentSchema).min(2).max(3),
    format: z.enum(ROOM_FORMATS),
    status: z.enum(CREATEABLE_ROOM_STATUSES).default("live"),
    title: z
      .string()
      .trim()
      .min(1, "Room title is required.")
      .max(200, "Room title must be 200 characters or fewer."),
    topic: z
      .string()
      .trim()
      .min(1, "Room topic is required."),
  })
  .strict();

/**
 * Serializes Zod issues into a stable payload shape for API error responses.
 *
 * @param issues - Validation issues emitted by Zod.
 * @returns Flat issue objects containing path and message details.
 */
function mapZodIssues(
  issues: ReadonlyArray<z.ZodIssue>,
): Array<{ message: string; path: string }> {
  return issues.map((issue) => ({
    message: issue.message,
    path: issue.path.join("."),
  }));
}

/**
 * Parses untyped request input with Zod and converts failures into the API's
 * canonical validation error class.
 *
 * @param schema - Zod schema describing the expected request shape.
 * @param input - Raw request input to validate.
 * @param message - Client-facing validation failure message.
 * @returns The parsed and strongly typed input value.
 * @throws {ValidationError} When the payload does not match the schema.
 */
function parseWithSchema<T>(schema: ZodType<T>, input: unknown, message: string): T {
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    throw new ValidationError(message, mapZodIssues(parsed.error.issues));
  }

  return parsed.data;
}

/**
 * Returns the authenticated Clerk user ID attached by the auth middleware.
 *
 * @param request - Fastify request expected to have already passed auth.
 * @returns The authenticated Clerk user ID.
 * @throws {UnauthorizedError} When auth context is missing unexpectedly.
 */
function getAuthenticatedClerkUserId(request: FastifyRequest): string {
  if (request.userId === null) {
    throw new UnauthorizedError(
      "Authentication context is missing. Re-run the auth middleware before handling this route.",
    );
  }

  return request.userId;
}

/**
 * Join response returned to the web client before it connects to LiveKit and
 * Centrifugo.
 */
interface JoinRoomResponse {
  agents: Room["agents"];
  centrifugoToken: string;
  livekitToken: string;
  room: Room;
}

/**
 * Completes the canonical listener room-join handshake.
 *
 * The room membership is persisted first so the response includes the updated
 * listener count. If token generation fails afterwards, the route compensates
 * only when this request introduced a new Redis presence entry; existing room
 * memberships are left untouched so retries do not eject already-joined users.
 *
 * @param request - Fastify request used for structured rollback logging.
 * @param roomId - Murmur room identifier being joined.
 * @param clerkUserId - Authenticated Clerk user ID from the request context.
 * @returns The room payload plus transport tokens required by the web client.
 */
async function completeJoinRoomFlow(
  request: FastifyRequest,
  roomId: string,
  clerkUserId: string,
): Promise<JoinRoomResponse> {
  const joinResult = await joinRoom(roomId, clerkUserId);

  try {
    const livekitToken = await createListenerToken(
      roomId,
      joinResult.listenerUserId,
    );
    const centrifugoToken = createClientToken(joinResult.listenerUserId);

    return {
      agents: joinResult.room.agents,
      centrifugoToken,
      livekitToken,
      room: joinResult.room,
    };
  } catch (error) {
    if (joinResult.presenceAdded) {
      try {
        await leaveRoom(roomId, clerkUserId);
      } catch (rollbackError) {
        request.log.error(
          {
            clerkUserId,
            err: rollbackError,
            roomId,
          },
          "Failed to roll back room membership after token generation failed.",
        );
      }
    }

    throw error;
  }
}

/**
 * Fastify route plugin exposing `/api/rooms` endpoints.
 */
export const roomsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async (request) => {
    const query = parseWithSchema(
      listRoomsQuerySchema,
      request.query,
      "Invalid room list query parameters.",
    );
    const rooms = await listRooms(query.status as RoomStatus | undefined);

    return {
      rooms,
    };
  });

  app.get("/:id", async (request) => {
    const params = parseWithSchema(
      roomIdParamsSchema,
      request.params,
      "Invalid room id.",
    );
    const room = await getRoomById(params.id);

    return {
      room,
    };
  });

  app.post(
    "/",
    {
      preHandler: [authPreHandler, adminPreHandler],
    },
    async (request) => {
      assertAuthenticatedRequest(request);

      const body = parseWithSchema(
        createRoomBodySchema,
        request.body,
        "Invalid room creation payload.",
      );
      const room = await createRoom({
        agents: body.agents,
        createdByClerkUserId: request.userId,
        format: body.format,
        status: body.status ?? "live",
        title: body.title,
        topic: body.topic,
      });

      return {
        room,
      };
    },
  );

  app.post(
    "/:id/join",
    {
      preHandler: authPreHandler,
    },
    async (request) => {
      const params = parseWithSchema(
        roomIdParamsSchema,
        request.params,
        "Invalid room id.",
      );
      const joinResponse = await completeJoinRoomFlow(
        request,
        params.id,
        getAuthenticatedClerkUserId(request),
      );

      return joinResponse;
    },
  );

  app.post(
    "/:id/leave",
    {
      preHandler: authPreHandler,
    },
    async (request) => {
      const params = parseWithSchema(
        roomIdParamsSchema,
        request.params,
        "Invalid room id.",
      );
      const result = await leaveRoom(
        params.id,
        getAuthenticatedClerkUserId(request),
      );

      return result;
    },
  );
};

export default roomsRoutes;

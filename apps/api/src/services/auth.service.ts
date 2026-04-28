/**
 * Clerk user-sync service for the Murmur API.
 *
 * This module owns the canonical mapping from Clerk webhook payloads into the
 * local `users` table so authentication, authorization, and listener identity
 * all rely on one synchronized source of truth.
 */

import { USER_ROLES, type User, type UserRole } from "@murmur/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { UserJSON } from "@clerk/backend";

import { db } from "../db/client.js";
import { roomListeners, rooms, users, type UserRecord } from "../db/schema.js";
import { ValidationError } from "../lib/errors.js";
import { redis } from "../lib/redis.js";

/**
 * Normalized user payload derived from a Clerk webhook event.
 */
export interface ClerkUserSyncInput {
  avatarUrl: string | null;
  clerkId: string;
  displayName: string;
  email: string;
  role: UserRole;
}

/**
 * Maps a persisted user row into the shared transport shape.
 *
 * @param userRecord - Persisted user row from PostgreSQL.
 * @returns The shared Murmur user payload.
 */
function mapUserRecordToUser(userRecord: UserRecord): User {
  return {
    avatarUrl: userRecord.avatarUrl,
    clerkId: userRecord.clerkId,
    createdAt: userRecord.createdAt,
    displayName: userRecord.displayName,
    email: userRecord.email,
    id: userRecord.id,
    role: userRecord.role,
    updatedAt: userRecord.updatedAt,
  };
}

/**
 * Validates and trims a required secret or identifier string.
 *
 * @param value - Candidate string value supplied by the caller.
 * @param label - Human-readable field label for error messages.
 * @returns The trimmed non-empty string value.
 * @throws {ValidationError} When the string is blank after trimming.
 */
function normalizeRequiredString(value: string, label: string): string {
  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new ValidationError(`${label} cannot be empty.`);
  }

  return normalizedValue;
}

/**
 * Builds the canonical Redis listener-set key for a room.
 *
 * @param roomId - Room UUID used to namespace the presence set.
 * @returns The Redis key storing listener presence for the room.
 */
function buildRoomListenersKey(roomId: string): string {
  return `room:${roomId}:listeners`;
}

/**
 * Extracts the canonical primary user email from a Clerk webhook payload.
 *
 * @param user - Clerk webhook user payload.
 * @returns The normalized primary email address.
 * @throws {ValidationError} When no usable primary email address is present.
 */
function getPrimaryEmail(user: UserJSON): string {
  const primaryEmail = user.primary_email_address_id
    ? user.email_addresses.find(
        (emailAddress) => emailAddress.id === user.primary_email_address_id,
      )?.email_address
    : undefined;

  if (primaryEmail === undefined) {
    throw new ValidationError(
      `Clerk user "${user.id}" does not include a primary email address.`,
    );
  }

  return normalizeRequiredString(primaryEmail, "email");
}

/**
 * Derives the canonical Murmur display name from Clerk profile fields.
 *
 * @param user - Clerk webhook user payload.
 * @param email - Preferred user email, used as the final fallback.
 * @returns The normalized display name Murmur should persist.
 */
function deriveDisplayName(user: UserJSON, email: string): string {
  const fullName = [user.first_name, user.last_name]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0)
    .join(" ");

  if (fullName.length > 0) {
    return fullName;
  }

  if (typeof user.username === "string" && user.username.trim().length > 0) {
    return user.username.trim();
  }

  const [emailLocalPart] = email.split("@");

  return emailLocalPart?.trim().length
    ? emailLocalPart.trim()
    : email;
}

/**
 * Extracts the canonical Murmur role from Clerk public metadata.
 *
 * Missing role metadata defaults to `listener`. If a role key is present but
 * does not match Murmur's supported role union, the sync fails fast so the
 * upstream Clerk configuration can be corrected explicitly.
 *
 * @param user - Clerk webhook user payload.
 * @returns The normalized Murmur role.
 * @throws {ValidationError} When a `role` key exists but is invalid.
 */
function deriveUserRole(user: UserJSON): UserRole {
  const rawRole = user.public_metadata?.role;

  if (rawRole === undefined || rawRole === null) {
    return "listener";
  }

  if (typeof rawRole !== "string") {
    throw new ValidationError(
      `Clerk user "${user.id}" has a non-string public_metadata.role value.`,
    );
  }

  if (!USER_ROLES.includes(rawRole as UserRole)) {
    throw new ValidationError(
      `Clerk user "${user.id}" has an unsupported role "${rawRole}".`,
    );
  }

  return rawRole as UserRole;
}

/**
 * Normalizes a Clerk webhook user payload into Murmur's sync contract.
 *
 * @param user - Clerk webhook user payload.
 * @returns A deterministic payload ready for persistence.
 */
export function normalizeClerkUserSyncInput(
  user: UserJSON,
): ClerkUserSyncInput {
  const clerkId = normalizeRequiredString(user.id, "clerkId");
  const email = getPrimaryEmail(user);

  return {
    avatarUrl:
      typeof user.image_url === "string" && user.image_url.trim().length > 0
        ? user.image_url.trim()
        : null,
    clerkId,
    displayName: deriveDisplayName(user, email),
    email,
    role: deriveUserRole(user),
  };
}

/**
 * Upserts a Clerk user into the local Murmur `users` table.
 *
 * @param user - Clerk webhook user payload.
 * @returns The persisted Murmur user row in shared transport shape.
 */
export async function upsertUser(user: UserJSON): Promise<User> {
  const normalizedUser = normalizeClerkUserSyncInput(user);
  const updatedAt = new Date().toISOString();

  const [persistedUser] = await db
    .insert(users)
    .values({
      avatarUrl: normalizedUser.avatarUrl,
      clerkId: normalizedUser.clerkId,
      displayName: normalizedUser.displayName,
      email: normalizedUser.email,
      role: normalizedUser.role,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: users.clerkId,
      set: {
        avatarUrl: normalizedUser.avatarUrl,
        displayName: normalizedUser.displayName,
        email: normalizedUser.email,
        role: normalizedUser.role,
        updatedAt,
      },
    })
    .returning();

  if (!persistedUser) {
    throw new Error(
      `Upserting Clerk user "${normalizedUser.clerkId}" did not return a persisted row.`,
    );
  }

  return mapUserRecordToUser(persistedUser);
}

/**
 * Re-adds a user's listener presence to the supplied rooms after a failed
 * delete flow so Redis and PostgreSQL stay aligned.
 *
 * @param userId - Persisted Murmur user identifier stored in Redis presence sets.
 * @param roomIds - Room IDs whose presence sets should be restored.
 */
async function restoreUserRoomPresence(
  userId: string,
  roomIds: ReadonlyArray<string>,
): Promise<void> {
  for (const roomId of roomIds) {
    await redis.sadd(buildRoomListenersKey(roomId), userId);
  }
}

/**
 * Removes a user's active listener presence from Redis before their local user
 * row is deleted.
 *
 * @param userId - Persisted Murmur user identifier stored in Redis presence sets.
 * @returns Room IDs whose Redis presence membership was actually removed.
 */
async function removeUserFromActiveRoomPresence(userId: string): Promise<string[]> {
  const activeListenerSessions = await db.query.roomListeners.findMany({
    columns: {
      roomId: true,
    },
    where: and(
      eq(roomListeners.userId, userId),
      isNull(roomListeners.leftAt),
    ),
  });
  const removedRoomIds: string[] = [];

  try {
    for (const session of activeListenerSessions) {
      const removedCount = await redis.srem(
        buildRoomListenersKey(session.roomId),
        userId,
      );

      if (removedCount === 1) {
        removedRoomIds.push(session.roomId);
      }
    }
  } catch (error) {
    try {
      await restoreUserRoomPresence(userId, removedRoomIds);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Failed to remove Redis room presence for user "${userId}".`,
      );
    }

    throw error;
  }

  return removedRoomIds;
}

/**
 * Deletes a synced Murmur user after detaching rooms they created.
 *
 * Repeated delete webhooks are treated as a no-op when the local user row has
 * already been removed.
 *
 * @param clerkId - Clerk user identifier from the webhook payload.
 */
export async function deleteUser(clerkId: string): Promise<void> {
  const normalizedClerkId = normalizeRequiredString(clerkId, "clerkId");
  const existingUser = await db.query.users.findFirst({
    where: eq(users.clerkId, normalizedClerkId),
  });

  if (!existingUser) {
    return;
  }

  const removedPresenceRoomIds = await removeUserFromActiveRoomPresence(
    existingUser.id,
  );

  try {
    await db.transaction(async (transaction) => {
      await transaction
        .update(rooms)
        .set({
          createdBy: null,
        })
        .where(eq(rooms.createdBy, existingUser.id));

      await transaction.delete(users).where(eq(users.id, existingUser.id));
    });
  } catch (error) {
    try {
      await restoreUserRoomPresence(existingUser.id, removedPresenceRoomIds);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Deleting Clerk user "${normalizedClerkId}" failed after Redis presence was removed.`,
      );
    }

    throw error;
  }
}

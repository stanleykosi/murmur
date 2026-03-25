/**
 * Fastify authorization middleware for Murmur admin-only API routes.
 *
 * This module builds on the canonical auth middleware by asserting that a
 * request has already been authenticated and that the caller holds the Murmur
 * `admin` role before protected handlers execute.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

import type { UserRole } from "@murmur/shared";

import { ForbiddenError, UnauthorizedError } from "../lib/errors.js";

/**
 * Narrowed request shape available after successful authentication.
 */
export interface AuthenticatedRequest extends FastifyRequest {
  userId: string;
  userRole: UserRole;
}

/**
 * Asserts that the Fastify request already contains an authenticated Murmur
 * identity, typically because `authPreHandler` has run earlier in the chain.
 *
 * @param request - Fastify request being narrowed.
 * @throws {UnauthorizedError} When the request is missing auth context.
 */
export function assertAuthenticatedRequest(
  request: FastifyRequest,
): asserts request is AuthenticatedRequest {
  if (request.userId === null || request.userRole === null) {
    throw new UnauthorizedError("Authentication is required before authorization checks.");
  }
}

/**
 * Ensures the authenticated caller has the Murmur admin role.
 *
 * @param request - Fastify request being authorized.
 * @param _reply - Unused Fastify reply placeholder required by the hook API.
 * @throws {ForbiddenError} When the caller is not an admin.
 */
export async function adminPreHandler(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  assertAuthenticatedRequest(request);

  if (request.userRole !== "admin") {
    throw new ForbiddenError("Admin access required.");
  }
}

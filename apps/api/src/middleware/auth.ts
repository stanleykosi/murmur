/**
 * Fastify authentication middleware for Murmur's protected API routes.
 *
 * This module owns the canonical Clerk session-token verification path for the
 * API. It decorates Fastify requests with authenticated identity metadata,
 * validates Bearer-token formatting, verifies the JWT signature through Clerk,
 * and normalizes the Murmur user role claim into the shared domain type.
 */

import { verifyToken } from "@clerk/backend";
import { USER_ROLES, type UserRole } from "@murmur/shared";
import type { FastifyReply, FastifyRequest } from "fastify";

import { env } from "../config/env.js";
import { UnauthorizedError } from "../lib/errors.js";

const BEARER_TOKEN_PATTERN = /^Bearer\s+(.+)$/i;

/**
 * Typed authentication context attached to authenticated requests.
 */
export interface AuthContext {
  userId: string;
  userRole: UserRole;
}

/**
 * Minimal Fastify instance surface required to register request decorations.
 */
export interface AuthDecoratorRegistrar {
  decorateRequest: (
    property: string | symbol,
    value?: unknown,
    dependencies?: string[],
  ) => unknown;
  hasRequestDecorator: (decorator: string | symbol) => boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    userId: string | null;
    userRole: UserRole | null;
  }
}

/**
 * Registers canonical request decorations used by protected routes.
 *
 * This is called during server bootstrap so every request starts with an
 * explicit unauthenticated state instead of ad-hoc property assignment.
 *
 * @param app - Fastify application instance being configured.
 */
export function registerAuthDecorators(app: AuthDecoratorRegistrar): void {
  if (!app.hasRequestDecorator("userId")) {
    app.decorateRequest("userId", null);
  }

  if (!app.hasRequestDecorator("userRole")) {
    app.decorateRequest("userRole", null);
  }
}

/**
 * Extracts the session token from a standard HTTP Authorization header.
 *
 * @param authorizationHeader - Raw Authorization header value.
 * @returns The normalized Bearer token value.
 * @throws {UnauthorizedError} When the header is missing or malformed.
 */
export function extractBearerToken(authorizationHeader: string | undefined): string {
  if (authorizationHeader === undefined) {
    throw new UnauthorizedError("Authorization header is required.");
  }

  const match = BEARER_TOKEN_PATTERN.exec(authorizationHeader.trim());

  if (!match) {
    throw new UnauthorizedError("Authorization header must use the Bearer scheme.");
  }

  const token = match[1]?.trim();

  if (!token) {
    throw new UnauthorizedError("Authorization token cannot be empty.");
  }

  return token;
}

/**
 * Reads the canonical Murmur role claim from the verified Clerk token payload.
 *
 * Missing role metadata defaults to the listener role. Invalid role metadata is
 * treated as an authentication failure because the session shape no longer
 * matches Murmur's expected contract.
 *
 * @param payload - Verified Clerk token payload.
 * @returns A normalized Murmur auth context.
 * @throws {UnauthorizedError} When the token subject or role claims are invalid.
 */
export function normalizeAuthContext(payload: Record<string, unknown>): AuthContext {
  const userId = payload.sub;

  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new UnauthorizedError("Authenticated session is missing a valid subject.");
  }

  const normalizedUserId = userId.trim();

  const metadata = payload.metadata;

  if (metadata === undefined) {
    return {
      userId: normalizedUserId,
      userRole: "listener",
    };
  }

  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new UnauthorizedError("Authenticated session metadata is invalid.");
  }

  const role = (metadata as Record<string, unknown>).role;

  if (role === undefined) {
    return {
      userId: normalizedUserId,
      userRole: "listener",
    };
  }

  if (typeof role !== "string") {
    throw new UnauthorizedError("Authenticated session role metadata is invalid.");
  }

  if (!USER_ROLES.includes(role as UserRole)) {
    throw new UnauthorizedError(`Authenticated session role "${role}" is not supported.`);
  }

  return {
    userId: normalizedUserId,
    userRole: role as UserRole,
  };
}

/**
 * Verifies the request's Clerk session token and stores the resulting Murmur
 * auth context on the Fastify request object for downstream handlers.
 *
 * @param request - Fastify request being authenticated.
 * @param _reply - Unused Fastify reply placeholder required by the hook API.
 */
export async function authPreHandler(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const token = extractBearerToken(request.headers.authorization);

  try {
    const payload = await verifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY,
    });

    const authContext = normalizeAuthContext(payload as Record<string, unknown>);

    request.userId = authContext.userId;
    request.userRole = authContext.userRole;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      throw error;
    }

    throw new UnauthorizedError("Invalid or expired authentication token.");
  }
}

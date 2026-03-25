/**
 * Unit tests for the Fastify admin authorization middleware.
 *
 * These tests verify the middleware only allows authenticated Murmur admins to
 * continue while rejecting missing auth context or listener-level callers.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import { adminPreHandler, assertAuthenticatedRequest } from "./admin.js";

describe("assertAuthenticatedRequest", () => {
  /**
   * Prevents authorization checks from proceeding when the request never ran
   * through the authentication middleware.
   */
  it("throws when the request is missing auth context", () => {
    const request = {
      userId: null,
      userRole: null,
    } as unknown as FastifyRequest;

    expect(() => assertAuthenticatedRequest(request)).toThrow(/Authentication is required/);
  });
});

describe("adminPreHandler", () => {
  /**
   * Rejects authenticated non-admin callers with the API's canonical forbidden
   * error.
   */
  it("throws when the authenticated user is not an admin", async () => {
    const request = {
      userId: "user_listener",
      userRole: "listener",
    } as unknown as FastifyRequest;

    await expect(adminPreHandler(request, {} as FastifyReply)).rejects.toThrow(/Admin access required/);
  });

  /**
   * Allows authenticated admins to continue without mutating the request.
   */
  it("passes when the authenticated user is an admin", async () => {
    const request = {
      userId: "user_admin",
      userRole: "admin",
    } as unknown as FastifyRequest;

    await expect(adminPreHandler(request, {} as FastifyReply)).resolves.toBeUndefined();
  });
});

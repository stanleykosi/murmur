/**
 * Fastify webhook routes for the Murmur API.
 *
 * This plugin receives Clerk SVIX webhooks, verifies the signature against the
 * exact raw JSON payload bytes, and dispatches supported user-sync events into
 * the canonical auth service.
 */

import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { WebhookEvent } from "@clerk/backend";
import { verifyWebhook } from "@clerk/backend/webhooks";

import { env } from "../config/env.js";
import { UnauthorizedError, ValidationError } from "../lib/errors.js";
import { deleteUser, upsertUser } from "../services/auth.service.js";

/**
 * Converts Fastify's request headers into a WHATWG `Headers` instance.
 *
 * @param headersObject - Fastify request headers.
 * @returns Headers suitable for constructing a WHATWG `Request`.
 */
function buildRequestHeaders(
  headersObject: FastifyRequest["headers"],
): Headers {
  const headers = new Headers();

  for (const [key, value] of Object.entries(headersObject)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }

    headers.set(key, String(value));
  }

  return headers;
}

/**
 * Builds an absolute request URL for the webhook verification request object.
 *
 * Clerk verification relies on headers and raw body bytes, but providing an
 * absolute URL keeps the WHATWG `Request` fully formed and deterministic.
 *
 * @param request - Fastify request received by the webhook endpoint.
 * @returns An absolute URL representing the current request.
 */
function buildRequestUrl(request: FastifyRequest): string {
  const protocolHeader = request.headers["x-forwarded-proto"];
  const forwardedProtocol = Array.isArray(protocolHeader)
    ? protocolHeader[0]
    : protocolHeader;
  const protocol = forwardedProtocol ?? request.protocol ?? "http";
  const host = request.headers.host ?? "localhost";
  const rawUrl = request.raw.url ?? request.url;

  return `${protocol}://${host}${rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`}`;
}

/**
 * Narrows the webhook request body to a raw Buffer.
 *
 * @param body - Request body produced by the route-scoped content parser.
 * @returns The raw request body buffer.
 * @throws {ValidationError} When the route is misconfigured and raw bytes are missing.
 */
function assertRawRequestBody(body: unknown): Buffer {
  if (!Buffer.isBuffer(body)) {
    if (typeof body === "string") {
      return Buffer.from(body, "utf8");
    }

    if (body instanceof Uint8Array) {
      return Buffer.from(body);
    }

    throw new ValidationError(
      "Clerk webhook requests must be parsed as raw bytes before verification.",
    );
  }

  return body;
}

/**
 * Verifies the incoming Clerk webhook using the raw request bytes.
 *
 * @param request - Fastify request containing raw JSON bytes and SVIX headers.
 * @returns The verified Clerk webhook event payload.
 * @throws {UnauthorizedError} When the signature cannot be verified.
 */
async function verifyClerkWebhook(
  request: FastifyRequest<{ Body: Buffer }>,
): Promise<WebhookEvent> {
  const rawBody = assertRawRequestBody(request.body);
  const requestForVerification = new Request(buildRequestUrl(request), {
    body: rawBody,
    headers: buildRequestHeaders(request.headers),
    method: request.method,
  });

  try {
    return await verifyWebhook(requestForVerification, {
      signingSecret: env.CLERK_WEBHOOK_SECRET,
    });
  } catch (error) {
    throw new UnauthorizedError("Invalid Clerk webhook signature.");
  }
}

/**
 * Dispatches a verified Clerk webhook event into the appropriate user-sync flow.
 *
 * @param event - Verified Clerk webhook event.
 * @throws {ValidationError} When the event type is not part of Murmur's supported contract.
 */
async function handleWebhookEvent(event: WebhookEvent): Promise<void> {
  switch (event.type) {
    case "user.created":
    case "user.updated":
      await upsertUser(event.data);
      return;
    case "user.deleted": {
      const deletedUserId = event.data.id;

      if (typeof deletedUserId !== "string" || deletedUserId.trim().length === 0) {
        throw new ValidationError(
          "Clerk user.deleted webhook payload is missing a valid user id.",
        );
      }

      await deleteUser(deletedUserId);
      return;
    }
    default:
      throw new ValidationError(
        `Unsupported Clerk webhook event "${event.type}".`,
      );
  }
}

/**
 * Fastify route plugin exposing `/api/webhooks/clerk`.
 */
export const webhookRoutes: FastifyPluginAsync = async (app) => {
  if (app.hasContentTypeParser("application/json")) {
    app.removeContentTypeParser("application/json");
  }

  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post<{ Body: Buffer }>("/clerk", async (request) => {
    const event = await verifyClerkWebhook(request);
    await handleWebhookEvent(event);

    return {
      handled: true,
      type: event.type,
    };
  });
};

export default webhookRoutes;

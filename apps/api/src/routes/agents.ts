/**
 * Fastify agent routes for the Murmur API.
 *
 * This plugin exposes the public read-only agent catalog used by the lobby,
 * live-room UI, and admin tools.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { parseWithSchema } from "../lib/validation.js";
import { getAgentById, listAgents } from "../services/agent.service.js";

const agentIdParamsSchema = z
  .object({
    id: z.string().uuid("Agent id must be a valid UUID."),
  })
  .strict();

/**
 * Fastify route plugin exposing `/api/agents` endpoints.
 */
export const agentsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async () => ({
    agents: await listAgents(),
  }));

  app.get("/:id", async (request) => {
    const params = parseWithSchema(
      agentIdParamsSchema,
      request.params,
      "Invalid agent id.",
    );

    return {
      agent: await getAgentById(params.id),
    };
  });
};

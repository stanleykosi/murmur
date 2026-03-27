/**
 * API-local facade over the canonical Murmur house-agent catalog.
 *
 * The built-in agent definitions now live in `@murmur/shared` so the API seed
 * flow and the agent orchestrator read the exact same personality, voice, and
 * presentation metadata. This file remains as a stable import path for the API
 * workspace.
 */

export {
  HOUSE_AGENTS,
  HOUSE_AGENT_IDS,
  getHouseAgentById,
  type HouseAgentDefinition,
  type HouseAgentId,
} from "@murmur/shared";

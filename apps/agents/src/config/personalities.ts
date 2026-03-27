/**
 * Local personality-config facade for the Murmur agent orchestrator.
 *
 * The orchestrator consumes the canonical house-agent definitions from
 * `@murmur/shared` via this workspace-local module so future agent runtime code
 * can use a stable import path without re-defining the personalities.
 */

export {
  HOUSE_AGENTS,
  HOUSE_AGENT_IDS,
  getHouseAgentById,
  type HouseAgentDefinition,
  type HouseAgentId,
} from "@murmur/shared";

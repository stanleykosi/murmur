/**
 * Local personality-config facade for the Murmur agent orchestrator.
 *
 * The orchestrator consumes the canonical house-agent definitions from
 * `@murmur/shared` through this workspace-local import path.
 */

export {
  HOUSE_AGENTS,
  HOUSE_AGENT_IDS,
  getHouseAgentById,
  type HouseAgentDefinition,
  type HouseAgentId,
} from "@murmur/shared";

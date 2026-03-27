/**
 * Unit tests for the orchestrator personality-config facade.
 *
 * These assertions guarantee the local `apps/agents` import path is a thin
 * re-export of the shared house-agent catalog instead of a second source of
 * truth.
 */

import { describe, expect, it } from "vitest";

import {
  HOUSE_AGENTS as SHARED_HOUSE_AGENTS,
  HOUSE_AGENT_IDS as SHARED_HOUSE_AGENT_IDS,
  getHouseAgentById as getSharedHouseAgentById,
} from "@murmur/shared";

import {
  HOUSE_AGENTS,
  HOUSE_AGENT_IDS,
  getHouseAgentById,
} from "./personalities.js";

describe("personality facade", () => {
  /**
   * Confirms the orchestrator facade exposes the same values and object
   * identity as the shared canonical house-agent module.
   */
  it("re-exports the canonical house-agent catalog without modification", () => {
    expect(HOUSE_AGENT_IDS).toBe(SHARED_HOUSE_AGENT_IDS);
    expect(HOUSE_AGENTS).toBe(SHARED_HOUSE_AGENTS);
  });

  /**
   * Verifies the facade preserves the shared lookup behavior for stable agent
   * configuration IDs.
   */
  it("preserves shared lookup behavior", () => {
    expect(getHouseAgentById("rex")).toEqual(getSharedHouseAgentById("rex"));
  });
});

/**
 * Canonical database seed script for the Murmur API service.
 *
 * This script bootstraps the three built-in house agents and the MVP demo room
 * into PostgreSQL using Drizzle ORM. It is intentionally idempotent for the
 * clean canonical state: agents are upserted by unique name, the demo room is
 * reused by title, and room-agent assignments are synchronized by the
 * room/agent uniqueness constraint.
 */

import "dotenv/config";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import type { AgentRole, RoomFormat, RoomStatus } from "@murmur/shared";

import { HOUSE_AGENTS, type HouseAgentId } from "../config/agents.js";
import * as schema from "./schema.js";
import {
  agents,
  roomAgents,
  rooms,
  type AgentRecord,
  type NewRoomAgentRecord,
  type RoomRecord,
} from "./schema.js";

/**
 * Minimal runtime environment contract required for seed execution.
 *
 * The API server itself validates a larger environment surface area, but the
 * seed command only needs PostgreSQL connectivity. Keeping this contract local
 * avoids unrelated secret requirements for database bootstrapping.
 */
const SeedEnvSchema = z.object({
  DATABASE_URL: z
    .string({
      required_error: "DATABASE_URL is required to run the seed script.",
      invalid_type_error: "DATABASE_URL must be a string.",
    })
    .transform((value) => value.trim())
    .pipe(z.string().url("DATABASE_URL must be a valid PostgreSQL connection URL.")),
});

/**
 * Parsed runtime configuration for the seed command.
 */
type SeedEnvironment = z.infer<typeof SeedEnvSchema>;

/**
 * Canonical demo-room metadata used across seed runs.
 */
export const DEMO_ROOM_SEED = {
  title: "Is AGI 5 Years Away?",
  topic: "Debating the timeline and implications of artificial general intelligence",
  format: "moderated",
  status: "live",
} as const satisfies {
  format: RoomFormat;
  status: RoomStatus;
  title: string;
  topic: string;
};

/**
 * Small persisted-agent shape required to build room assignments.
 */
interface PersistedSeedAgent {
  id: string;
  name: string;
}

/**
 * Explicit room-agent assignment shape used by the canonical demo seed.
 *
 * Drizzle's inferred insert type makes `role` optional because the database
 * has a default, but the seed always sets it intentionally for clarity.
 */
interface DemoRoomAssignment
  extends Pick<NewRoomAgentRecord, "agentId" | "roomId"> {
  role: AgentRole;
}

/**
 * Seed execution summary emitted at the end of a successful run.
 */
interface SeedResult {
  assignedAgents: number;
  demoRoomId: string;
  upsertedAgents: number;
}

/**
 * Parses the seed-specific environment contract and throws a single helpful
 * error message when the configuration is invalid.
 *
 * @param environment - Environment variables to validate.
 * @returns The trimmed and validated seed environment.
 * @throws {Error} When `DATABASE_URL` is missing or invalid.
 */
export function parseSeedEnvironment(
  environment: NodeJS.ProcessEnv,
): SeedEnvironment {
  const parsedEnvironment = SeedEnvSchema.safeParse(environment);

  if (!parsedEnvironment.success) {
    const issues = parsedEnvironment.error.issues
      .map((issue) => `- ${issue.path.join(".") || "DATABASE_URL"}: ${issue.message}`)
      .join("\n");

    throw new Error(
      `Invalid seed environment configuration:\n${issues}\nSet DATABASE_URL and re-run pnpm --filter api seed.`,
    );
  }

  return parsedEnvironment.data;
}

/**
 * Resolves the room role for a specific built-in agent.
 *
 * Nova is always the demo-room host; Rex and Sage remain participants.
 *
 * @param agentId - Stable house-agent configuration key.
 * @returns The room role to persist in `room_agents`.
 */
function getDemoRoomRole(agentId: HouseAgentId): AgentRole {
  return agentId === "nova" ? "host" : "participant";
}

/**
 * Builds the canonical room-agent assignments for the demo room and fails fast
 * if any required house agent was not persisted successfully.
 *
 * @param roomId - Database UUID of the demo room.
 * @param persistedAgents - Persisted agents keyed by database UUID and name.
 * @returns Insert rows for the `room_agents` junction table.
 * @throws {Error} When one or more built-in agents are missing from the DB.
 */
export function buildDemoRoomAssignments(
  roomId: string,
  persistedAgents: ReadonlyArray<PersistedSeedAgent>,
): DemoRoomAssignment[] {
  const agentsByName = new Map(
    persistedAgents.map((agent) => [agent.name, agent]),
  );
  const missingAgentNames: string[] = [];
  const assignments: DemoRoomAssignment[] = [];

  for (const houseAgent of HOUSE_AGENTS) {
    const persistedAgent = agentsByName.get(houseAgent.name);

    if (!persistedAgent) {
      missingAgentNames.push(houseAgent.name);
      continue;
    }

    assignments.push({
      agentId: persistedAgent.id,
      role: getDemoRoomRole(houseAgent.id),
      roomId,
    });
  }

  if (missingAgentNames.length > 0) {
    throw new Error(
      `Cannot assign the demo room because these built-in agents are missing from the database: ${missingAgentNames.join(", ")}.`,
    );
  }

  return assignments;
}

/**
 * Creates a PostgreSQL pool and Drizzle client for seed execution.
 *
 * @param databaseUrl - Validated PostgreSQL connection string.
 * @returns The shared pool and schema-aware Drizzle client.
 */
function createSeedDatabase(databaseUrl: string) {
  const pool = new Pool({
    allowExitOnIdle: true,
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    max: 4,
  });

  return {
    db: drizzle(pool, { schema }),
    pool,
  };
}

/**
 * Schema-aware Drizzle database type for standalone seed execution.
 */
type SeedDatabase = ReturnType<typeof createSeedDatabase>["db"];

/**
 * Transaction client passed into the seed helpers by Drizzle.
 */
type SeedTransaction = Parameters<Parameters<SeedDatabase["transaction"]>[0]>[0];

/**
 * Upserts the canonical house agents by their unique `name` field and returns
 * the persisted rows mapped back to their configuration IDs.
 *
 * @param tx - Active Drizzle transaction.
 * @returns Persisted agent rows paired with their stable house-agent IDs.
 */
async function upsertHouseAgents(
  tx: SeedTransaction,
) {
  const persistedAgents: Array<{
    record: AgentRecord;
  }> = [];

  for (const houseAgent of HOUSE_AGENTS) {
    const [record] = await tx
      .insert(agents)
      .values({
        accentColor: houseAgent.accentColor,
        avatarUrl: houseAgent.avatarUrl,
        isActive: true,
        name: houseAgent.name,
        personality: houseAgent.personality,
        ttsProvider: houseAgent.ttsProvider,
        voiceId: houseAgent.voiceId,
      })
      .onConflictDoUpdate({
        target: agents.name,
        set: {
          accentColor: houseAgent.accentColor,
          avatarUrl: houseAgent.avatarUrl,
          isActive: true,
          personality: houseAgent.personality,
          ttsProvider: houseAgent.ttsProvider,
          voiceId: houseAgent.voiceId,
        },
      })
      .returning();

    if (!record) {
      throw new Error(
        `Upserting the built-in agent "${houseAgent.name}" did not return a persisted row.`,
      );
    }

    persistedAgents.push({
      record,
    });
  }

  return persistedAgents;
}

/**
 * Locates or creates the canonical demo room by title.
 *
 * If multiple rooms share the canonical title, the script stops immediately so
 * the duplicate local state can be cleaned up explicitly instead of choosing an
 * arbitrary winner.
 *
 * @param tx - Active Drizzle transaction.
 * @returns The persisted canonical demo-room row.
 * @throws {Error} When duplicate canonical demo rooms exist.
 */
async function ensureDemoRoom(
  tx: SeedTransaction,
): Promise<RoomRecord> {
  const matchingRooms = await tx
    .select()
    .from(rooms)
    .where(eq(rooms.title, DEMO_ROOM_SEED.title));

  if (matchingRooms.length > 1) {
    throw new Error(
      `Found ${matchingRooms.length} rooms titled "${DEMO_ROOM_SEED.title}". Delete duplicate demo rooms and re-run pnpm --filter api seed.`,
    );
  }

  const existingRoom = matchingRooms[0];

  if (!existingRoom) {
    const [createdRoom] = await tx
      .insert(rooms)
      .values({
        format: DEMO_ROOM_SEED.format,
        status: DEMO_ROOM_SEED.status,
        title: DEMO_ROOM_SEED.title,
        topic: DEMO_ROOM_SEED.topic,
      })
      .returning();

    if (!createdRoom) {
      throw new Error("Creating the canonical demo room did not return a persisted row.");
    }

    return createdRoom;
  }

  const [updatedRoom] = await tx
    .update(rooms)
    .set({
      endedAt: null,
      format: DEMO_ROOM_SEED.format,
      status: DEMO_ROOM_SEED.status,
      topic: DEMO_ROOM_SEED.topic,
    })
    .where(eq(rooms.id, existingRoom.id))
    .returning();

  if (!updatedRoom) {
    throw new Error(
      `Updating the canonical demo room "${DEMO_ROOM_SEED.title}" did not return a persisted row.`,
    );
  }

  return updatedRoom;
}

/**
 * Synchronizes the canonical room-agent assignments for the demo room.
 *
 * Existing assignments for the three built-in agents are updated in place via
 * the room/agent uniqueness constraint, which keeps the seed idempotent.
 *
 * @param tx - Active Drizzle transaction.
 * @param roomId - Demo-room UUID.
 * @param persistedAgents - Persisted house-agent rows keyed by stable config ID.
 * @returns The number of assignments written.
 */
async function syncDemoRoomAssignments(
  tx: SeedTransaction,
  roomId: string,
  persistedAgents: ReadonlyArray<{
    record: AgentRecord;
  }>,
): Promise<number> {
  const assignments = buildDemoRoomAssignments(
    roomId,
    persistedAgents.map(({ record }) => ({
      id: record.id,
      name: record.name,
    })),
  );

  for (const assignment of assignments) {
    await tx
      .insert(roomAgents)
      .values(assignment)
      .onConflictDoUpdate({
        target: [roomAgents.roomId, roomAgents.agentId],
        set: {
          role: assignment.role,
        },
      });
  }

  // The canonical seed only guarantees the built-in assignments exist. It does
  // not silently delete additional rows from local databases.
  return assignments.length;
}

/**
 * Runs the canonical seed transaction and prints a concise summary.
 *
 * @returns Counts and IDs describing the successful seed run.
 */
export async function runSeed(): Promise<SeedResult> {
  const seedEnvironment = parseSeedEnvironment(process.env);
  const { db, pool } = createSeedDatabase(seedEnvironment.DATABASE_URL);

  try {
    const result = await db.transaction(async (tx) => {
      const persistedAgents = await upsertHouseAgents(tx);
      const demoRoom = await ensureDemoRoom(tx);
      const assignedAgents = await syncDemoRoomAssignments(
        tx,
        demoRoom.id,
        persistedAgents,
      );

      return {
        assignedAgents,
        demoRoomId: demoRoom.id,
        upsertedAgents: persistedAgents.length,
      } satisfies SeedResult;
    });

    console.info(
      JSON.stringify({
        assignedAgents: result.assignedAgents,
        demoRoomId: result.demoRoomId,
        scope: "db-seed",
        status: "ok",
        upsertedAgents: result.upsertedAgents,
      }),
    );

    return result;
  } finally {
    await pool.end();
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectExecution) {
  void runSeed().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Unknown seed failure.";

    console.error(
      JSON.stringify({
        error: message,
        scope: "db-seed",
        status: "error",
      }),
    );

    process.exit(1);
  });
}

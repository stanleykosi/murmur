/**
 * PostgreSQL client bootstrap for the Murmur agents service.
 *
 * The orchestrator reads active room state and stores transcript history
 * directly from PostgreSQL, so the agents process owns its own connection pool
 * and health-check helpers instead of borrowing runtime state from the API app.
 */

import { Pool, type PoolConfig } from "pg";

import { env } from "../config/env.js";
import { createLogger } from "../lib/logger.js";

const databaseLogger = createLogger({ component: "database" });
const NODE_ENV = process.env.NODE_ENV?.trim() || "development";

/**
 * Successful response shape for explicit database connection checks.
 */
export interface DatabaseConnectionStatus {
  databaseName: string;
  serverTime: string;
}

/**
 * Builds the shared PostgreSQL pool configuration for the agents process.
 *
 * @returns A runtime-specific `pg` pool configuration.
 */
function createPoolConfiguration(): PoolConfig {
  return {
    connectionString: env.DATABASE_URL,
    max: NODE_ENV === "production" ? 20 : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: NODE_ENV !== "production",
  };
}

/**
 * Shared PostgreSQL connection pool for the agents service.
 */
export const pool = new Pool(createPoolConfiguration());

pool.on("error", (error: Error) => {
  databaseLogger.error({ err: error }, "Unexpected idle PostgreSQL client error.");
});

/**
 * Verifies that PostgreSQL is reachable and returns lightweight diagnostics.
 *
 * @returns The current database name and server time.
 * @throws {Error} When the query fails or returns no rows.
 */
export async function testDatabaseConnection(): Promise<DatabaseConnectionStatus> {
  try {
    const query = `
      select
        current_database() as database_name,
        now()::text as server_time
    `;
    const result = await pool.query<{
      database_name: string;
      server_time: string;
    }>(query);
    const firstRow = result.rows[0];

    if (!firstRow) {
      throw new Error("PostgreSQL connectivity check returned no rows.");
    }

    return {
      databaseName: firstRow.database_name,
      serverTime: firstRow.server_time,
    };
  } catch (error) {
    databaseLogger.error({ err: error }, "Failed to verify PostgreSQL connectivity.");
    throw error;
  }
}

/**
 * Gracefully drains the shared PostgreSQL connection pool.
 *
 * @returns A promise that resolves once all pooled clients are closed.
 */
export async function closeDatabasePool(): Promise<void> {
  await pool.end();
}

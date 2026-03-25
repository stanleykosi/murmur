/**
 * PostgreSQL client bootstrap for the Murmur API service.
 *
 * This module owns the shared `pg` connection pool, the Drizzle ORM database
 * instance, and the lightweight connectivity helpers used by startup checks and
 * future graceful-shutdown paths.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import { env } from "../config/env.js";
import { createLogger } from "../lib/logger.js";
import * as schema from "./schema.js";

const databaseLogger = createLogger({ component: "database" });

/**
 * Successful response shape for explicit database connection tests.
 */
export interface DatabaseConnectionStatus {
  databaseName: string;
  serverTime: string;
}

/**
 * Creates the shared `pg` pool configuration for the API process.
 *
 * The pool is intentionally conservative because the MVP has one API service
 * process and a managed PostgreSQL instance. The canonical connection URL lives
 * in `DATABASE_URL`; there is no parallel legacy configuration path.
 *
 * @returns A `pg` pool configuration derived from validated runtime env vars.
 */
function createPoolConfiguration(): PoolConfig {
  return {
    connectionString: env.DATABASE_URL,
    max: env.NODE_ENV === "production" ? 20 : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: env.NODE_ENV !== "production",
  };
}

/**
 * Shared PostgreSQL connection pool for the API process.
 */
export const pool = new Pool(createPoolConfiguration());

pool.on("error", (error) => {
  databaseLogger.error({ err: error }, "Unexpected idle PostgreSQL client error.");
});

/**
 * Shared Drizzle ORM database instance configured with the full schema for
 * typed queries and relational loading.
 */
export const db = drizzle(pool, {
  schema,
  logger: env.NODE_ENV === "development",
});

/**
 * Verifies that PostgreSQL is reachable and returns a small amount of metadata
 * useful for diagnostics and health checks.
 *
 * @returns The current database name and server time from PostgreSQL.
 * @throws {Error} When the database cannot be queried successfully.
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

/**
 * Convenience type for modules that need the concrete Drizzle database shape.
 */
export type DatabaseClient = typeof db;

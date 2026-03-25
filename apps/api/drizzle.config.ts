/**
 * Drizzle Kit configuration for Murmur's PostgreSQL schema and migrations.
 *
 * This configuration intentionally validates only the database URL so schema
 * generation and migration commands do not depend on unrelated runtime secrets
 * like Clerk or LiveKit credentials.
 */

import "dotenv/config";

import { defineConfig } from "drizzle-kit";
import { z } from "zod";

const DrizzleEnvSchema = z.object({
  DATABASE_URL: z
    .string({
      required_error: "DATABASE_URL is required for Drizzle Kit commands.",
      invalid_type_error: "DATABASE_URL must be a string.",
    })
    .transform((value) => value.trim())
    .pipe(z.string().url("DATABASE_URL must be a valid PostgreSQL connection URL.")),
});

const parsedEnv = DrizzleEnvSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const issues = parsedEnv.error.issues
    .map((issue) => `- ${issue.path.join(".") || "DATABASE_URL"}: ${issue.message}`)
    .join("\n");

  throw new Error(
    `Invalid Drizzle Kit environment configuration:\n${issues}\nSet DATABASE_URL and re-run the command.`,
  );
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: parsedEnv.data.DATABASE_URL,
  },
  verbose: true,
  strict: true,
});

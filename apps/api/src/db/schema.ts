/**
 * Canonical PostgreSQL schema for the Murmur API service.
 *
 * This module defines all database tables, constraints, indexes, relations,
 * and inferred row types for the current-state Murmur data model. Shared
 * literal unions are reused for CHECK constraints so application-level types
 * and database invariants remain aligned.
 */

import {
  AGENT_ROLES,
  ROOM_FORMATS,
  ROOM_STATUSES,
  TTS_PROVIDERS,
  USER_ROLES,
  type AgentRole,
  type RoomFormat,
  type RoomStatus,
  type TtsProvider,
  type UserRole,
} from "@murmur/shared";
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgPolicy,
  pgRole,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const TIMESTAMPTZ_OPTIONS = {
  withTimezone: true,
  mode: "string",
} as const;
const SUPABASE_SERVICE_ROLE = pgRole("service_role").existing();

/**
 * Creates a reusable TIMESTAMPTZ column configured to round-trip as an ISO
 * string, which matches the shared transport types used by the API and web
 * layers.
 *
 * @param name - Physical database column name.
 * @returns A timestamp column builder configured for PostgreSQL time zones.
 */
function timestamptz(name: string) {
  return timestamp(name, TIMESTAMPTZ_OPTIONS);
}

/**
 * Builds a static SQL list of quoted string literals for CHECK constraints.
 *
 * The values are compile-time constants sourced from shared literal unions, so
 * `sql.raw` is appropriate here and avoids parameter placeholders inside DDL.
 *
 * @param values - Allowed literal values for a constrained text column.
 * @returns A comma-separated list of quoted SQL string literals.
 */
function buildSqlLiteralList(values: readonly string[]) {
  return values
    .map((value) => `'${value.replaceAll("'", "''")}'`)
    .join(", ");
}

/**
 * Creates a text-enum CHECK constraint backed by the shared literal arrays.
 *
 * @param constraintName - Stable database constraint name.
 * @param columnName - Physical column name in snake_case.
 * @param values - Canonical allowed values for the column.
 * @returns A Drizzle CHECK constraint builder.
 */
function buildEnumCheck(
  constraintName: string,
  columnName: string,
  values: readonly string[],
) {
  return check(
    constraintName,
    sql.raw(`"${columnName}" in (${buildSqlLiteralList(values)})`),
  );
}

/**
 * Creates explicit full-access RLS policies for Supabase's `service_role`.
 *
 * Murmur's canonical architecture does not expose direct client-side database
 * access. The Fastify API is the only supported data-access layer, so browser
 * roles intentionally receive no table policies. These service-role policies
 * exist as defense-in-depth documentation for managed Supabase access paths.
 *
 * @param tableName - Stable table identifier used in policy names.
 * @returns CRUD policies granting service-side access under RLS.
 */
function buildServiceRolePolicies(tableName: string) {
  return [
    pgPolicy(`${tableName}_service_role_select`, {
      for: "select",
      to: SUPABASE_SERVICE_ROLE,
      using: sql`true`,
    }),
    pgPolicy(`${tableName}_service_role_insert`, {
      for: "insert",
      to: SUPABASE_SERVICE_ROLE,
      withCheck: sql`true`,
    }),
    pgPolicy(`${tableName}_service_role_update`, {
      for: "update",
      to: SUPABASE_SERVICE_ROLE,
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy(`${tableName}_service_role_delete`, {
      for: "delete",
      to: SUPABASE_SERVICE_ROLE,
      using: sql`true`,
    }),
  ];
}

/**
 * User accounts synchronized from Clerk and used for listener/admin access.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clerkId: varchar("clerk_id", { length: 255 }).notNull().unique(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    displayName: varchar("display_name", { length: 100 }).notNull(),
    avatarUrl: text("avatar_url"),
    role: varchar("role", { length: 20 })
      .$type<UserRole>()
      .notNull()
      .default("listener"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    buildEnumCheck("users_role_check", "role", USER_ROLES),
    index("idx_users_clerk_id").on(table.clerkId),
    ...buildServiceRolePolicies("users"),
  ],
).enableRLS();

/**
 * House agents that can be assigned to live rooms.
 */
export const agents = pgTable(
  "agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 50 }).notNull().unique(),
    personality: text("personality").notNull(),
    voiceId: varchar("voice_id", { length: 255 }).notNull(),
    ttsProvider: varchar("tts_provider", { length: 20 })
      .$type<TtsProvider>()
      .notNull()
      .default("cartesia"),
    avatarUrl: text("avatar_url").notNull(),
    accentColor: varchar("accent_color", { length: 7 })
      .notNull()
      .default("#FFFFFF"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  () => [
    buildEnumCheck("agents_tts_provider_check", "tts_provider", TTS_PROVIDERS),
    check(
      "agents_accent_color_check",
      sql.raw(`"accent_color" ~ '^#[0-9A-Fa-f]{6}$'`),
    ),
    ...buildServiceRolePolicies("agents"),
  ],
).enableRLS();

/**
 * Live or scheduled conversation rooms listeners can join.
 */
export const rooms = pgTable(
  "rooms",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: varchar("title", { length: 200 }).notNull(),
    topic: text("topic").notNull(),
    format: varchar("format", { length: 20 })
      .$type<RoomFormat>()
      .notNull()
      .default("free_for_all"),
    status: varchar("status", { length: 20 })
      .$type<RoomStatus>()
      .notNull()
      .default("live"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    endedAt: timestamptz("ended_at"),
  },
  (table) => [
    buildEnumCheck("rooms_format_check", "format", ROOM_FORMATS),
    buildEnumCheck("rooms_status_check", "status", ROOM_STATUSES),
    index("idx_rooms_status").on(table.status),
    index("idx_rooms_created_at").on(table.createdAt.desc()),
    ...buildServiceRolePolicies("rooms"),
  ],
).enableRLS();

/**
 * Junction table mapping agents into rooms with a host/participant role.
 */
export const roomAgents = pgTable(
  "room_agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 20 })
      .$type<AgentRole>()
      .notNull()
      .default("participant"),
    joinedAt: timestamptz("joined_at").notNull().defaultNow(),
  },
  (table) => [
    buildEnumCheck("room_agents_role_check", "role", AGENT_ROLES),
    unique("room_agents_room_id_agent_id_unique").on(table.roomId, table.agentId),
    index("idx_room_agents_room").on(table.roomId),
    ...buildServiceRolePolicies("room_agents"),
  ],
).enableRLS();

/**
 * Listener membership lifecycle for a room.
 *
 * The canonical model keeps one row per `room_id`/`user_id` pair, which means a
 * leave-and-rejoin flow should reactivate or update the same record instead of
 * inserting duplicates.
 */
export const roomListeners = pgTable(
  "room_listeners",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: timestamptz("joined_at").notNull().defaultNow(),
    leftAt: timestamptz("left_at"),
  },
  (table) => [
    unique("room_listeners_room_id_user_id_unique").on(table.roomId, table.userId),
    index("idx_room_listeners_room").on(table.roomId),
    ...buildServiceRolePolicies("room_listeners"),
  ],
).enableRLS();

/**
 * Stored transcript entries emitted by agents for playback context and audit.
 */
export const transcripts = pgTable(
  "transcripts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    content: text("content").notNull(),
    wasFiltered: boolean("was_filtered").notNull().default(false),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_transcripts_room_time").on(table.roomId, table.createdAt.desc()),
    ...buildServiceRolePolicies("transcripts"),
  ],
).enableRLS();

/**
 * Relational mapping for navigating from users to rooms they created or joined.
 */
export const usersRelations = relations(users, ({ many }) => ({
  createdRooms: many(rooms),
  listenerSessions: many(roomListeners),
}));

/**
 * Relational mapping for navigating from agents to room assignments and
 * transcript history.
 */
export const agentsRelations = relations(agents, ({ many }) => ({
  roomAssignments: many(roomAgents),
  transcriptEntries: many(transcripts),
}));

/**
 * Relational mapping for navigating from a room to its creator, agents,
 * listeners, and transcript entries.
 */
export const roomsRelations = relations(rooms, ({ many, one }) => ({
  creator: one(users, {
    fields: [rooms.createdBy],
    references: [users.id],
  }),
  assignedAgents: many(roomAgents),
  listeners: many(roomListeners),
  transcriptEntries: many(transcripts),
}));

/**
 * Relational mapping for traversing the room-agent junction table.
 */
export const roomAgentsRelations = relations(roomAgents, ({ one }) => ({
  room: one(rooms, {
    fields: [roomAgents.roomId],
    references: [rooms.id],
  }),
  agent: one(agents, {
    fields: [roomAgents.agentId],
    references: [agents.id],
  }),
}));

/**
 * Relational mapping for traversing the room-listener lifecycle table.
 */
export const roomListenersRelations = relations(roomListeners, ({ one }) => ({
  room: one(rooms, {
    fields: [roomListeners.roomId],
    references: [rooms.id],
  }),
  user: one(users, {
    fields: [roomListeners.userId],
    references: [users.id],
  }),
}));

/**
 * Relational mapping for transcript ownership and room membership.
 */
export const transcriptsRelations = relations(transcripts, ({ one }) => ({
  room: one(rooms, {
    fields: [transcripts.roomId],
    references: [rooms.id],
  }),
  agent: one(agents, {
    fields: [transcripts.agentId],
    references: [agents.id],
  }),
}));

/**
 * Inferred select model for persisted users.
 */
export type UserRecord = typeof users.$inferSelect;

/**
 * Inferred insert model for new user rows.
 */
export type NewUserRecord = typeof users.$inferInsert;

/**
 * Inferred select model for persisted agents.
 */
export type AgentRecord = typeof agents.$inferSelect;

/**
 * Inferred insert model for new agent rows.
 */
export type NewAgentRecord = typeof agents.$inferInsert;

/**
 * Inferred select model for persisted rooms.
 */
export type RoomRecord = typeof rooms.$inferSelect;

/**
 * Inferred insert model for new room rows.
 */
export type NewRoomRecord = typeof rooms.$inferInsert;

/**
 * Inferred select model for room-agent assignments.
 */
export type RoomAgentRecord = typeof roomAgents.$inferSelect;

/**
 * Inferred insert model for new room-agent assignments.
 */
export type NewRoomAgentRecord = typeof roomAgents.$inferInsert;

/**
 * Inferred select model for room-listener lifecycle rows.
 */
export type RoomListenerRecord = typeof roomListeners.$inferSelect;

/**
 * Inferred insert model for new room-listener lifecycle rows.
 */
export type NewRoomListenerRecord = typeof roomListeners.$inferInsert;

/**
 * Inferred select model for transcript rows.
 */
export type TranscriptRecord = typeof transcripts.$inferSelect;

/**
 * Inferred insert model for new transcript rows.
 */
export type NewTranscriptRecord = typeof transcripts.$inferInsert;

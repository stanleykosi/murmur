-- Canonical Murmur initial schema.
-- This database is API-driven: browser clients should not access these tables
-- directly through Supabase. RLS is enabled everywhere and table privileges are
-- explicitly revoked from `anon`, `authenticated`, and `PUBLIC`.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(50) NOT NULL,
	"personality" text NOT NULL,
	"voice_id" varchar(255) NOT NULL,
	"tts_provider" varchar(20) DEFAULT 'cartesia' NOT NULL,
	"avatar_url" text NOT NULL,
	"accent_color" varchar(7) DEFAULT '#FFFFFF' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_name_unique" UNIQUE("name"),
	CONSTRAINT "agents_tts_provider_check" CHECK ("tts_provider" in ('cartesia', 'elevenlabs')),
	CONSTRAINT "agents_accent_color_check" CHECK ("accent_color" ~ '^#[0-9A-Fa-f]{6}$')
);
--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "room_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"role" varchar(20) DEFAULT 'participant' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_agents_room_id_agent_id_unique" UNIQUE("room_id","agent_id"),
	CONSTRAINT "room_agents_role_check" CHECK ("role" in ('host', 'participant'))
);
--> statement-breakpoint
ALTER TABLE "room_agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "room_listeners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "room_listeners_room_id_user_id_unique" UNIQUE("room_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "room_listeners" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(200) NOT NULL,
	"topic" text NOT NULL,
	"format" varchar(20) DEFAULT 'free_for_all' NOT NULL,
	"status" varchar(20) DEFAULT 'live' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "rooms_format_check" CHECK ("format" in ('free_for_all', 'moderated')),
	CONSTRAINT "rooms_status_check" CHECK ("status" in ('scheduled', 'live', 'ended'))
);
--> statement-breakpoint
ALTER TABLE "rooms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"content" text NOT NULL,
	"was_filtered" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transcripts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_id" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"display_name" varchar(100) NOT NULL,
	"avatar_url" text,
	"role" varchar(20) DEFAULT 'listener' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_clerk_id_unique" UNIQUE("clerk_id"),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_role_check" CHECK ("role" in ('listener', 'admin'))
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "room_agents" ADD CONSTRAINT "room_agents_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_agents" ADD CONSTRAINT "room_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_listeners" ADD CONSTRAINT "room_listeners_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_listeners" ADD CONSTRAINT "room_listeners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_room_agents_room" ON "room_agents" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "idx_room_listeners_room" ON "room_listeners" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "idx_rooms_status" ON "rooms" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_rooms_created_at" ON "rooms" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_transcripts_room_time" ON "transcripts" USING btree ("room_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_users_clerk_id" ON "users" USING btree ("clerk_id");--> statement-breakpoint
CREATE POLICY "agents_service_role_select" ON "agents" AS PERMISSIVE FOR SELECT TO "service_role" USING (true);--> statement-breakpoint
CREATE POLICY "agents_service_role_insert" ON "agents" AS PERMISSIVE FOR INSERT TO "service_role" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "agents_service_role_update" ON "agents" AS PERMISSIVE FOR UPDATE TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "agents_service_role_delete" ON "agents" AS PERMISSIVE FOR DELETE TO "service_role" USING (true);--> statement-breakpoint
CREATE POLICY "room_agents_service_role_select" ON "room_agents" AS PERMISSIVE FOR SELECT TO "service_role" USING (true);--> statement-breakpoint
CREATE POLICY "room_agents_service_role_insert" ON "room_agents" AS PERMISSIVE FOR INSERT TO "service_role" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "room_agents_service_role_update" ON "room_agents" AS PERMISSIVE FOR UPDATE TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "room_agents_service_role_delete" ON "room_agents" AS PERMISSIVE FOR DELETE TO "service_role" USING (true);--> statement-breakpoint
CREATE POLICY "room_listeners_service_role_select" ON "room_listeners" AS PERMISSIVE FOR SELECT TO "service_role" USING (true);--> statement-breakpoint
CREATE POLICY "room_listeners_service_role_insert" ON "room_listeners" AS PERMISSIVE FOR INSERT TO "service_role" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "room_listeners_service_role_update" ON "room_listeners" AS PERMISSIVE FOR UPDATE TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "room_listeners_service_role_delete" ON "room_listeners" AS PERMISSIVE FOR DELETE TO "service_role" USING (true);--> statement-breakpoint
CREATE POLICY "rooms_service_role_select" ON "rooms" AS PERMISSIVE FOR SELECT TO "service_role" USING (true);--> statement-breakpoint
CREATE POLICY "rooms_service_role_insert" ON "rooms" AS PERMISSIVE FOR INSERT TO "service_role" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "rooms_service_role_update" ON "rooms" AS PERMISSIVE FOR UPDATE TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "rooms_service_role_delete" ON "rooms" AS PERMISSIVE FOR DELETE TO "service_role" USING (true);--> statement-breakpoint
CREATE POLICY "transcripts_service_role_select" ON "transcripts" AS PERMISSIVE FOR SELECT TO "service_role" USING (true);--> statement-breakpoint
CREATE POLICY "transcripts_service_role_insert" ON "transcripts" AS PERMISSIVE FOR INSERT TO "service_role" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "transcripts_service_role_update" ON "transcripts" AS PERMISSIVE FOR UPDATE TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "transcripts_service_role_delete" ON "transcripts" AS PERMISSIVE FOR DELETE TO "service_role" USING (true);--> statement-breakpoint
CREATE POLICY "users_service_role_select" ON "users" AS PERMISSIVE FOR SELECT TO "service_role" USING (true);--> statement-breakpoint
CREATE POLICY "users_service_role_insert" ON "users" AS PERMISSIVE FOR INSERT TO "service_role" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "users_service_role_update" ON "users" AS PERMISSIVE FOR UPDATE TO "service_role" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "users_service_role_delete" ON "users" AS PERMISSIVE FOR DELETE TO "service_role" USING (true);--> statement-breakpoint
REVOKE ALL ON TABLE public."agents" FROM anon, authenticated, PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE public."room_agents" FROM anon, authenticated, PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE public."room_listeners" FROM anon, authenticated, PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE public."rooms" FROM anon, authenticated, PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE public."transcripts" FROM anon, authenticated, PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE public."users" FROM anon, authenticated, PUBLIC;

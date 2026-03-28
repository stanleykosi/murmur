/**
 * API-facing moderation facade for Murmur agent output.
 *
 * The API and agent runtime both delegate to the shared moderation helpers in
 * `@murmur/shared` so there is only one canonical blocklist and filter path.
 */

export {
  BLOCKLIST_PATTERNS,
  filterContent,
  type ModerationResult,
} from "@murmur/shared";

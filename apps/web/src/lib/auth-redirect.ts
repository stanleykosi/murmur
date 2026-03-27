/**
 * Canonical auth-redirect helpers for the Murmur web application.
 *
 * Purpose:
 * Validates post-auth redirect targets so public room-entry gates can return a
 * listener to the exact in-app destination they intended without allowing
 * external redirects or introducing parallel query conventions.
 *
 * Scope:
 * This module only handles the single `redirect_url` query parameter used by
 * the Murmur sign-in and sign-up routes. Invalid, missing, or unsupported
 * values always fail back to the canonical `/lobby` destination.
 */

/**
 * Default in-app destination used when no safe redirect target is supplied.
 */
export const DEFAULT_AUTH_REDIRECT_PATH = "/lobby";

/**
 * Internal auth routes supported by the redirect-link builder.
 */
export type AuthRoutePath = "/sign-in" | "/sign-up";

/**
 * Query-string value accepted for `redirect_url`.
 */
type RedirectQueryValue = string | readonly string[] | undefined;

/**
 * Extracts a single query-string value from Next.js search params.
 *
 * Repeated values are rejected instead of silently picking one, keeping the
 * redirect contract explicit and predictable.
 *
 * @param value - Raw query-string value from App Router search params.
 * @returns A single string value or `null` when the input is missing/invalid.
 */
function getSingleRedirectValue(value: RedirectQueryValue): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && value.length === 1) {
    return value[0] ?? null;
  }

  return null;
}

/**
 * Validates an in-app redirect target and falls back to a safe default when
 * the supplied path is absent, malformed, or points outside the Murmur app.
 *
 * @param value - Raw `redirect_url` query value from the current request.
 * @param fallbackPath - Safe default path used when validation fails.
 * @returns A validated internal absolute path such as `/room/123`.
 */
export function getSafeRedirectPath(
  value: RedirectQueryValue,
  fallbackPath = DEFAULT_AUTH_REDIRECT_PATH,
): string {
  const candidate = getSingleRedirectValue(value)?.trim();

  if (!candidate) {
    return fallbackPath;
  }

  if (!candidate.startsWith("/") || candidate.startsWith("//")) {
    return fallbackPath;
  }

  try {
    const parsedUrl = new URL(candidate, "https://murmur.local");

    if (parsedUrl.origin !== "https://murmur.local") {
      return fallbackPath;
    }

    return `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
  } catch {
    return fallbackPath;
  }
}

/**
 * Builds an auth-route href that preserves a validated post-auth destination.
 *
 * @param authRoute - Supported Murmur auth route receiving the redirect param.
 * @param redirectPath - Intended in-app destination after authentication.
 * @returns A route-local href including the canonical `redirect_url` query.
 */
export function buildAuthRedirectHref(
  authRoute: AuthRoutePath,
  redirectPath: string,
): string {
  const safeRedirectPath = getSafeRedirectPath(redirectPath);
  const searchParams = new URLSearchParams({
    redirect_url: safeRedirectPath,
  });

  return `${authRoute}?${searchParams.toString()}`;
}

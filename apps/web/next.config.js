/**
 * Next.js configuration for the Murmur web workspace.
 *
 * This scaffold keeps the app bootable and monorepo-aware while deferring
 * product-specific styling, auth wiring, and feature configuration to later
 * implementation steps.
 */

const path = require("node:path");
const { withSentryConfig } = require("@sentry/nextjs");

/**
 * Validates the Vercel-facing public Sentry DSN before Next.js starts so the
 * deployment fails immediately instead of silently shipping without error
 * reporting.
 *
 * @returns {string} The trimmed DSN value when valid.
 * @throws {Error} When the DSN is missing or not a valid absolute URL.
 */
function requirePublicSentryDsn() {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();

  if (!dsn) {
    throw new Error(
      "NEXT_PUBLIC_SENTRY_DSN is required for apps/web. Set it in Vercel and local env files before building or starting Next.js.",
    );
  }

  try {
    new URL(dsn);
  } catch {
    throw new Error(
      "NEXT_PUBLIC_SENTRY_DSN must be a valid absolute URL for apps/web.",
    );
  }

  return dsn;
}

const publicSentryDsn = requirePublicSentryDsn();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  transpilePackages: ["@murmur/shared"],
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "img.clerk.com",
      },
    ],
  },
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_LIVEKIT_URL: process.env.NEXT_PUBLIC_LIVEKIT_URL,
    NEXT_PUBLIC_CENTRIFUGO_URL: process.env.NEXT_PUBLIC_CENTRIFUGO_URL,
    NEXT_PUBLIC_SENTRY_DSN: publicSentryDsn,
  },
};

module.exports = withSentryConfig(nextConfig, {
  silent: true,
});

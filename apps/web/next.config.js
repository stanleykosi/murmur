/**
 * Next.js configuration for the Murmur web workspace.
 *
 * This scaffold keeps the app bootable and monorepo-aware while deferring
 * product-specific styling, auth wiring, and feature configuration to later
 * implementation steps.
 */

const path = require("node:path");

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
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  },
};

module.exports = nextConfig;

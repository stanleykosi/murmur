/**
 * Canonical Sentry client bootstrap for the Murmur web application.
 *
 * Next.js 16 + Turbopack prefers `instrumentation-client.ts` over the legacy
 * `sentry.client.config.ts` entrypoint, so browser errors and navigation
 * traces are initialized here.
 */

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0,
  environment: process.env.NODE_ENV,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

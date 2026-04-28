/**
 * Canonical Sentry client bootstrap for the Murmur web application.
 *
 * Browser errors and navigation traces are initialized through Next.js'
 * `instrumentation-client.ts` entrypoint.
 */

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0,
  environment: process.env.NODE_ENV,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

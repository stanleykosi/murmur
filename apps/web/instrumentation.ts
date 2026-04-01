/**
 * Canonical Sentry instrumentation hooks for the Murmur web application.
 *
 * Next.js executes this file for server-side startup and request-error hooks,
 * which keeps server rendering failures and nested server-component errors
 * flowing through one supported Sentry entrypoint.
 */

import * as Sentry from "@sentry/nextjs";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.1,
    environment: process.env.NODE_ENV,
  });
}

export const onRequestError = Sentry.captureRequestError;

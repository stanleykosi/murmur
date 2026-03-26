/**
 * Clerk proxy configuration for the Murmur web app.
 *
 * This file enables Clerk request context for App Router server helpers and
 * applies Murmur's canonical admin-route protection policy without introducing
 * alternate auth flows or legacy role fallbacks.
 */

import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isAdminRoute = createRouteMatcher(["/admin(.*)"]);

/**
 * Guards admin routes behind authentication and the canonical admin role.
 *
 * @param auth - Clerk auth helper for the current request.
 * @param request - Incoming Next.js proxy request.
 * @returns A redirect response for non-admin access or nothing for allowed traffic.
 */
export default clerkMiddleware(async (auth, request) => {
  if (!isAdminRoute(request)) {
    return undefined;
  }

  await auth.protect();

  const { sessionClaims } = await auth();

  if (sessionClaims?.metadata?.role !== "admin") {
    return Response.redirect(new URL("/lobby", request.url));
  }

  return undefined;
});

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};

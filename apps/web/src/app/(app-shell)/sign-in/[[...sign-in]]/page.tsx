/**
 * Murmur sign-in route for Clerk-hosted authentication.
 *
 * This server component keeps authentication inside the canonical shared site
 * shell, redirects already-authenticated visitors to the lobby, and applies a
 * Murmur-branded appearance to Clerk's prebuilt sign-in experience.
 */

import { SignIn } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import AuthFrame from "@/components/auth/AuthFrame";
import {
  buildAuthRedirectHref,
  getSafeRedirectPath,
} from "@/lib/auth-redirect";
import { fluidAuthClerkAppearance } from "@/lib/clerk-appearance";

/**
 * Route metadata for the Murmur sign-in experience.
 */
export const metadata: Metadata = {
  title: "Sign In",
};

interface SignInPageProps {
  searchParams?: Promise<{
    redirect_url?: string | string[];
  }>;
}

/**
 * Renders the public Murmur sign-in route.
 *
 * Redirects authenticated visitors to the lobby so the auth surface stays
 * focused on unsigned users, then renders the Murmur-branded Clerk sign-in UI.
 *
 * @param props - App Router search params containing the optional redirect target.
 * @returns The branded sign-in page content.
 */
export default async function SignInPage({
  searchParams,
}: Readonly<SignInPageProps>) {
  const { userId } = await auth();
  const resolvedSearchParams = await searchParams;
  const redirectPath = getSafeRedirectPath(resolvedSearchParams?.redirect_url);

  if (userId !== null) {
    redirect(redirectPath);
  }

  return (
    <AuthFrame
      title="Welcome back to Murmur"
      description="Sign in to re-enter the lobby and drop straight into live AI conversations already in motion."
    >
      <SignIn
        appearance={fluidAuthClerkAppearance}
        fallbackRedirectUrl={redirectPath}
        forceRedirectUrl={redirectPath}
        path="/sign-in"
        routing="path"
        signUpFallbackRedirectUrl={redirectPath}
        signUpForceRedirectUrl={redirectPath}
        signUpUrl={buildAuthRedirectHref("/sign-up", redirectPath)}
      />
    </AuthFrame>
  );
}

/**
 * Murmur sign-up route for Clerk-hosted authentication.
 *
 * This server component keeps account creation inside the canonical shared
 * site shell, redirects already-authenticated visitors to the lobby, and
 * applies Murmur-branded styling to Clerk's prebuilt sign-up flow.
 */

import { SignUp } from "@clerk/nextjs";
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
 * Route metadata for the Murmur sign-up experience.
 */
export const metadata: Metadata = {
  title: "Sign Up",
};

interface SignUpPageProps {
  searchParams?: Promise<{
    redirect_url?: string | string[];
  }>;
}

/**
 * Renders the public Murmur sign-up route.
 *
 * Redirects authenticated visitors to the lobby so account creation stays
 * focused on new listeners, then renders the Murmur-branded Clerk sign-up UI.
 *
 * @param props - App Router search params containing the optional redirect target.
 * @returns The branded sign-up page content.
 */
export default async function SignUpPage({
  searchParams,
}: Readonly<SignUpPageProps>) {
  const { userId } = await auth();
  const resolvedSearchParams = await searchParams;
  const redirectPath = getSafeRedirectPath(resolvedSearchParams?.redirect_url);

  if (userId !== null) {
    redirect(redirectPath);
  }

  return (
    <AuthFrame
      title="Create your Murmur account"
      description="Start listening in seconds, then step into the lobby for live AI conversations already unfolding."
    >
      <SignUp
        appearance={fluidAuthClerkAppearance}
        fallbackRedirectUrl={redirectPath}
        forceRedirectUrl={redirectPath}
        path="/sign-up"
        routing="path"
        signInFallbackRedirectUrl={redirectPath}
        signInForceRedirectUrl={redirectPath}
        signInUrl={buildAuthRedirectHref("/sign-in", redirectPath)}
      />
    </AuthFrame>
  );
}

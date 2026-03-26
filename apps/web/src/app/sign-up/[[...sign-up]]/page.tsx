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
import { fluidAuthClerkAppearance } from "@/lib/clerk-appearance";

/**
 * Route metadata for the Murmur sign-up experience.
 */
export const metadata: Metadata = {
  title: "Sign Up",
};

/**
 * Renders the public Murmur sign-up route.
 *
 * Redirects authenticated visitors to the lobby so account creation stays
 * focused on new listeners, then renders the Murmur-branded Clerk sign-up UI.
 *
 * @returns The branded sign-up page content.
 */
export default async function SignUpPage() {
  const { userId } = await auth();

  if (userId !== null) {
    redirect("/lobby");
  }

  return (
    <AuthFrame
      title="Create your Murmur account"
      description="Start listening in seconds, then step into the lobby for live AI conversations already unfolding."
    >
      <SignUp
        appearance={fluidAuthClerkAppearance}
        fallbackRedirectUrl="/lobby"
        forceRedirectUrl="/lobby"
        path="/sign-up"
        routing="path"
        signInFallbackRedirectUrl="/lobby"
        signInForceRedirectUrl="/lobby"
        signInUrl="/sign-in"
      />
    </AuthFrame>
  );
}

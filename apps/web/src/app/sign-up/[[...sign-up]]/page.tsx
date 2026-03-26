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
import type { ComponentProps, CSSProperties } from "react";

type SignUpAppearance = NonNullable<ComponentProps<typeof SignUp>["appearance"]>;

const AUTH_SECTION_STYLE: CSSProperties = {
  alignItems: "center",
  justifyContent: "center",
  minHeight: "calc(100vh - 14rem)",
};

const AUTH_CONTENT_STYLE: CSSProperties = {
  display: "grid",
  gap: "var(--space-4)",
  width: "min(100%, 32rem)",
};

const AUTH_PANEL_STYLE: CSSProperties = {
  padding: "clamp(var(--space-3), 5vw, var(--space-5))",
};

const AUTH_COPY_STYLE: CSSProperties = {
  display: "grid",
  gap: "var(--space-2)",
  textAlign: "center",
  justifyItems: "center",
};

const AUTH_BODY_STYLE: CSSProperties = {
  maxWidth: "34rem",
};

const signUpAppearance = {
  variables: {
    colorPrimary: "#7c5cff",
    colorBackground: "transparent",
    colorForeground: "#f5f7fa",
    colorMuted: "rgba(255, 255, 255, 0.04)",
    colorMutedForeground: "#a8b0c0",
    colorNeutral: "#232634",
    colorBorder: "#232634",
    colorDanger: "#ff5d73",
    colorInput: "rgba(17, 19, 26, 0.88)",
    colorInputForeground: "#f5f7fa",
    colorShadow: "rgba(0, 0, 0, 0.36)",
    borderRadius: "1rem",
    fontFamily: "var(--font-sans)",
  },
  elements: {
    rootBox: {
      width: "100%",
    },
    cardBox: {
      width: "100%",
      boxShadow: "none",
    },
    card: {
      width: "100%",
      border: "none",
      borderRadius: "calc(var(--radius-card) - 4px)",
      background: "transparent",
      boxShadow: "none",
      padding: 0,
      gap: "var(--space-3)",
    },
    main: {
      gap: "var(--space-3)",
    },
    header: {
      display: "none",
    },
    footer: {
      background: "transparent",
      padding: 0,
    },
    footerActionText: {
      color: "var(--color-text-muted)",
    },
    footerActionLink: {
      color: "var(--agent-nova)",
      fontWeight: 600,
    },
    formButtonPrimary: {
      minHeight: "44px",
      border: "1px solid rgba(124, 92, 255, 0.34)",
      borderRadius: "999px",
      background:
        "linear-gradient(135deg, rgba(124, 92, 255, 0.92), rgba(0, 212, 255, 0.56))",
      boxShadow: "0 18px 36px rgba(59, 43, 121, 0.32)",
      color: "var(--color-text-primary)",
      fontSize: "var(--font-size-body)",
      fontWeight: 600,
    },
    formFieldLabel: {
      color: "var(--color-text-secondary)",
      fontSize: "var(--font-size-micro)",
      fontWeight: 600,
    },
    formFieldInput: {
      minHeight: "46px",
      border: "1px solid var(--color-border)",
      borderRadius: "var(--radius-soft)",
      background: "rgba(17, 19, 26, 0.88)",
      color: "var(--color-text-primary)",
      boxShadow: "none",
    },
    formFieldInputShowPasswordButton: {
      color: "var(--color-text-muted)",
    },
    dividerLine: {
      background: "rgba(255, 255, 255, 0.08)",
    },
    dividerText: {
      color: "var(--color-text-muted)",
      fontSize: "var(--font-size-micro)",
    },
    socialButtonsBlockButton: {
      minHeight: "46px",
      border: "1px solid rgba(255, 255, 255, 0.08)",
      borderRadius: "var(--radius-soft)",
      background: "rgba(255, 255, 255, 0.04)",
      boxShadow: "none",
      color: "var(--color-text-primary)",
    },
    socialButtonsBlockButtonText: {
      fontSize: "var(--font-size-body)",
      fontWeight: 500,
    },
    formResendCodeLink: {
      color: "var(--agent-nova)",
    },
    otpCodeFieldInput: {
      border: "1px solid var(--color-border)",
      borderRadius: "var(--radius-soft)",
      background: "rgba(17, 19, 26, 0.88)",
      color: "var(--color-text-primary)",
    },
    alert: {
      borderRadius: "var(--radius-soft)",
      border: "1px solid rgba(255, 93, 115, 0.28)",
      background: "rgba(255, 93, 115, 0.08)",
    },
    formFieldErrorText: {
      color: "var(--color-danger)",
    },
    identityPreviewEditButton: {
      color: "var(--agent-nova)",
    },
  },
} satisfies SignUpAppearance;

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
    <section className="page-shell" style={AUTH_SECTION_STYLE}>
      <div className="fade-up" style={AUTH_CONTENT_STYLE}>
        <div style={AUTH_COPY_STYLE}>
          <span className="section-label">Live AI audio</span>
          <h1>Create your Murmur account</h1>
          <p style={AUTH_BODY_STYLE}>
            Start listening in seconds, then head to the lobby for live AI
            conversations already in motion.
          </p>
        </div>

        <div className="glass-card" style={AUTH_PANEL_STYLE}>
          <SignUp
            appearance={signUpAppearance}
            fallbackRedirectUrl="/lobby"
            forceRedirectUrl="/lobby"
            path="/sign-up"
            routing="path"
            signInFallbackRedirectUrl="/lobby"
            signInForceRedirectUrl="/lobby"
            signInUrl="/sign-in"
          />
        </div>
      </div>
    </section>
  );
}

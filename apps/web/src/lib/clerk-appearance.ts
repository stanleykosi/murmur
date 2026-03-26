import type { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/ui/themes";

type ClerkTheme = NonNullable<
  NonNullable<Parameters<typeof ClerkProvider>[0]["appearance"]>["theme"]
>;

const fluidClerkTheme = dark as ClerkTheme;

const fluidClerkVariables = {
  colorPrimary: "#BD00FF",
  colorBackground: "transparent",
  colorForeground: "#E5E7EB",
  colorMuted: "rgba(229, 231, 235, 0.06)",
  colorMutedForeground: "rgba(229, 231, 235, 0.62)",
  colorNeutral: "rgba(229, 231, 235, 0.15)",
  colorBorder: "rgba(229, 231, 235, 0.15)",
  colorDanger: "#F18DA9",
  colorInput: "rgba(17, 18, 22, 0.16)",
  colorInputForeground: "#E5E7EB",
  colorShadow: "rgba(229, 231, 235, 0.1)",
  borderRadius: "24px",
  fontFamily: "var(--font-sans)",
} as const;

export const fluidClerkAppearance = {
  theme: fluidClerkTheme,
  variables: fluidClerkVariables,
} as const;

export const fluidAuthClerkAppearance = {
  theme: fluidClerkTheme,
  variables: fluidClerkVariables,
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
      borderRadius: "0px",
      background: "transparent",
      boxShadow: "none",
      padding: 0,
      gap: "var(--space-5)",
    },
    main: {
      gap: "var(--space-4)",
    },
    header: {
      display: "none",
    },
    footer: {
      background: "transparent",
      padding: 0,
    },
    footerActionText: {
      color: "var(--on-surface-muted)",
      fontSize: "var(--label-sm)",
      letterSpacing: "0.12em",
      textTransform: "uppercase",
    },
    footerActionLink: {
      color: "var(--primary)",
      fontWeight: 500,
    },
    formButtonPrimary: {
      minHeight: "52px",
      border: "1px solid rgba(189, 0, 255, 0.18)",
      borderRadius: "999px",
      background:
        "linear-gradient(135deg, rgba(189, 0, 255, 0.94), rgba(122, 0, 181, 0.94))",
      boxShadow: "0 24px 48px -22px rgba(189, 0, 255, 0.42)",
      color: "var(--on-primary-container)",
      fontSize: "var(--label-md)",
      fontWeight: 500,
      letterSpacing: "0.16em",
      textTransform: "uppercase",
    },
    formFieldLabel: {
      color: "var(--on-surface-muted)",
      fontSize: "var(--label-sm)",
      fontWeight: 500,
      letterSpacing: "0.12em",
      textTransform: "uppercase",
    },
    formFieldInput: {
      minHeight: "52px",
      border: "none",
      borderBottom: "1px solid rgba(229, 231, 235, 0.15)",
      borderRadius: "1rem 1rem 0 0",
      background: "rgba(255, 255, 255, 0.02)",
      color: "var(--on-surface)",
      boxShadow: "inset 0 -2px 0 rgba(189, 0, 255, 0)",
    },
    formFieldInputShowPasswordButton: {
      color: "var(--on-surface-muted)",
    },
    dividerLine: {
      background: "rgba(229, 231, 235, 0.08)",
    },
    dividerText: {
      color: "var(--on-surface-subdued)",
      fontSize: "var(--label-sm)",
      letterSpacing: "0.12em",
      textTransform: "uppercase",
    },
    socialButtonsBlockButton: {
      minHeight: "52px",
      border: "1px solid rgba(229, 231, 235, 0.15)",
      borderRadius: "999px",
      background: "rgba(34, 36, 44, 0.82)",
      boxShadow: "none",
      color: "var(--on-surface)",
      backdropFilter: "blur(22px)",
    },
    socialButtonsBlockButtonText: {
      fontSize: "var(--label-md)",
      fontWeight: 500,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
    },
    formResendCodeLink: {
      color: "var(--primary)",
    },
    otpCodeFieldInput: {
      border: "none",
      borderBottom: "1px solid rgba(229, 231, 235, 0.15)",
      borderRadius: "1rem 1rem 0 0",
      background: "rgba(255, 255, 255, 0.02)",
      color: "var(--on-surface)",
    },
    alert: {
      borderRadius: "2rem 1.25rem 2rem 1.25rem",
      border: "1px solid rgba(241, 141, 169, 0.22)",
      background: "rgba(241, 141, 169, 0.08)",
      color: "#F5C0D0",
    },
    formFieldErrorText: {
      color: "#F5C0D0",
    },
    identityPreviewEditButton: {
      color: "var(--primary)",
    },
  },
} as const;

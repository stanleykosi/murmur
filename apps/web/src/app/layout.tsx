/**
 * Root App Router layout for the Murmur frontend scaffold.
 *
 * This minimal shell establishes the document structure and metadata expected
 * by Next.js while intentionally deferring theming, auth providers, and shared
 * chrome to later implementation steps.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * Static metadata for the scaffolded frontend entrypoint.
 */
export const metadata: Metadata = {
  title: "Murmur",
  description:
    "Listen to live AI-hosted conversations in a real-time audio experience.",
};

interface RootLayoutProps {
  children: ReactNode;
}

/**
 * Renders the canonical document shell for all frontend routes.
 *
 * @param props - Layout props provided by Next.js App Router.
 * @param props.children - The routed page content for the current request.
 * @returns The minimal HTML document used across the frontend workspace.
 */
export default function RootLayout({
  children,
}: Readonly<RootLayoutProps>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

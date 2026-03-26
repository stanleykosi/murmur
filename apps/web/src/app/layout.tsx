/**
 * Root App Router layout for the Murmur frontend.
 *
 * This layout owns the canonical application shell: global styles, runtime
 * fonts, Clerk authentication context, SEO metadata, and the persistent
 * header/footer chrome shared across all routes.
 */

import "@/styles/globals.css";

import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Newsreader, Space_Grotesk } from "next/font/google";
import type { ReactNode } from "react";

import ToastProvider from "@/components/ui/Toast";
import { fluidClerkAppearance } from "@/lib/clerk-appearance";

const newsreader = Newsreader({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const DEFAULT_DESCRIPTION =
  "Listen to live AI-hosted conversations in a real-time audio experience.";

/**
 * Default metadata shared across the current Murmur frontend surface.
 */
export const metadata: Metadata = {
  title: {
    default: "Murmur",
    template: "%s | Murmur",
  },
  description: DEFAULT_DESCRIPTION,
  openGraph: {
    title: "Murmur",
    description: DEFAULT_DESCRIPTION,
    siteName: "Murmur",
    type: "website",
  },
};

interface RootLayoutProps {
  children: ReactNode;
}

/**
 * Renders the canonical document shell for all frontend routes.
 *
 * @param props - Layout props provided by Next.js App Router.
 * @param props.children - The routed page content for the current request.
 * @returns The fully themed frontend document structure.
 */
export default function RootLayout({
  children,
}: Readonly<RootLayoutProps>) {
  return (
    <html lang="en">
      <body className={[newsreader.variable, spaceGrotesk.variable].join(" ")}>
        <ClerkProvider appearance={fluidClerkAppearance}>
          <ToastProvider>
            {children}
          </ToastProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}

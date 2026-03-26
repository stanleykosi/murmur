/**
 * Root App Router layout for the Murmur frontend.
 *
 * This layout owns the canonical application shell: global styles, runtime
 * fonts, Clerk authentication context, SEO metadata, and the persistent
 * header/footer chrome shared across all routes.
 */

import "@/styles/globals.css";

import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/ui/themes";
import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";

import Footer from "@/components/layout/Footer";
import Header from "@/components/layout/Header";

type ClerkTheme = NonNullable<
  NonNullable<Parameters<typeof ClerkProvider>[0]["appearance"]>["theme"]
>;

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

const DEFAULT_DESCRIPTION =
  "Listen to live AI-hosted conversations in a real-time audio experience.";

// Clerk's exported prebuilt themes are currently wider than the provider prop
// under `exactOptionalPropertyTypes`, so we narrow the value once here.
const clerkDarkTheme = dark as ClerkTheme;

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
      <body className={[inter.variable, jetBrainsMono.variable].join(" ")}>
        <ClerkProvider appearance={{ theme: clerkDarkTheme }}>
          <div className="site-shell">
            <Header />
            <main className="site-main">
              <div className="page-container page-shell">{children}</div>
            </main>
            <Footer />
          </div>
        </ClerkProvider>
      </body>
    </html>
  );
}

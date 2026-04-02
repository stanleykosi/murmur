import type { ReactNode } from "react";

import Footer from "@/components/layout/Footer";
import Header from "@/components/layout/Header";

interface AppShellLayoutProps {
  children: ReactNode;
}

/**
 * Shared application shell for non-marketing routes.
 */
export default function AppShellLayout({
  children,
}: Readonly<AppShellLayoutProps>) {
  return (
    <div className="site-shell">
      <Header />
      <main className="site-main">
        <div className="page-container app-shell__content">{children}</div>
      </main>
      <Footer />
    </div>
  );
}

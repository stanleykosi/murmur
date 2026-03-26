import type { ReactNode } from "react";

interface AuthFrameProps {
  children: ReactNode;
  description: string;
  title: string;
}

/**
 * Shared editorial auth shell used by the Clerk sign-in and sign-up routes.
 */
export default function AuthFrame({
  children,
  description,
  title,
}: Readonly<AuthFrameProps>) {
  return (
    <section className="auth-shell">
      <div className="auth-frame fade-up">
        <div className="auth-copy">
          <span className="section-label">Live AI audio</span>
          <h1>{title}</h1>
          <p className="auth-body">{description}</p>
        </div>

        <div className="glass-card auth-panel">{children}</div>
      </div>
    </section>
  );
}

/**
 * Temporary landing page for the Murmur frontend scaffold.
 *
 * The page stays intentionally light so the dedicated design-system and
 * navigation steps can build on a clean baseline without rework.
 */

/**
 * Renders a placeholder homepage while the lobby and live-room experiences are
 * implemented in later plan steps.
 *
 * @returns A semantic, low-styling landing page for the scaffolded frontend.
 */
export default function HomePage() {
  return (
    <section
      className="glass-card fade-up"
      style={{ padding: "var(--space-4)" }}
    >
      <h1>Murmur</h1>
      <p>
        The Next.js frontend scaffold is in place. The room lobby, live audio
        experience, and shared design system land in the next implementation
        steps.
      </p>
    </section>
  );
}

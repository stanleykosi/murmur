/**
 * Persistent footer for the Murmur frontend shell.
 *
 * The footer intentionally stays minimal so later feature pages can inherit a
 * consistent application frame without introducing competing calls to action.
 */

/**
 * Renders the shared footer chrome used across the current frontend.
 *
 * @returns The canonical Murmur footer.
 */
export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="site-footer">
      <div className="page-container site-footer__inner">
        <div className="site-footer__meta">
          <span className="section-label">The Fluid Architect</span>
          <p>&copy; {currentYear} Murmur</p>
        </div>
        <p className="site-footer__tagline">
          Live AI listening rooms framed in signal and shadow.
        </p>
      </div>
    </footer>
  );
}

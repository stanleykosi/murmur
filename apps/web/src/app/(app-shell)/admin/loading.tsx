/**
 * Route-level loading shell for the Murmur admin dashboard.
 *
 * This skeleton mirrors the premium operator layout closely enough that the
 * admin route feels stable while Clerk auth and the admin room feed resolve.
 */

import Skeleton from "@/components/ui/Skeleton";

/**
 * Renders the loading state for `/admin`.
 *
 * @returns The canonical admin loading shell.
 */
export default function AdminLoadingPage() {
  return (
    <div className="page-shell admin-page">
      <section className="admin-hero glass-card">
        <div className="admin-hero__copy">
          <Skeleton width="8rem" height="0.85rem" borderRadius="999px" />
          <Skeleton width="15rem" height="0.85rem" borderRadius="999px" />
          <Skeleton width="78%" height="4rem" borderRadius="1.8rem" />
          <Skeleton width="100%" height="1rem" borderRadius="999px" />
          <Skeleton width="84%" height="1rem" borderRadius="999px" />
        </div>

        <div className="admin-hero__panel">
          <div className="admin-hero__signal">
            <Skeleton width="9rem" height="9rem" borderRadius="999px" />
          </div>

          <div className="admin-hero__principles">
            <Skeleton width="100%" height="4.5rem" borderRadius="1.6rem" />
            <Skeleton width="100%" height="4.5rem" borderRadius="1.6rem" />
            <Skeleton width="100%" height="4.5rem" borderRadius="1.6rem" />
          </div>
        </div>
      </section>

      <section className="admin-operations">
        <div className="admin-operations__header">
          <div className="admin-operations__copy">
            <Skeleton width="9rem" height="0.85rem" borderRadius="999px" />
            <Skeleton width="55%" height="2.2rem" borderRadius="1.2rem" />
            <Skeleton width="100%" height="1rem" borderRadius="999px" />
          </div>

          <Skeleton width="12rem" height="2rem" borderRadius="999px" />
        </div>

        <div className="admin-summary-grid">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="admin-summary-card glass-card">
              <Skeleton width="6rem" height="0.85rem" borderRadius="999px" />
              <Skeleton width="4rem" height="2.4rem" borderRadius="1rem" />
              <Skeleton width="100%" height="1rem" borderRadius="999px" />
            </div>
          ))}
        </div>

        <div className="admin-room-list" data-testid="admin-room-list">
          {Array.from({ length: 3 }).map((_, index) => (
            <article key={index} className="admin-room-card glass-card">
              <div className="admin-room-card__header">
                <div className="admin-room-card__identity">
                  <Skeleton width="7rem" height="0.85rem" borderRadius="999px" />
                  <Skeleton width="52%" height="2rem" borderRadius="1rem" />
                  <Skeleton width="100%" height="1rem" borderRadius="999px" />
                  <Skeleton width="86%" height="1rem" borderRadius="999px" />
                </div>

                <div className="admin-room-card__badges">
                  <Skeleton width="5.5rem" height="2.15rem" borderRadius="999px" />
                  <Skeleton width="6rem" height="2.15rem" borderRadius="999px" />
                </div>
              </div>

              <div className="admin-room-meta">
                {Array.from({ length: 4 }).map((_, metaIndex) => (
                  <div key={metaIndex} className="admin-room-meta__item">
                    <Skeleton width="4.5rem" height="0.85rem" borderRadius="999px" />
                    <Skeleton width="80%" height="1.3rem" borderRadius="0.9rem" />
                  </div>
                ))}
              </div>

              <div className="admin-room-actions">
                <Skeleton width="7.5rem" height="2.6rem" borderRadius="999px" />
                <Skeleton width="9rem" height="2.6rem" borderRadius="999px" />
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

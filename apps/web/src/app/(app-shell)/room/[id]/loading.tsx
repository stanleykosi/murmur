/**
 * Route-level loading UI for the room scaffold.
 *
 * This mirrors the read-only listening deck so the route feels clean and
 * intentional while room data is fetched.
 */

import Card from "@/components/ui/Card";
import Skeleton from "@/components/ui/Skeleton";

/**
 * Renders the pending-state UI for `/room/[id]`.
 *
 * @returns The room scaffold loading state.
 */
export default function RoomLoadingPage() {
  return (
    <div className="page-shell">
      <section className="room-header glass-card">
        <div className="room-header__topline">
          <div className="room-header__status-cluster">
            <Skeleton width="7rem" height="0.85rem" borderRadius="999px" />
            <div className="room-header__status-pills">
              <Skeleton width="5rem" height="2.15rem" borderRadius="999px" />
              <Skeleton width="9rem" height="2.5rem" borderRadius="999px" />
            </div>
          </div>

          <Skeleton width="7.25rem" height="2.5rem" borderRadius="999px" />
        </div>

        <div className="room-header__copy">
          <Skeleton width="65%" height="3.4rem" borderRadius="1.6rem" />
          <Skeleton width="100%" height="1rem" borderRadius="999px" />
          <Skeleton width="82%" height="1rem" borderRadius="999px" />
        </div>
      </section>

      <div className="room-layout">
        <div className="room-preview-stack">
          <section className="room-stage glass-card">
            <div className="room-stage__grid room-stage-skeleton">
              <Skeleton width="7rem" height="9rem" borderRadius="999px" />
              <Skeleton width="9rem" height="12rem" borderRadius="999px" />
              <Skeleton width="7rem" height="9rem" borderRadius="999px" />
            </div>
          </section>

          <Card className="room-preview-brief">
            <div className="room-preview-brief__top">
              <div className="room-preview-brief__intro">
                <Skeleton width="8rem" height="0.85rem" borderRadius="999px" />
                <Skeleton width="100%" height="1rem" borderRadius="999px" />
                <Skeleton width="78%" height="1rem" borderRadius="999px" />
              </div>

              <Skeleton width="7rem" height="2.15rem" borderRadius="999px" />
            </div>

            <div className="room-preview-brief__grid">
              <Skeleton width="100%" height="6rem" borderRadius="1.4rem" />
              <Skeleton width="100%" height="6rem" borderRadius="1.4rem" />
              <Skeleton width="100%" height="6rem" borderRadius="1.4rem" />
            </div>
          </Card>
        </div>

        <section className="room-transcript-panel glass-card">
          <div className="room-transcript-panel__header">
            <div className="room-transcript-panel__heading">
              <Skeleton width="7rem" height="0.85rem" borderRadius="999px" />
              <Skeleton width="11rem" height="2rem" borderRadius="1rem" />
            </div>

            <Skeleton width="10rem" height="2.1rem" borderRadius="999px" />
          </div>

          <div className="room-transcript-panel__viewport">
            <div className="room-transcript-panel__messages">
              <Skeleton width="100%" height="6.25rem" borderRadius="1.5rem" />
              <Skeleton width="100%" height="7rem" borderRadius="1.5rem" />
              <Skeleton width="100%" height="6.5rem" borderRadius="1.5rem" />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

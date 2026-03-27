/**
 * Route-level loading UI for the canonical live-room route.
 *
 * This mirrors the final live-room composition closely enough that the route
 * feels stable while the server validation and client runtime initialize.
 */

import Skeleton from "@/components/ui/Skeleton";

/**
 * Renders the pending-state UI for `/room/[id]`.
 *
 * @returns The canonical live-room loading shell.
 */
export default function RoomLoadingPage() {
  return (
    <div className="page-shell room-live-page">
      <div className="room-live-shell">
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
          <div className="room-live-shell__stage-column">
            <section className="room-stage glass-card">
              <div className="room-stage__grid room-stage-skeleton">
                <Skeleton width="7rem" height="9rem" borderRadius="999px" />
                <Skeleton width="9rem" height="12rem" borderRadius="999px" />
                <Skeleton width="7rem" height="9rem" borderRadius="999px" />
              </div>
            </section>

            <section className="room-audio-permission glass-card">
              <div className="room-audio-permission__copy">
                <Skeleton width="7rem" height="0.85rem" borderRadius="999px" />
                <Skeleton width="75%" height="2.1rem" borderRadius="1rem" />
                <Skeleton width="100%" height="1rem" borderRadius="999px" />
                <Skeleton width="84%" height="1rem" borderRadius="999px" />
              </div>

              <Skeleton width="12rem" height="3rem" borderRadius="999px" />
            </section>
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

        <section className="room-audio-controls glass-card room-audio-controls--loading">
          <div className="room-audio-controls__cluster">
            <Skeleton width="11rem" height="3.25rem" borderRadius="1.4rem" />

            <div className="room-audio-controls__slider-block">
              <div className="room-audio-controls__slider-meta">
                <Skeleton width="5rem" height="0.85rem" borderRadius="999px" />
                <Skeleton width="3rem" height="0.85rem" borderRadius="999px" />
              </div>
              <Skeleton width="100%" height="0.85rem" borderRadius="999px" />
            </div>
          </div>

          <Skeleton width="8rem" height="3rem" borderRadius="999px" />
        </section>
      </div>
    </div>
  );
}

/**
 * Route-level loading UI for the room scaffold.
 *
 * This mirrors the eventual room overview enough that listeners see a stable
 * shell while room data is fetched.
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
    <div className="page-shell room-overview-page">
      <section className="room-overview-hero glass-card">
        <div className="room-overview-hero__copy">
          <Skeleton width="8rem" height="0.85rem" borderRadius="999px" />
          <Skeleton width="70%" height="3.4rem" borderRadius="1.6rem" />
          <Skeleton width="100%" height="1rem" borderRadius="999px" />
          <Skeleton width="84%" height="1rem" borderRadius="999px" />
        </div>

        <div className="room-overview-hero__actions">
          <Skeleton width="5rem" height="2.15rem" borderRadius="999px" />
          <Skeleton width="7.2rem" height="2.15rem" borderRadius="999px" />
          <Skeleton width="7.4rem" height="2.15rem" borderRadius="999px" />
        </div>
      </section>

      <div className="room-overview-layout">
        <Card className="room-overview-panel">
          <div className="room-overview-panel__header">
            <Skeleton width="9rem" height="0.85rem" borderRadius="999px" />
            <Skeleton width="100%" height="1rem" borderRadius="999px" />
          </div>

          <div className="room-overview-agents">
            <Skeleton width="100%" height="4.4rem" borderRadius="1.4rem" />
            <Skeleton width="100%" height="4.4rem" borderRadius="1.4rem" />
            <Skeleton width="100%" height="4.4rem" borderRadius="1.4rem" />
          </div>
        </Card>

        <Card className="room-overview-panel">
          <div className="room-overview-panel__header">
            <Skeleton width="10rem" height="0.85rem" borderRadius="999px" />
            <Skeleton width="100%" height="1rem" borderRadius="999px" />
          </div>

          <div className="room-overview-stats">
            <Skeleton width="100%" height="4.4rem" borderRadius="1.4rem" />
            <Skeleton width="100%" height="4.4rem" borderRadius="1.4rem" />
            <Skeleton width="100%" height="4.4rem" borderRadius="1.4rem" />
          </div>
        </Card>
      </div>
    </div>
  );
}

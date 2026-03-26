/**
 * Route-level loading UI for the ISR room lobby.
 *
 * The loading view mirrors the final page structure closely enough that the
 * lobby does not jump dramatically when the streamed room grid resolves.
 */

import RoomGridSkeleton from "@/components/lobby/RoomGridSkeleton";
import Skeleton from "@/components/ui/Skeleton";

/**
 * Renders the pending-state UI for `/lobby`.
 *
 * @returns The loading shell shown while the room feed resolves.
 */
export default function LobbyLoadingPage() {
  return (
    <div className="page-shell lobby-page">
      <section className="lobby-hero glass-card">
        <div className="lobby-hero__copy">
          <Skeleton width="9rem" height="0.85rem" borderRadius="999px" />
          <Skeleton width="78%" height="3.6rem" borderRadius="1.5rem" />
          <Skeleton width="100%" height="1rem" borderRadius="999px" />
          <Skeleton width="84%" height="1rem" borderRadius="999px" />
        </div>

        <div className="lobby-hero__panel">
          <Skeleton width="5.5rem" height="5.5rem" borderRadius="999px" />
          <div className="lobby-hero__metrics">
            <Skeleton width="100%" height="4rem" borderRadius="1.4rem" />
            <Skeleton width="100%" height="4rem" borderRadius="1.4rem" />
            <Skeleton width="100%" height="4rem" borderRadius="1.4rem" />
          </div>
        </div>
      </section>

      <RoomGridSkeleton />
    </div>
  );
}

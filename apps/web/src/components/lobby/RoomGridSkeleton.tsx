/**
 * Loading grid for the Murmur lobby.
 *
 * The real room grid is client-rendered so it can own local filter state. This
 * server-safe skeleton keeps route loading states and suspense fallbacks
 * consistent without turning the loading UI into a client bundle dependency.
 */

import Card from "@/components/ui/Card";
import Skeleton from "@/components/ui/Skeleton";

/**
 * Public props for the room-grid skeleton helper.
 */
export interface RoomGridSkeletonProps {
  count?: number;
}

/**
 * Creates the stable iteration indices used by the loading grid.
 *
 * @param count - Number of loading cards to render.
 * @returns A deterministic index array.
 */
function buildIndices(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

/**
 * Renders the canonical six-card room-grid loading state.
 *
 * @param props - Optional card-count override for special cases.
 * @returns A non-interactive skeleton grid that mirrors room-card structure.
 */
export default function RoomGridSkeleton({
  count = 6,
}: Readonly<RoomGridSkeletonProps>) {
  return (
    <div className="lobby-skeleton-grid" aria-hidden="true">
      {buildIndices(count).map((index) => (
        <Card key={index} className="room-card-skeleton">
          <div className="room-card-skeleton__top">
            <Skeleton width="5.4rem" height="2.15rem" borderRadius="999px" />
            <Skeleton width="6.8rem" height="2.15rem" borderRadius="999px" />
          </div>

          <div className="room-card-skeleton__body">
            <Skeleton width="5.2rem" height="0.85rem" borderRadius="999px" />
            <Skeleton width="72%" height="1.9rem" borderRadius="1rem" />
            <Skeleton width="100%" height="0.95rem" borderRadius="999px" />
            <Skeleton width="88%" height="0.95rem" borderRadius="999px" />
          </div>

          <div className="room-card-skeleton__footer">
            <div className="room-card-skeleton__avatars">
              <Skeleton width="2.9rem" height="2.9rem" borderRadius="999px" />
              <Skeleton width="2.45rem" height="2.45rem" borderRadius="999px" />
              <Skeleton width="2.45rem" height="2.45rem" borderRadius="999px" />
            </div>
            <Skeleton width="68%" height="0.95rem" borderRadius="999px" />
          </div>
        </Card>
      ))}
    </div>
  );
}

"use client";

import RouteErrorState, {
  type RouteErrorPageProps,
} from "@/components/layout/RouteErrorState";

export default function RoomErrorPage({
  error,
  reset,
}: Readonly<RouteErrorPageProps>) {
  return (
    <RouteErrorState
      error={error}
      pageClassName="room-live-page"
      stateClassName="room-error"
      sectionLabel="Room Unavailable"
      title="Room not found or has ended"
      description="This Murmur conversation is no longer available as a live room. Retry the lookup or return to the lobby to choose another room."
      retryLabel="Retry room"
      returnHref="/lobby"
      returnLabel="Return to lobby"
      onRetry={reset}
    />
  );
}

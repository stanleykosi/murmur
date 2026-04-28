"use client";

import RouteErrorState, {
  type RouteErrorPageProps,
} from "@/components/layout/RouteErrorState";

export default function LobbyErrorPage({
  error,
  reset,
}: Readonly<RouteErrorPageProps>) {
  return (
    <RouteErrorState
      error={error}
      pageClassName="lobby-page"
      stateClassName="lobby-error"
      sectionLabel="Feed Interrupted"
      title="Unable to load rooms"
      description="The lobby could not reach the live room feed just now. Retry the request or head back to the public homepage while the signal settles."
      retryLabel="Retry lobby"
      returnHref="/"
      returnLabel="Return home"
      onRetry={reset}
    />
  );
}

"use client";

import RouteErrorState, {
  type RouteErrorPageProps,
} from "@/components/layout/RouteErrorState";

export default function AdminErrorPage({
  error,
  reset,
}: Readonly<RouteErrorPageProps>) {
  return (
    <RouteErrorState
      error={error}
      pageClassName="admin-page"
      stateClassName="admin-error"
      sectionLabel="Operator feed interrupted"
      title="Unable to load room operations"
      description="The admin dashboard could not load the latest room controls just now. Retry the request or return to the lobby while the operator connection settles."
      retryLabel="Try again"
      returnHref="/lobby"
      returnLabel="Return to lobby"
      onRetry={reset}
    />
  );
}

"use client";

import Link from "next/link";
import { useEffect } from "react";

import Button from "@/components/ui/Button";

export interface RouteErrorPageProps {
  error: Error & {
    digest?: string;
  };
  reset: () => void;
}

interface RouteErrorStateProps {
  error: RouteErrorPageProps["error"];
  pageClassName: string;
  stateClassName: string;
  sectionLabel: string;
  title: string;
  description: string;
  retryLabel: string;
  returnHref: string;
  returnLabel: string;
  onRetry: () => void;
}

export default function RouteErrorState({
  error,
  pageClassName,
  stateClassName,
  sectionLabel,
  title,
  description,
  retryLabel,
  returnHref,
  returnLabel,
  onRetry,
}: Readonly<RouteErrorStateProps>) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className={`page-shell ${pageClassName}`}>
      <section className={`${stateClassName} glass-card fade-up`}>
        <div className={`${stateClassName}__copy`}>
          <span className="section-label">{sectionLabel}</span>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>

        <div className={`${stateClassName}__actions`}>
          <Button size="lg" onClick={onRetry}>
            {retryLabel}
          </Button>
          <Link
            href={returnHref}
            className="ui-button ui-button--ghost ui-button--lg"
          >
            {returnLabel}
          </Link>
        </div>
      </section>
    </div>
  );
}

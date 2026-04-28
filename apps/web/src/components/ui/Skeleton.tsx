import type { CSSProperties, HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export interface SkeletonProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  borderRadius?: CSSProperties["borderRadius"];
}

export default function Skeleton({
  borderRadius = "2rem 1rem 2rem 1rem",
  className,
  height = "1rem",
  style,
  width = "100%",
  ...rest
}: Readonly<SkeletonProps>) {
  return (
    <div
      aria-hidden="true"
      role="presentation"
      className={cn(
        "ui-skeleton",
        "skeleton-shimmer",
        className,
      )}
      style={{
        width,
        height,
        borderRadius,
        ...style,
      }}
      {...rest}
    />
  );
}

/**
 * Reusable skeleton placeholder for Murmur.
 *
 * Purpose:
 * Standardizes loading placeholders across future lobby, room, and admin
 * interfaces while keeping sizing configurable at the call site.
 *
 * Scope:
 * This component exposes only the current design-system needs for Step 14 and
 * intentionally avoids introducing a larger placeholder API surface.
 */

import type { CSSProperties, HTMLAttributes } from "react";

/**
 * Public props for the skeleton primitive.
 */
export interface SkeletonProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  borderRadius?: CSSProperties["borderRadius"];
}

/**
 * Concatenates CSS class names without relying on a later shared helper.
 *
 * @param classNames - Candidate class names including falsy values.
 * @returns A normalized class string.
 */
function joinClassNames(
  ...classNames: Array<string | false | null | undefined>
): string {
  return classNames.filter(Boolean).join(" ");
}

/**
 * Renders a shimmer loading placeholder with configurable dimensions.
 *
 * @param props - Sizing, style, and HTML div props.
 * @returns A presentational skeleton element.
 */
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
      className={joinClassNames(
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

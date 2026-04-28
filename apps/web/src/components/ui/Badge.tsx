import type { RoomFormat } from "@murmur/shared";
import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

type BadgeBaseProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  className?: string;
};

type DefaultBadgeProps = BadgeBaseProps & {
  variant?: "default";
  children: ReactNode;
};

type LiveBadgeProps = BadgeBaseProps & {
  variant: "live";
  children?: ReactNode;
};

type FormatBadgeProps = BadgeBaseProps & {
  variant: "format";
  format: RoomFormat;
  children?: never;
};

type ListenerCountBadgeProps = BadgeBaseProps & {
  variant: "listener-count";
  count: number;
  children?: never;
};

export type BadgeProps =
  | DefaultBadgeProps
  | LiveBadgeProps
  | FormatBadgeProps
  | ListenerCountBadgeProps;

function formatRoomFormatLabel(format: RoomFormat): string {
  return format === "free_for_all" ? "Free-for-all" : "Moderated";
}

function HeadphonesIcon() {
  return (
    <svg
      className="ui-badge__icon"
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M3.5 8.167a4.5 4.5 0 0 1 9 0V12a1 1 0 0 1-1 1h-.667a1 1 0 0 1-1-1V9.833a1 1 0 0 1 1-1H11a3 3 0 1 0-6 0h.167a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V8.167Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function Badge(props: Readonly<BadgeProps>) {
  if (props.variant === "format") {
    const { className, format, ...rest } = props;

    return (
      <span
        className={cn(
          "ui-badge",
          "ui-badge--format",
          format === "free_for_all"
            ? "ui-badge--format-free-for-all"
            : "ui-badge--format-moderated",
          className,
        )}
        {...rest}
      >
        {formatRoomFormatLabel(format)}
      </span>
    );
  }

  if (props.variant === "listener-count") {
    const { className, count, ...rest } = props;
    const formattedCount = new Intl.NumberFormat("en-US").format(count);
    const ariaLabel =
      count === 1 ? "1 listener in room" : `${formattedCount} listeners in room`;

    return (
      <span
        className={cn(
          "ui-badge",
          "ui-badge--listener-count",
          className,
        )}
        aria-label={ariaLabel}
        {...rest}
      >
        <HeadphonesIcon />
        <span className="ui-badge__count mono">{formattedCount}</span>
      </span>
    );
  }

  if (props.variant === "live") {
    const { className, children, ...rest } = props;

    return (
      <span
        className={cn(
          "ui-badge",
          "ui-badge--live",
          className,
        )}
        {...rest}
      >
        <span className="live-badge__dot" aria-hidden="true" />
        <span>{children ?? "LIVE"}</span>
      </span>
    );
  }

  const { className, children, variant: _variant, ...rest } = props;

  return (
    <span
      className={cn("ui-badge", "ui-badge--default", className)}
      {...rest}
    >
      {children}
    </span>
  );
}

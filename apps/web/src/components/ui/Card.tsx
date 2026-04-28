import Link, { type LinkProps } from "next/link";
import type {
  HTMLAttributeAnchorTarget,
  HTMLAttributes,
  KeyboardEvent,
  MouseEventHandler,
  ReactNode,
} from "react";

import { cn } from "@/lib/utils";

interface CardBaseProps {
  children: ReactNode;
  className?: string;
}

type LinkCardProps = CardBaseProps & {
  href: LinkProps["href"];
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  target?: HTMLAttributeAnchorTarget;
  rel?: string;
  title?: string;
  "aria-label"?: string;
};

type DivCardProps = CardBaseProps &
  Omit<HTMLAttributes<HTMLDivElement>, "children" | "className">;

export type CardProps = LinkCardProps | DivCardProps;

export default function Card(props: Readonly<CardProps>) {
  const isInteractive = "href" in props || props.onClick !== undefined;
  const cardClassName = cn(
    "glass-card",
    "ui-card",
    isInteractive && "surface-hoverable ui-card--interactive",
    props.className,
  );

  if ("href" in props) {
    const {
      "aria-label": ariaLabel,
      children,
      className: _className,
      href,
      onClick,
      rel,
      target,
      title,
    } = props;

    return (
      <Link
        href={href}
        className={cardClassName}
        {...(ariaLabel !== undefined ? { "aria-label": ariaLabel } : {})}
        {...(onClick !== undefined ? { onClick } : {})}
        {...(rel !== undefined ? { rel } : {})}
        {...(target !== undefined ? { target } : {})}
        {...(title !== undefined ? { title } : {})}
      >
        {children}
      </Link>
    );
  }

  const {
    children,
    className: _className,
    onClick,
    onKeyDown,
    role,
    tabIndex,
    ...rest
  } = props;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(event);

    if (event.defaultPrevented || onClick === undefined) {
      return;
    }

    // Trigger the existing click handler so keyboard and pointer paths stay aligned.
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.currentTarget.click();
    }
  }

  const resolvedOnKeyDown =
    onClick !== undefined || onKeyDown !== undefined ? handleKeyDown : undefined;

  return (
    <div
      className={cardClassName}
      onClick={onClick}
      onKeyDown={resolvedOnKeyDown}
      role={onClick !== undefined ? role ?? "button" : role}
      tabIndex={onClick !== undefined ? tabIndex ?? 0 : tabIndex}
      {...rest}
    >
      {children}
    </div>
  );
}

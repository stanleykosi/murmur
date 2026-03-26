/**
 * Reusable card primitive for Murmur.
 *
 * Purpose:
 * Provides a glassmorphism card surface that can render as a static container,
 * an internal link, or an accessible clickable surface.
 *
 * Scope:
 * The card keeps its own light class-name composition logic so Step 14 remains
 * self-contained and does not depend on later shared utility work.
 */

import Link, { type LinkProps } from "next/link";
import type {
  HTMLAttributeAnchorTarget,
  HTMLAttributes,
  KeyboardEvent,
  MouseEventHandler,
  ReactNode,
} from "react";

/**
 * Shared props used by both link and div card render modes.
 */
interface CardBaseProps {
  children: ReactNode;
  className?: string;
}

/**
 * Card props when the surface should navigate.
 */
type LinkCardProps = CardBaseProps & {
  href: LinkProps["href"];
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  target?: HTMLAttributeAnchorTarget;
  rel?: string;
  title?: string;
  "aria-label"?: string;
};

/**
 * Card props when the surface should render as a div.
 */
type DivCardProps = CardBaseProps &
  Omit<HTMLAttributes<HTMLDivElement>, "children" | "className">;

/**
 * Public card props supporting either link or div rendering.
 */
export type CardProps = LinkCardProps | DivCardProps;

/**
 * Concatenates CSS class names without an external helper dependency.
 *
 * @param classNames - Candidate class names including falsy values.
 * @returns A normalized class name string.
 */
function joinClassNames(
  ...classNames: Array<string | false | null | undefined>
): string {
  return classNames.filter(Boolean).join(" ");
}

/**
 * Renders the canonical Murmur card surface.
 *
 * @param props - Link or div props describing the card behavior.
 * @returns A static, linked, or keyboard-accessible interactive card.
 */
export default function Card(props: Readonly<CardProps>) {
  const isInteractive = "href" in props || props.onClick !== undefined;
  const cardClassName = joinClassNames(
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

  /**
   * Mirrors native button keyboard behavior for clickable div cards.
   *
   * @param event - The current keyboard interaction.
   */
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

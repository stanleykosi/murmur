/**
 * Reusable button primitive for the Murmur web frontend.
 *
 * Purpose:
 * Provides a type-safe, design-system-aligned button component that supports
 * semantic variants, size options, loading feedback, and disabled handling.
 *
 * Scope:
 * This component is intentionally self-contained for Step 14 and does not
 * depend on the shared `cn()` helper that is scheduled for a later step.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";

import SingularityLoader from "@/components/ui/SingularityLoader";

/**
 * Supported Murmur button variants.
 */
export const BUTTON_VARIANTS = [
  "primary",
  "secondary",
  "ghost",
  "danger",
] as const;

/**
 * Supported Murmur button sizes.
 */
export const BUTTON_SIZES = ["sm", "md", "lg"] as const;

/**
 * Union of supported button variants.
 */
export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];

/**
 * Union of supported button sizes.
 */
export type ButtonSize = (typeof BUTTON_SIZES)[number];

/**
 * Public props for the Murmur button primitive.
 */
export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  children?: ReactNode;
}

/**
 * Concatenates CSS class names without pulling in an external helper.
 *
 * @param classNames - Candidate class names, including falsy values.
 * @returns A space-delimited class name string.
 */
function joinClassNames(
  ...classNames: Array<string | false | null | undefined>
): string {
  return classNames.filter(Boolean).join(" ");
}

/**
 * Renders a typed design-system button with loading and disabled states.
 *
 * @param props - Native button props plus Murmur styling options.
 * @returns A reusable button element.
 */
export default function Button({
  className,
  children,
  disabled = false,
  fullWidth = false,
  loading = false,
  size = "md",
  type = "button",
  variant = "primary",
  ...rest
}: Readonly<ButtonProps>) {
  const isDisabled = disabled || loading;

  return (
    <button
      type={type}
      className={joinClassNames(
        "ui-button",
        `ui-button--${variant}`,
        `ui-button--${size}`,
        fullWidth && "ui-button--full-width",
        loading && "ui-button--loading",
        className,
      )}
      disabled={isDisabled}
      aria-busy={loading}
      {...rest}
    >
      {loading ? (
        <SingularityLoader className="ui-button__spinner" />
      ) : null}
      <span
        className={joinClassNames(
          "ui-button__label",
          loading && "ui-button__label--loading",
        )}
      >
        {children}
      </span>
    </button>
  );
}

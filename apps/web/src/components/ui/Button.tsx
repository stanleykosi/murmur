import type { ButtonHTMLAttributes, ReactNode } from "react";

import SingularityLoader from "@/components/ui/SingularityLoader";
import { cn } from "@/lib/utils";

export const BUTTON_VARIANTS = [
  "primary",
  "secondary",
  "ghost",
  "danger",
] as const;

export const BUTTON_SIZES = ["sm", "md", "lg"] as const;

export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];

export type ButtonSize = (typeof BUTTON_SIZES)[number];

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  children?: ReactNode;
}

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
      className={cn(
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
        className={cn(
          "ui-button__label",
          loading && "ui-button__label--loading",
        )}
      >
        {children}
      </span>
    </button>
  );
}

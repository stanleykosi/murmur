"use client";

/**
 * Global toast system for the Murmur frontend.
 *
 * Purpose:
 * Supplies a lightweight notification layer that can be triggered anywhere in
 * the app through context, while rendering portal-backed toast UI at the body
 * level so route layouts do not need to own their own notification stacks.
 *
 * Scope:
 * This file defines the provider, hook, internal viewport, and toast item
 * rendering required for Step 14. It does not add persistence, cross-tab
 * syncing, or compatibility shims for older notification systems.
 */

import {
  createContext,
  startTransition,
  useContext,
  useEffect,
  useEffectEvent,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * Supported toast variants.
 */
export const TOAST_VARIANTS = [
  "info",
  "success",
  "error",
  "warning",
] as const;

/**
 * Union of supported toast variants.
 */
export type ToastVariant = (typeof TOAST_VARIANTS)[number];

/**
 * Input contract for a toast notification.
 */
export interface ToastOptions {
  title?: string;
  description: string;
  variant?: ToastVariant;
  durationMs?: number;
}

/**
 * Internal normalized representation of a toast item.
 */
interface ToastRecord {
  id: string;
  description: string;
  variant: ToastVariant;
  durationMs: number;
  isClosing: boolean;
  title?: string;
}

/**
 * Public context API exposed to consumers.
 */
interface ToastContextValue {
  pushToast: (options: ToastOptions) => string;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
}

/**
 * Props for the toast provider.
 */
interface ToastProviderProps {
  children: ReactNode;
}

/**
 * Props for the internal toast viewport.
 */
interface ToastViewportProps {
  toasts: ToastRecord[];
  dismissToast: (id: string) => void;
  removeToast: (id: string) => void;
}

/**
 * Props for a single toast item.
 */
interface ToastItemProps {
  toast: ToastRecord;
  dismissToast: (id: string) => void;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);
const DEFAULT_TOAST_DURATION_MS = 4500;
const TOAST_EXIT_DURATION_MS = 180;
const MAX_TOASTS = 4;

/**
 * Concatenates CSS class names without relying on future shared utilities.
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
 * Returns a trimmed optional string or omits it entirely.
 *
 * @param value - The incoming optional title value.
 * @returns A normalized title string or `undefined`.
 */
function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmedValue = value?.trim();

  return trimmedValue && trimmedValue.length > 0 ? trimmedValue : undefined;
}

/**
 * Validates and normalizes raw toast input.
 *
 * @param options - Incoming toast options from callers.
 * @param id - The generated toast identifier.
 * @returns A normalized toast record safe to store in state.
 */
function normalizeToastOptions(options: ToastOptions, id: string): ToastRecord {
  const description = options.description.trim();

  if (description.length === 0) {
    throw new Error("Toast descriptions must not be empty.");
  }

  if (
    options.durationMs !== undefined &&
    (!Number.isFinite(options.durationMs) || options.durationMs <= 0)
  ) {
    throw new Error("Toast duration must be a positive finite number.");
  }

  const normalizedTitle = normalizeOptionalText(options.title);

  return {
    id,
    description,
    variant: options.variant ?? "info",
    durationMs: options.durationMs ?? DEFAULT_TOAST_DURATION_MS,
    isClosing: false,
    ...(normalizedTitle !== undefined ? { title: normalizedTitle } : {}),
  };
}

/**
 * Renders the icon for the given toast variant.
 *
 * @param props - The icon variant.
 * @returns A decorative inline SVG icon.
 */
function ToastVariantIcon({
  variant,
}: Readonly<{
  variant: ToastVariant;
}>) {
  if (variant === "success") {
    return (
      <svg
        className="ui-toast__icon"
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="m5.5 10.25 2.75 2.75 6.25-6.25"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (variant === "warning") {
    return (
      <svg
        className="ui-toast__icon"
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M10 3.5 17 16H3L10 3.5Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path
          d="M10 7.25v4.25"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <circle cx="10" cy="13.75" r=".85" fill="currentColor" />
      </svg>
    );
  }

  if (variant === "error") {
    return (
      <svg
        className="ui-toast__icon"
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <circle cx="10" cy="10" r="6.25" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M8.125 8.125 11.875 11.875M11.875 8.125 8.125 11.875"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  return (
    <svg
      className="ui-toast__icon"
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="10" cy="10" r="6.25" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M10 8v4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="10" cy="6" r=".9" fill="currentColor" />
    </svg>
  );
}

/**
 * Renders the dismiss icon for the toast close button.
 *
 * @returns A decorative inline SVG icon.
 */
function CloseIcon() {
  return (
    <svg
      className="ui-toast__dismiss-icon"
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M4 4 12 12M12 4 4 12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Renders a single toast item and manages its lifecycle timers.
 *
 * @param props - Toast record data plus dismissal callbacks.
 * @returns A single toast UI element.
 */
function ToastItem({
  dismissToast,
  removeToast,
  toast,
}: Readonly<ToastItemProps>) {
  const descriptionId = `toast-description-${toast.id}`;
  const titleId = `toast-title-${toast.id}`;
  const handleDismiss = useEffectEvent(() => {
    dismissToast(toast.id);
  });
  const handleRemove = useEffectEvent(() => {
    removeToast(toast.id);
  });

  useEffect(() => {
    if (toast.isClosing) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      handleDismiss();
    }, toast.durationMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [handleDismiss, toast.durationMs, toast.isClosing]);

  useEffect(() => {
    if (!toast.isClosing) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      handleRemove();
    }, TOAST_EXIT_DURATION_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [handleRemove, toast.isClosing]);

  return (
    <article
      className={joinClassNames(
        "ui-toast",
        `ui-toast--${toast.variant}`,
        toast.isClosing && "ui-toast--closing",
      )}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-labelledby={toast.title ? titleId : undefined}
      aria-describedby={descriptionId}
    >
      <ToastVariantIcon variant={toast.variant} />

      <div className="ui-toast__content">
        {toast.title ? (
          <p className="ui-toast__title" id={titleId}>
            {toast.title}
          </p>
        ) : null}
        <p className="ui-toast__description" id={descriptionId}>
          {toast.description}
        </p>
      </div>

      <button
        type="button"
        className="ui-toast__dismiss"
        onClick={() => {
          dismissToast(toast.id);
        }}
        aria-label="Dismiss notification"
      >
        <CloseIcon />
      </button>
    </article>
  );
}

/**
 * Renders the fixed toast viewport at the document body level.
 *
 * @param props - Toast collection plus item lifecycle callbacks.
 * @returns A stack of notifications.
 */
function ToastViewport({
  dismissToast,
  removeToast,
  toasts,
}: Readonly<ToastViewportProps>) {
  if (toasts.length === 0) {
    return null;
  }

  return (
    <section className="ui-toast-viewport" aria-label="Notifications">
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          dismissToast={dismissToast}
          removeToast={removeToast}
        />
      ))}
    </section>
  );
}

/**
 * Provides the global toast API and portal-backed notification viewport.
 *
 * @param props - Provider children.
 * @returns The wrapped app tree plus an optional toast portal.
 */
export default function ToastProvider({
  children,
}: Readonly<ToastProviderProps>) {
  const [isMounted, setIsMounted] = useState(false);
  const [toasts, setToasts] = useState<ToastRecord[]>([]);

  useEffect(() => {
    setIsMounted(true);

    return () => {
      setIsMounted(false);
    };
  }, []);

  /**
   * Marks a toast as closing so the exit animation can play before removal.
   *
   * @param id - The toast identifier to dismiss.
   */
  function dismissToast(id: string) {
    startTransition(() => {
      setToasts((currentToasts) =>
        currentToasts.map((toast) =>
          toast.id === id && !toast.isClosing
            ? { ...toast, isClosing: true }
            : toast,
        ),
      );
    });
  }

  /**
   * Removes a toast from state once its closing animation completes.
   *
   * @param id - The toast identifier to remove.
   */
  function removeToast(id: string) {
    startTransition(() => {
      setToasts((currentToasts) =>
        currentToasts.filter((toast) => toast.id !== id),
      );
    });
  }

  /**
   * Marks all current toasts as closing.
   */
  function clearToasts() {
    startTransition(() => {
      setToasts((currentToasts) =>
        currentToasts.map((toast) =>
          toast.isClosing ? toast : { ...toast, isClosing: true },
        ),
      );
    });
  }

  /**
   * Adds a new toast to the stack and enforces the viewport limit.
   *
   * @param options - The toast content and timing options.
   * @returns The generated toast identifier.
   */
  function pushToast(options: ToastOptions): string {
    const toastId = crypto.randomUUID();
    const nextToast = normalizeToastOptions(options, toastId);

    startTransition(() => {
      setToasts((currentToasts) => {
        const closingToasts = currentToasts.filter((toast) => toast.isClosing);
        const activeToasts = currentToasts.filter((toast) => !toast.isClosing);
        // Keep the newest active notifications visible while older closing
        // toasts finish their exit animation and remove themselves cleanly.
        const nextActiveToasts = [...activeToasts, nextToast].slice(-MAX_TOASTS);

        return [...closingToasts, ...nextActiveToasts];
      });
    });

    return toastId;
  }

  const contextValue: ToastContextValue = {
    pushToast,
    dismissToast,
    clearToasts,
  };

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      {isMounted
        ? createPortal(
            // Avoid touching `document.body` during SSR and only mount the
            // viewport once the client has hydrated.
            <ToastViewport
              toasts={toasts}
              dismissToast={dismissToast}
              removeToast={removeToast}
            />,
            document.body,
          )
        : null}
    </ToastContext.Provider>
  );
}

/**
 * Returns the current toast API and fails fast when the provider is missing.
 *
 * @returns The global toast context value.
 */
export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);

  if (context === null) {
    throw new Error("useToast must be used within the Murmur ToastProvider.");
  }

  return context;
}

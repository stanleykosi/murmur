"use client";

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

import { cn } from "@/lib/utils";

export const TOAST_VARIANTS = [
  "info",
  "success",
  "error",
  "warning",
] as const;

export type ToastVariant = (typeof TOAST_VARIANTS)[number];

export interface ToastOptions {
  title?: string;
  description: string;
  variant?: ToastVariant;
  durationMs?: number;
}

interface ToastRecord {
  id: string;
  description: string;
  variant: ToastVariant;
  durationMs: number;
  isClosing: boolean;
  title?: string;
}

interface ToastContextValue {
  pushToast: (options: ToastOptions) => string;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
}

interface ToastProviderProps {
  children: ReactNode;
}

interface ToastViewportProps {
  toasts: ToastRecord[];
  dismissToast: (id: string) => void;
  removeToast: (id: string) => void;
}

interface ToastItemProps {
  toast: ToastRecord;
  dismissToast: (id: string) => void;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);
const DEFAULT_TOAST_DURATION_MS = 4500;
const TOAST_EXIT_DURATION_MS = 180;
const MAX_TOASTS = 4;

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmedValue = value?.trim();

  return trimmedValue && trimmedValue.length > 0 ? trimmedValue : undefined;
}

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
      className={cn(
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

  function removeToast(id: string) {
    startTransition(() => {
      setToasts((currentToasts) =>
        currentToasts.filter((toast) => toast.id !== id),
      );
    });
  }

  function clearToasts() {
    startTransition(() => {
      setToasts((currentToasts) =>
        currentToasts.map((toast) =>
          toast.isClosing ? toast : { ...toast, isClosing: true },
        ),
      );
    });
  }

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

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);

  if (context === null) {
    throw new Error("useToast must be used within the Murmur ToastProvider.");
  }

  return context;
}

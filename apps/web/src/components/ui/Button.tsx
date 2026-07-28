import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { Spinner } from "./Spinner";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Keeps the button's dimensions stable while replacing its visible content with a spinner. */
  loading?: boolean;
  loadingLabel?: string;
}

const base =
  "relative inline-flex touch-manipulation items-center justify-center gap-2 whitespace-nowrap " +
  "rounded-md font-medium transition-[background-color,border-color,color,filter,opacity,transform] " +
  "duration-150 ease-out active:translate-y-px disabled:cursor-not-allowed " +
  "disabled:active:translate-y-0 motion-reduce:transition-none";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:brightness-110 active:brightness-95",
  secondary: "bg-bg-overlay text-text border border-border-strong hover:border-accent",
  ghost: "bg-transparent text-text-dim hover:text-text hover:bg-bg-overlay",
  danger:
    "bg-verdict-error-dim text-verdict-error border border-verdict-error hover:brightness-110",
};

const sizes: Record<Size, string> = {
  sm: "text-xs px-2.5 py-1.5",
  md: "text-sm px-3.5 py-2",
};

/** Button's own look, for the rare non-`<button>` element (e.g. a `Link`) that needs to render
 * AS a button — never nest a real `<button>` inside another interactive element to get this. */
export function buttonClassName({
  variant = "secondary",
  size = "md",
  className = "",
}: { variant?: Variant; size?: Size; className?: string } = {}): string {
  return `${base} ${variants[variant]} ${sizes[size]} ${className}`.trim();
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    className = "",
    loading = false,
    loadingLabel = "Loading…",
    disabled,
    children,
    "aria-label": ariaLabel,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      className={buttonClassName({
        variant,
        size,
        className: `${className} ${loading ? "disabled:opacity-70" : "disabled:opacity-40"}`,
      })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-label={loading ? loadingLabel : ariaLabel}
      {...rest}
    >
      <span
        className={`inline-flex items-center justify-center gap-2 ${loading ? "invisible" : ""}`}
        aria-hidden={loading || undefined}
      >
        {children}
      </span>
      {loading && (
        <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
          <Spinner size={size === "sm" ? "sm" : "md"} />
        </span>
      )}
    </button>
  );
});

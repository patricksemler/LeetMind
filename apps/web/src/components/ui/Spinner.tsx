import type { HTMLAttributes } from "react";

type SpinnerSize = "sm" | "md";

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  label?: string;
  size?: SpinnerSize;
}

const sizes: Record<SpinnerSize, string> = {
  sm: "size-3.5",
  md: "size-4",
};

/** The single in-flight glyph used by buttons, route states, and workspace actions. */
export function Spinner({
  label,
  size = "md",
  className = "",
  ...rest
}: SpinnerProps) {
  return (
    <span
      role={label ? "status" : undefined}
      aria-live={label ? "polite" : undefined}
      aria-hidden={label ? undefined : true}
      className={`inline-flex shrink-0 items-center justify-center ${className}`}
      {...rest}
    >
      <svg
        className={`${sizes[size]} animate-spin motion-reduce:animate-none`}
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <circle
          cx="8"
          cy="8"
          r="6.5"
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeWidth="2.5"
        />
        <path
          d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}

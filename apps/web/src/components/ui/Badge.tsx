import type { HTMLAttributes } from "react";

export type BadgeTone = "neutral" | "accent" | "accepted" | "error" | "warn";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-verdict-neutral-dim text-text-dim border-transparent",
  accent: "bg-accent-dim text-accent border-transparent",
  accepted: "bg-verdict-accepted-dim text-verdict-accepted border-transparent",
  error: "bg-verdict-error-dim text-verdict-error border-transparent",
  warn: "bg-verdict-warn-dim text-verdict-warn border-transparent",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ tone = "neutral", className = "", ...rest }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${tones[tone]} ${className}`}
      {...rest}
    />
  );
}

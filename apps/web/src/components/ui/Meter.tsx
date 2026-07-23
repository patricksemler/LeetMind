import type { ReactNode } from "react";

export type MeterTone = "accent" | "accepted" | "error" | "warn" | "neutral";

const fillTone: Record<MeterTone, string> = {
  accent: "bg-accent",
  accepted: "bg-verdict-accepted",
  error: "bg-verdict-error",
  warn: "bg-verdict-warn",
  neutral: "bg-text-faint",
};

export interface MeterProps {
  value: number;
  max: number;
  tone?: MeterTone;
  label?: ReactNode;
  className?: string;
}

/** A simple horizontal fill meter — used for per-test progress, mastery rating, workout budget. */
export function Meter({ value, max, tone = "accent", label, className = "" }: MeterProps) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className={className}>
      {label && <div className="mb-1 flex justify-between text-xs text-text-dim">{label}</div>}
      <div
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        className="h-1.5 w-full overflow-hidden rounded-full bg-bg-inset"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${fillTone[tone]}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** Mastery rating meter with an uncertainty error bar centered on the rating marker. */
export function RatingMeter({
  rating,
  uncertainty,
  min = 800,
  max = 2400,
}: {
  rating: number;
  uncertainty: number;
  min?: number;
  max?: number;
}) {
  const clampPct = (v: number) => Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100));
  const centerPct = clampPct(rating);
  const lowPct = clampPct(rating - uncertainty);
  const highPct = clampPct(rating + uncertainty);

  return (
    <div className="relative h-2 w-full rounded-full bg-bg-inset">
      <div
        className="absolute top-0 h-full rounded-full bg-accent-dim"
        style={{ left: `${lowPct}%`, width: `${Math.max(0, highPct - lowPct)}%` }}
      />
      <div
        className="absolute top-1/2 h-3 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
        style={{ left: `${centerPct}%` }}
        title={`rating ${Math.round(rating)} ± ${Math.round(uncertainty)}`}
      />
    </div>
  );
}

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

/** A simple horizontal fill meter — used for per-test progress and any other bounded count. */
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

/**
 * Where a rating sits on the 800–2400 scale, with its uncertainty drawn as a range around it.
 *
 * Shaped deliberately *unlike* a slider. The previous version — a pill-shaped track, a wide
 * solid-blue band, and a rounded blue thumb centred on it — was read as a broken range input, and
 * the reading is fair: those are exactly a slider's parts. The fixes are all about affordance:
 * a thin square-ended rail rather than a pill, a translucent range instead of a solid fill, a
 * hairline tick instead of a thumb, and endpoint labels so the axis means something. Nothing here
 * is interactive, and now it doesn't look like it is.
 */
export function RatingMeter({
  rating,
  uncertainty,
  min = 800,
  max = 2400,
  label = "Rating",
  showScale = true,
}: {
  rating: number;
  uncertainty: number;
  min?: number;
  max?: number;
  /** Accessible name — several of these can appear in one panel, one per concept. */
  label?: string;
  showScale?: boolean;
}) {
  const clampPct = (v: number) => Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100));
  const centerPct = clampPct(rating);
  const lowPct = clampPct(rating - uncertainty);
  const highPct = clampPct(rating + uncertainty);

  return (
    <div>
      <div
        role="img"
        aria-label={`${label}: ${Math.round(rating)} on a ${min} to ${max} scale, give or take ${Math.round(uncertainty)}`}
        className="relative h-1.5 w-full bg-bg-overlay"
      >
        <div
          className="absolute inset-y-0 bg-accent/30"
          style={{ left: `${lowPct}%`, width: `${Math.max(0, highPct - lowPct)}%` }}
        />
        <div
          className="absolute -top-0.5 h-[calc(100%+4px)] w-px bg-accent"
          style={{ left: `${centerPct}%` }}
        />
      </div>
      {showScale && (
        <div className="mt-1 flex justify-between text-[10px] leading-none text-text-faint">
          <span>{min}</span>
          <span>{max}</span>
        </div>
      )}
    </div>
  );
}

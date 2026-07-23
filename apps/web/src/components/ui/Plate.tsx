/**
 * The one signature device in this UI: a small "weight plate" ring. Size encodes load, fill
 * encodes completion. Reused for workout-item roles (warm-up/working/overload/recovery) and for
 * hint-ladder rungs (l1 → outline), so the same glyph vocabulary means "how much load / how far
 * down the ladder" everywhere it appears.
 */
export type PlateTone = "accent" | "accepted" | "error" | "warn" | "neutral";

const RADII = { xs: 5, sm: 7, md: 9, lg: 11 } as const;
export type PlateSize = keyof typeof RADII;

const strokeTone: Record<PlateTone, string> = {
  accent: "var(--color-accent)",
  accepted: "var(--color-verdict-accepted)",
  error: "var(--color-verdict-error)",
  warn: "var(--color-verdict-warn)",
  neutral: "var(--color-text-faint)",
};

export interface PlateProps {
  size?: PlateSize;
  tone?: PlateTone;
  filled?: boolean;
  className?: string;
}

export function Plate({ size = "md", tone = "neutral", filled = false, className = "" }: PlateProps) {
  const r = RADII[size];
  const box = r * 2 + 4;
  const c = box / 2;
  const color = strokeTone[tone];
  return (
    <svg
      width={box}
      height={box}
      viewBox={`0 0 ${box} ${box}`}
      className={`shrink-0 ${className}`}
      aria-hidden="true"
    >
      <circle cx={c} cy={c} r={r} fill={filled ? color : "none"} stroke={color} strokeWidth={2} />
      {!filled && <circle cx={c} cy={c} r={Math.max(1.5, r - 4)} fill="none" stroke={color} strokeWidth={1} opacity={0.5} />}
    </svg>
  );
}

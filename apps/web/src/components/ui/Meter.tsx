import { formatRating } from "../../lib/format";

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
        aria-label={`${label}: ${formatRating(rating)} on a ${min} to ${max} scale, give or take ${formatRating(uncertainty)}`}
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

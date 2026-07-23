export function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatMinutes(ms: number): string {
  const minutes = ms / 60000;
  if (minutes < 1) return "<1 min";
  return `${Math.round(minutes)} min`;
}

export function formatRating(rating: number): string {
  return Math.round(rating).toString();
}

export function formatPercent(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Like `formatDate`, but includes time-of-day — for contexts spanning less than a day (worker
 * liveness, recent activity) where date-only rendering collapses distinct moments together (nine
 * workers seen minutes apart all read "Jul 23", confirmed live). */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function formatRelativeDays(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = d.getTime() - Date.now();
  const days = Math.round(diffMs / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 1) return `in ${days}d`;
  return `${Math.abs(days)}d ago`;
}

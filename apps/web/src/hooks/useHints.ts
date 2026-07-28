import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/**
 * `GET /api/hints/:versionId` — which rungs this user has taken, and the text of the ones they have.
 *
 * Shared rather than living inside `HintLadder` so the workspace can start the fetch in parallel
 * with the problem itself. The ladder only mounts once the problem has landed, so a query fired
 * from inside it starts a whole round trip *after* the page is already on screen — which is exactly
 * what made taken hints drop in a beat late on every visit. Same query key, so the two callers
 * share one request and one cache entry.
 */
export function useHints(versionId: string | undefined) {
  return useQuery({
    queryKey: ["hints", versionId],
    queryFn: () => api.getHints(versionId!),
    enabled: !!versionId,
  });
}

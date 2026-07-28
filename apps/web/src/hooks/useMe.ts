import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/** `GET /api/me`, cached app-wide — the learner profile: rating/attempts/evidenced per type. */
export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 60_000 });
}

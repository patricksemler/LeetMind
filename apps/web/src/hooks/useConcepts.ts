import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/** `GET /api/concepts`, cached app-wide — also derives an id -> display-name lookup. */
export function useConcepts() {
  const query = useQuery({ queryKey: ["concepts"], queryFn: api.concepts, staleTime: 5 * 60_000 });

  const namesById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of query.data?.concepts ?? []) map[c.id] = c.name;
    return map;
  }, [query.data]);

  return { ...query, namesById };
}

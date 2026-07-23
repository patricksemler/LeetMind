import { type ReactNode, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export function makeTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function Providers({ children }: { children: ReactNode }) {
  // `useState(() => ...)` — a fresh QueryClient must be created exactly once per mount. Calling
  // `makeTestQueryClient()` directly in the render body created a brand-new client (with its own
  // caches/subscriptions) on every re-render, which made every useQuery/useMutation resubscribe
  // and refetch in a loop that never settled — an unbounded-memory bug, not just a slow one.
  const [client] = useState(() => makeTestQueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

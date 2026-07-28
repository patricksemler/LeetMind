import { render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PracticeNextResponse } from "@shared";
import { Providers, makeTestQueryClient } from "../test/testUtils";
import { Practice } from "./Practice";

vi.mock("../lib/api", () => ({
  api: {
    practiceNext: vi.fn(),
    practiceReplenish: vi.fn(),
  },
}));

// The SSE hook does its own fetch-streaming, which jsdom doesn't meaningfully support and which
// these tests aren't about — stub it to a no-op so only the `next`/`replenish` polling is exercised.
vi.mock("../hooks/useGenerationEvents", () => ({
  useGenerationEvents: () => ({ connectionState: "idle" }),
}));

import { api } from "../lib/api";

function next(overrides: Partial<PracticeNextResponse> = {}): PracticeNextResponse {
  return { state: "stalled", opened: false, ...overrides } as PracticeNextResponse;
}

function renderPractice() {
  return render(
    <Providers>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<Practice />} />
        </Routes>
      </MemoryRouter>
    </Providers>,
  );
}

function renderPracticeOn(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<Practice />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Practice", () => {
  it("offers Start (not the statement) once a problem is active", async () => {
    vi.mocked(api.practiceReplenish).mockResolvedValue({ created: [] });
    vi.mocked(api.practiceNext).mockResolvedValue(next({ state: "active", problem_id: "p1" }));

    renderPractice();

    const link = await screen.findByRole("link", { name: "Start" });
    expect(link).toHaveAttribute("href", "/problem/p1");
    // The card offers exactly one way forward — no re-roll.
    expect(screen.queryByRole("button", { name: /something else/i })).not.toBeInTheDocument();
  });

  it("shows Continue for an already-opened active problem", async () => {
    vi.mocked(api.practiceReplenish).mockResolvedValue({ created: [] });
    vi.mocked(api.practiceNext).mockResolvedValue(
      next({ state: "active", problem_id: "p1", opened: true }),
    );

    renderPractice();

    expect(await screen.findByRole("link", { name: "Continue" })).toHaveAttribute(
      "href",
      "/problem/p1",
    );
  });

  it("renders a waiting state with the job's stage while a problem is being generated", async () => {
    vi.mocked(api.practiceReplenish).mockResolvedValue({ created: [] });
    vi.mocked(api.practiceNext).mockResolvedValue(
      next({ state: "generating", job: { status: "building", repair_count: 0 } }),
    );

    renderPractice();

    expect(await screen.findByText(/Writing you a new problem/i)).toBeInTheDocument();
    expect(screen.getByText("Writing")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "3"); // queued, planning, building -> index 2 (0-based) + 1
  });

  it("shows the repair count once the pipeline has retried", async () => {
    vi.mocked(api.practiceReplenish).mockResolvedValue({ created: [] });
    vi.mocked(api.practiceNext).mockResolvedValue(
      next({ state: "generating", job: { status: "verifying", repair_count: 2 } }),
    );

    renderPractice();

    expect(await screen.findByText(/Writing you a new problem/i)).toBeInTheDocument();
    expect(screen.getByText("retry 2")).toBeInTheDocument();
  });

  it("self-heals a stalled queue by calling replenish", async () => {
    vi.mocked(api.practiceReplenish).mockResolvedValue({ created: ["job_1"] });
    vi.mocked(api.practiceNext).mockResolvedValue(next({ state: "stalled" }));

    renderPractice();

    await waitFor(() => expect(api.practiceReplenish).toHaveBeenCalled());
  });

  it("calls replenish once on first mount regardless of state (bootstrap)", async () => {
    vi.mocked(api.practiceReplenish).mockResolvedValue({ created: [] });
    vi.mocked(api.practiceNext).mockResolvedValue(next({ state: "active", problem_id: "p1" }));

    renderPractice();
    await screen.findByRole("link", { name: "Start" });

    expect(api.practiceReplenish).toHaveBeenCalledTimes(1);
  });

  it("waits for the server rather than rendering a cached answer from a previous mount", async () => {
    vi.mocked(api.practiceReplenish).mockResolvedValue({ created: [] });
    vi.mocked(api.practiceNext).mockResolvedValue(next({ state: "active", problem_id: "p1" }));

    const client = makeTestQueryClient();
    const view = renderPracticeOn(client);
    await screen.findByRole("link", { name: "Start" });

    view.unmount();
    vi.mocked(api.practiceNext).mockReturnValue(new Promise(() => {}));

    renderPracticeOn(client);

    expect(screen.queryByRole("link", { name: "Start" })).not.toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });
});

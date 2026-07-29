import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationEvent, JobStub, PracticeNextResponse } from "@shared";
import { Providers, makeTestQueryClient } from "../test/testUtils";
import { Practice } from "./Practice";

const generationEvents = vi.hoisted(() => ({
  onEvent: undefined as undefined | ((event: unknown) => void),
}));

vi.mock("../lib/api", () => ({
  api: {
    practiceNext: vi.fn(),
    practiceReplenish: vi.fn(),
  },
}));

// The SSE hook does its own fetch-streaming, which jsdom doesn't meaningfully support and which
// these tests aren't about — stub it to a no-op so only the `next`/`replenish` polling is exercised.
vi.mock("../hooks/useGenerationEvents", () => ({
  useGenerationEvents: (options: { onEvent?: (event: unknown) => void }) => {
    generationEvents.onEvent = options.onEvent;
    return { connectionState: "idle" };
  },
}));

import { api } from "../lib/api";

function next(overrides: Partial<PracticeNextResponse> = {}): PracticeNextResponse {
  return { state: "stalled", opened: false, ...overrides } as PracticeNextResponse;
}

function job(overrides: Partial<JobStub> = {}): JobStub {
  return {
    job_id: "job-1",
    status: "building",
    phase: "drafting",
    repair_count: 0,
    attempt: 1,
    max_attempts: 2,
    started_at: new Date().toISOString(),
    phase_started_at: new Date().toISOString(),
    recovery_reason: null,
    failure_code: null,
    ...overrides,
  };
}

function generationEvent(overrides: Partial<GenerationEvent> = {}): GenerationEvent {
  return {
    job_id: "job-1",
    status: "building",
    phase: "drafting",
    repair_count: 0,
    attempt: 1,
    max_attempts: 2,
    started_at: new Date().toISOString(),
    phase_started_at: new Date().toISOString(),
    recovery_reason: null,
    failure_code: null,
    problem_id: null,
    ...overrides,
  };
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
  generationEvents.onEvent = undefined;
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
      next({ state: "generating", job: job({ phase: "independent_review" }) }),
    );

    renderPractice();

    expect(await screen.findByText(/Writing you a new problem/i)).toBeInTheDocument();
    expect(screen.getByText("Reviewing")).toBeInTheDocument();
    expect(screen.getByText(/separate reviewer is checking quality/i)).toBeInTheDocument();
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "4");
    expect(screen.getByText("Attempt 1 of 2")).toBeInTheDocument();
    expect(screen.getByText(/Elapsed \d+s/)).toBeInTheDocument();
  });

  it("applies a matching SSE transition immediately without waiting for another poll", async () => {
    vi.mocked(api.practiceReplenish).mockResolvedValue({ created: [] });
    vi.mocked(api.practiceNext).mockResolvedValue(
      next({ state: "generating", job: job({ phase: "waiting", status: "queued" }) }),
    );

    renderPractice();
    await screen.findByText(/waiting for a generation worker/i);

    act(() => {
      generationEvents.onEvent?.(
        generationEvent({ phase: "independent_review", status: "building" }),
      );
    });

    expect(await screen.findByText(/separate reviewer is checking quality/i)).toBeInTheDocument();
    expect(api.practiceNext).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["waiting", /waiting for a generation worker/i],
    ["selecting", /choosing a concept and a compatible problem shape/i],
    ["drafting", /writing the statement, solution, hints, and tests/i],
    ["independent_review", /separate reviewer is checking quality/i],
    ["checking_examples", /authored example against two independent solutions/i],
    ["stress_testing", /50 randomized cases/i],
    ["finalizing", /saving your verified problem/i],
  ] as const)("reconciles the %s phase from polling", async (phase, message) => {
    vi.mocked(api.practiceReplenish).mockResolvedValue({ created: [] });
    vi.mocked(api.practiceNext).mockResolvedValue(
      next({ state: "generating", job: job({ phase }) }),
    );

    renderPractice();

    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it("shows a helpful repair message on the second candidate", async () => {
    vi.mocked(api.practiceReplenish).mockResolvedValue({ created: [] });
    vi.mocked(api.practiceNext).mockResolvedValue(
      next({
        state: "generating",
        job: job({
          phase: "repairing",
          repair_count: 1,
          attempt: 2,
          recovery_reason: "test_disagreement",
        }),
      }),
    );

    renderPractice();

    expect(await screen.findByText(/Writing you a new problem/i)).toBeInTheDocument();
    expect(screen.getByText(/caught a mismatch and are correcting it/i)).toBeInTheDocument();
    expect(screen.getByText("Attempt 2 of 2")).toBeInTheDocument();
  });

  it("self-heals a stalled queue by calling replenish", async () => {
    vi.mocked(api.practiceReplenish).mockResolvedValue({ created: ["job_1"] });
    vi.mocked(api.practiceNext).mockResolvedValue(next({ state: "stalled" }));

    renderPractice();

    await waitFor(() => expect(api.practiceReplenish).toHaveBeenCalled());
  });

  it("does not replenish when an active problem already exists", async () => {
    vi.mocked(api.practiceReplenish).mockResolvedValue({ created: [] });
    vi.mocked(api.practiceNext).mockResolvedValue(next({ state: "active", problem_id: "p1" }));

    renderPractice();
    await screen.findByRole("link", { name: "Start" });

    expect(api.practiceReplenish).not.toHaveBeenCalled();
  });

  it("keeps terminal failure stopped until the user explicitly retries", async () => {
    const user = userEvent.setup();
    vi.mocked(api.practiceReplenish).mockResolvedValue({ created: ["job-2"] });
    vi.mocked(api.practiceNext).mockResolvedValue(
      next({
        state: "generation_failed",
        job: job({
          status: "failed",
          phase: "failed",
          failure_code: "verification_failed",
        }),
      }),
    );

    renderPractice();

    const retry = await screen.findByRole("button", { name: "Retry generation" });
    expect(api.practiceReplenish).not.toHaveBeenCalled();

    await user.click(retry);
    await waitFor(() => expect(api.practiceReplenish).toHaveBeenCalledTimes(1));
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

  it("always refreshes on remount even when the cached answer is still fresh", async () => {
    vi.mocked(api.practiceReplenish).mockResolvedValue({ created: [] });
    vi.mocked(api.practiceNext).mockResolvedValueOnce(next({ state: "active", problem_id: "p1" }));

    const client = makeTestQueryClient();
    client.setDefaultOptions({
      queries: { retry: false, staleTime: 60_000 },
      mutations: { retry: false },
    });
    const view = renderPracticeOn(client);
    await screen.findByRole("link", { name: "Start" });
    view.unmount();

    vi.mocked(api.practiceNext).mockResolvedValueOnce(
      next({ state: "generating", job: job({ phase: "selecting", status: "planning" }) }),
    );
    renderPracticeOn(client);

    expect(
      await screen.findByText(/choosing a concept and a compatible problem shape/i),
    ).toBeInTheDocument();
    expect(api.practiceNext).toHaveBeenCalledTimes(2);
  });
});

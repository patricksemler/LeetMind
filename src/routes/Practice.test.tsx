import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { NextPracticeProblemResponse, PublicProblem } from "@shared";
import { Providers, makeTestQueryClient } from "../test/testUtils";
import { Practice } from "./Practice";

vi.mock("../lib/api", () => ({
  api: {
    nextPracticeProblem: vi.fn(),
    concepts: vi.fn(),
  },
}));

import { api } from "../lib/api";

function problem(overrides: Partial<PublicProblem> = {}): PublicProblem {
  return {
    problem_version_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    title: "Maximum Sum of a Length-K Subarray",
    statement_md: "…",
    constraints_md: "…",
    signature: { name: "maxSumSubarray", params: [], returns: "int" },
    examples: [],
    difficulty: { rating: 1150, confidence: "verified" },
    expected_active_minutes: [8, 18],
    starter_code: { python: "", cpp: "" },
    concepts_revealed: null,
    hints_taken: [],
    ...overrides,
  } as PublicProblem;
}

function next(overrides: Partial<NextPracticeProblemResponse> = {}): NextPracticeProblemResponse {
  return {
    problem: null,
    generating: null,
    rationale: "",
    evidence: {},
    ...overrides,
  } as NextPracticeProblemResponse;
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

/** Same tree, but on a caller-owned QueryClient that OUTLIVES the mount — the only way to observe
 * what a second visit to `/` inherits from the first, which is what the staleness tests below are
 * about. `Providers` deliberately makes a fresh client per mount, so it can't express this. */
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

describe("Practice", () => {
  it("shows the title and the way in, and nothing else", async () => {
    // The card is deliberately two things: the title and Start. The
    // selector's `rationale`, the concept tag and the expected-minutes range used to sit here too;
    // they are the model explaining itself, and they pre-empt a judgement the statement makes
    // better. Locked down because it is exactly the kind of thing that creeps back one line at a
    // time.
    vi.mocked(api.concepts).mockResolvedValue({ concepts: [], edges: [], ratings: [] });
    vi.mocked(api.nextPracticeProblem).mockResolvedValue(
      next({
        problem: problem(),
        rationale: "two_pointers is your weakest concept.",
        evidence: { concept: "two_pointers" },
      }),
    );

    renderPractice();

    expect(await screen.findByText("Maximum Sum of a Length-K Subarray")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start" })).toHaveAttribute(
      "href",
      "/problem/01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );

    expect(screen.queryByText(/two_pointers is your weakest concept/)).not.toBeInTheDocument();
    expect(screen.queryByText(/min$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/both teach the model something/i)).not.toBeInTheDocument();
  });

  it("serves a brand-new user a problem rather than routing them into onboarding", async () => {
    // The regression this locks down: practice used to gate on `has_baseline` and bounce a
    // never-probed user to `/baseline`. There is no gate and no such route now — the cold-start
    // rule calibrates over the first few problems without the user having to complete anything.
    vi.mocked(api.concepts).mockResolvedValue({ concepts: [], edges: [], ratings: [] });
    vi.mocked(api.nextPracticeProblem).mockResolvedValue(
      next({
        problem: problem(),
        rationale: "Starting at arrays_hashing, a little below average difficulty (1050).",
        evidence: { cold_start: true, concept: "arrays_hashing" },
      }),
    );

    renderPractice();

    expect(await screen.findByText("Maximum Sum of a Length-K Subarray")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start" })).toBeInTheDocument();
    // A cold-start user gets the same card as everyone else. There used to be a footer here
    // ("...finding your range") explaining the calibration; the cold start is deliberately silent,
    // so announcing it only to first-time users contradicted that.
    expect(screen.queryByText(/finding your range/)).not.toBeInTheDocument();
  });

  it("serves every problem as the same kind of problem — no worked example, no follow-up", async () => {
    // These used to be three distinct cards. A teaching problem was badged "worked example" and
    // its link read "Work through it" (you were meant to read the solution, not attempt it), and
    // the reinforce/transfer debts owed afterwards were badged "your turn" and "checking it
    // stuck". Teaching mode is gone; a server that somehow still sent those fields must not
    // resurrect the UI for them.
    vi.mocked(api.concepts).mockResolvedValue({ concepts: [], edges: [], ratings: [] });
    vi.mocked(api.nextPracticeProblem).mockResolvedValue(
      next({
        problem: problem(),
        ...({
          teaching: { reason: "stale", trigger: "consecutive_failures", transcribed: false },
          followup: { id: "f1", kind: "transfer", concept_id: "sliding_window", rationale: "x" },
        } as Partial<NextPracticeProblemResponse>),
      }),
    );

    renderPractice();

    expect(await screen.findByText("Maximum Sum of a Length-K Subarray")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start" })).toBeInTheDocument();
    for (const gone of ["worked example", "your turn", "checking it stuck"]) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("link", { name: "Work through it" })).not.toBeInTheDocument();
  });

  it("renders a waiting state — not an empty one — while a problem is being generated", async () => {
    vi.mocked(api.concepts).mockResolvedValue({
      concepts: [
        {
          id: "two_pointers",
          name: "Two Pointers",
          description: "",
          misconceptions: [],
          min_rating: 800,
          max_rating: 2400,
          sort_order: 1,
        },
      ],
      edges: [],
      ratings: [],
    });
    vi.mocked(api.nextPracticeProblem).mockResolvedValue(
      next({
        generating: {
          job_id: "job_1",
          concept_id: "two_pointers",
          target_rating: 1150,
          reason: "Nothing verified is left in that range.",
          progress: { stage: "differential", index: 4, total: 7, updated_at: null },
          started_at: new Date(Date.now() - 95_000).toISOString(),
        },
      }),
    );

    renderPractice();

    expect(await screen.findByText(/Writing you a new problem/i)).toBeInTheDocument();

    // The stage bar, not prose: the panel deliberately no longer renders `reason`, the concept
    // name, or the old "takes a minute or two" explanation.
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "4");
    expect(bar).toHaveAttribute("aria-valuemax", "7");
    expect(screen.getByText("Differential testing")).toBeInTheDocument();
    expect(screen.getByText("1:35")).toBeInTheDocument();

    expect(screen.queryByText(/Nothing verified is left in that range/)).not.toBeInTheDocument();
    expect(screen.queryByText(/takes a minute or two/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Two Pointers/)).not.toBeInTheDocument();
  });

  it("shows an indeterminate bar, not stage 1, while the job is still queued", async () => {
    vi.mocked(api.concepts).mockResolvedValue({ concepts: [], edges: [], ratings: [] });
    vi.mocked(api.nextPracticeProblem).mockResolvedValue(
      next({
        generating: {
          job_id: "job_q",
          concept_id: "two_pointers",
          target_rating: 1150,
          reason: "Nothing verified is left in that range.",
          // Nothing has reported progress: the job is queued behind other work. Claiming "Writing"
          // here would assert the model is running when it has not been picked up.
          progress: null,
          started_at: null,
        },
      }),
    );

    renderPractice();

    expect(await screen.findByText(/Writing you a new problem/i)).toBeInTheDocument();
    const bar = screen.getByRole("progressbar");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.queryByText("Writing")).not.toBeInTheDocument();
  });

  it("polls only while generating, so a problem the user is reading is never swapped out", async () => {
    vi.mocked(api.concepts).mockResolvedValue({ concepts: [], edges: [], ratings: [] });
    vi.mocked(api.nextPracticeProblem).mockResolvedValue(next({ problem: problem() }));

    renderPractice();
    await screen.findByText("Maximum Sum of a Length-K Subarray");

    const callsAfterLoad = vi.mocked(api.nextPracticeProblem).mock.calls.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(vi.mocked(api.nextPracticeProblem).mock.calls.length).toBe(callsAfterLoad);
  });

  it("offers no way to ask for a different problem — the pick is the only thing on offer", async () => {
    vi.mocked(api.concepts).mockResolvedValue({ concepts: [], edges: [], ratings: [] });
    vi.mocked(api.nextPracticeProblem).mockResolvedValue(next({ problem: problem() }));

    renderPractice();
    await screen.findByText("Maximum Sum of a Length-K Subarray");

    // There used to be a "Something else" button here that re-asked the API. It wrote no event, so
    // a user could shop for an easier problem and the ratings would never know — the exact thing
    // an Elo built out of forced encounters cannot tolerate.
    expect(screen.queryByRole("button", { name: "Something else" })).not.toBeInTheDocument();
    // "Start" is the only control on the card.
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("never re-shows the problem you just finished when you come back for the next one", async () => {
    // The reported symptom, end to end: "Next problem" shows the SAME problem, then flips to
    // "generating" a moment later. `Link to="/"` re-mounts this route, and React Query renders the
    // cached answer immediately while refetching behind it — so the user was handed back the
    // problem they had just solved, Start button and all, before the real answer landed. The page
    // must show its loading state instead until the server has actually answered.
    vi.mocked(api.concepts).mockResolvedValue({ concepts: [], edges: [], ratings: [] });
    vi.mocked(api.nextPracticeProblem).mockResolvedValue(next({ problem: problem() }));

    const client = makeTestQueryClient();
    const first = renderPracticeOn(client);
    await screen.findByText("Maximum Sum of a Length-K Subarray");

    // The user clicks "Start", solves it, then "Next problem" — i.e. this route unmounts and later
    // re-mounts on the same client. By then the pool is exhausted and the API says `generating`.
    first.unmount();
    vi.mocked(api.nextPracticeProblem).mockResolvedValue(
      next({
        generating: {
          job_id: "job_2",
          concept_id: "two_pointers",
          target_rating: 1150,
          reason: "Nothing verified is left in that range.",
          progress: { stage: "writing", index: 1, total: 7, updated_at: null },
          started_at: null,
        },
      }),
    );

    renderPracticeOn(client);

    // Synchronously, before the refetch can resolve: the finished problem must not be on screen.
    expect(screen.queryByText("Maximum Sum of a Length-K Subarray")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Start" })).not.toBeInTheDocument();

    expect(await screen.findByText(/Writing you a new problem/i)).toBeInTheDocument();
    expect(screen.queryByText("Maximum Sum of a Length-K Subarray")).not.toBeInTheDocument();
  });

  it("waits for the server rather than rendering a cached answer, whatever that answer turns out to be", async () => {
    // The mechanism behind the test above, isolated from what the second answer happens to be: a
    // still-in-flight second visit must show the loading state, not the previous visit's problem.
    // A future change that swaps `isFetchedAfterMount` back for `isLoading` (or "fixes" this by
    // invalidating the query from the workspace, which leaves the stale VALUE in place) fails here.
    vi.mocked(api.concepts).mockResolvedValue({ concepts: [], edges: [], ratings: [] });
    vi.mocked(api.nextPracticeProblem).mockResolvedValue(next({ problem: problem() }));

    const client = makeTestQueryClient();
    const view = renderPracticeOn(client);
    await screen.findByText("Maximum Sum of a Length-K Subarray");
    // The answer really is still cached — this test is about not *rendering* it, not about
    // throwing the cache away.
    expect(client.getQueryData(["practice", "next"])).toBeDefined();

    view.unmount();
    vi.mocked(api.nextPracticeProblem).mockReturnValue(new Promise(() => {}));

    renderPracticeOn(client);

    expect(screen.queryByText("Maximum Sum of a Length-K Subarray")).not.toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("surfaces the API's own rationale when there is genuinely nothing to serve", async () => {
    vi.mocked(api.concepts).mockResolvedValue({ concepts: [], edges: [], ratings: [] });
    vi.mocked(api.nextPracticeProblem).mockResolvedValue(
      next({ rationale: "The concept taxonomy is empty — run `pnpm db:migrate` to seed it." }),
    );

    renderPractice();

    expect(await screen.findByText(/concept taxonomy is empty/)).toBeInTheDocument();
  });
});

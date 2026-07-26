import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { NextPracticeProblemResponse, PublicProblem } from "@leetmind/shared";
import { Providers } from "../test/testUtils";
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
    teaching: null,
    followup: null,
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

describe("Practice", () => {
  it("shows the next problem with the concept it targets", async () => {
    vi.mocked(api.concepts).mockResolvedValue({ concepts: [], edges: [] });
    vi.mocked(api.nextPracticeProblem).mockResolvedValue(
      next({
        problem: problem(),
        rationale: "two_pointers is your weakest concept.",
        evidence: { concept: "two_pointers" },
      }),
    );

    renderPractice();

    expect(await screen.findByText("Maximum Sum of a Length-K Subarray")).toBeInTheDocument();
    expect(screen.getByText(/two_pointers is your weakest concept/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start" })).toHaveAttribute(
      "href",
      "/problem/01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
  });

  it("serves a brand-new user a problem rather than routing them into onboarding", async () => {
    // The regression this locks down: practice used to gate on `has_baseline` and bounce a
    // never-probed user to `/baseline`. There is no gate and no such route now — the cold-start
    // rule calibrates over the first few problems without the user having to complete anything.
    vi.mocked(api.concepts).mockResolvedValue({ concepts: [], edges: [] });
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
    expect(screen.getByText(/finding your range/)).toBeInTheDocument();
  });

  it("marks a teaching problem as a worked example and removes the escape hatch", async () => {
    vi.mocked(api.concepts).mockResolvedValue({ concepts: [], edges: [] });
    vi.mocked(api.nextPracticeProblem).mockResolvedValue(
      next({
        problem: problem(),
        teaching: {
          reason: "That's 2 in a row on sliding_window — let's go through one together.",
          trigger: "consecutive_failures",
          transcribed: false,
        },
        rationale: "That's 2 in a row on sliding_window — let's go through one together.",
      }),
    );

    renderPractice();

    expect(await screen.findByText("worked example")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Work through it" })).toBeInTheDocument();
    // "Something else" would let the user shuffle past the intervention chosen for them.
    expect(screen.queryByRole("button", { name: "Something else" })).not.toBeInTheDocument();
  });

  it("labels a transfer follow-up as a check that the teaching stuck", async () => {
    vi.mocked(api.concepts).mockResolvedValue({ concepts: [], edges: [] });
    vi.mocked(api.nextPracticeProblem).mockResolvedValue(
      next({
        problem: problem(),
        followup: {
          id: "f1",
          kind: "transfer",
          concept_id: "sliding_window",
          rationale: "Same concept as the one you were taught, in a form you haven't seen.",
        },
        rationale: "Same concept as the one you were taught, in a form you haven't seen.",
      }),
    );

    renderPractice();

    expect(await screen.findByText("checking it stuck")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Something else" })).not.toBeInTheDocument();
  });

  it("renders a waiting state — not an empty one — while a problem is being generated", async () => {
    vi.mocked(api.concepts).mockResolvedValue({
      concepts: [
        { id: "two_pointers", name: "Two Pointers", description: "", misconceptions: [], min_rating: 800, max_rating: 2400, sort_order: 1 },
      ],
      edges: [],
    });
    vi.mocked(api.nextPracticeProblem).mockResolvedValue(
      next({
        generating: {
          job_id: "job_1",
          concept_id: "two_pointers",
          target_rating: 1150,
          reason: "Nothing verified is left in that range.",
        },
      }),
    );

    renderPractice();

    expect(await screen.findByText(/Writing you a new problem/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing verified is left in that range/)).toBeInTheDocument();
    // The concept is shown by its human-readable name, not its slug.
    expect(screen.getByText(/Two Pointers/)).toBeInTheDocument();
  });

  it("polls only while generating, so a problem the user is reading is never swapped out", async () => {
    vi.mocked(api.concepts).mockResolvedValue({ concepts: [], edges: [] });
    vi.mocked(api.nextPracticeProblem).mockResolvedValue(next({ problem: problem() }));

    renderPractice();
    await screen.findByText("Maximum Sum of a Length-K Subarray");

    const callsAfterLoad = vi.mocked(api.nextPracticeProblem).mock.calls.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(vi.mocked(api.nextPracticeProblem).mock.calls.length).toBe(callsAfterLoad);
  });

  it("'Something else' re-asks the API rather than recording a skip", async () => {
    vi.mocked(api.concepts).mockResolvedValue({ concepts: [], edges: [] });
    vi.mocked(api.nextPracticeProblem).mockResolvedValue(next({ problem: problem() }));

    renderPractice();
    await screen.findByText("Maximum Sum of a Length-K Subarray");
    const before = vi.mocked(api.nextPracticeProblem).mock.calls.length;

    await userEvent.click(screen.getByRole("button", { name: "Something else" }));

    await waitFor(() => {
      expect(vi.mocked(api.nextPracticeProblem).mock.calls.length).toBeGreaterThan(before);
    });
  });

  it("surfaces the API's own rationale when there is genuinely nothing to serve", async () => {
    vi.mocked(api.concepts).mockResolvedValue({ concepts: [], edges: [] });
    vi.mocked(api.nextPracticeProblem).mockResolvedValue(
      next({ rationale: "The concept taxonomy is empty — run `pnpm db:migrate` to seed it." }),
    );

    renderPractice();

    expect(await screen.findByText(/concept taxonomy is empty/)).toBeInTheDocument();
  });
});

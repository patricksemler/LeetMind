import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PublicProblem, Submission } from "@leetmind/shared";
import { SubmissionsPanel } from "./SubmissionsPanel";

function problem(overrides: Partial<PublicProblem> = {}): PublicProblem {
  return {
    problem_version_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    problem_id: "p1",
    version: 1,
    title: "Pair Sum Indices",
    statement_md: "…",
    constraints_md: "…",
    signature: {
      name: "solve",
      params: [
        { name: "nums", type: "list[int]" },
        { name: "target", type: "int" },
      ],
      returns: "list[int]",
    },
    examples: [{ args: [[2, 7, 11, 15], 9], expected: [0, 1], explanation: "…" }],
    difficulty_rating: 1050,
    expected_active_minutes: [4, 10],
    comparator: "unordered",
    starter_code: { python: "", cpp: "" },
    hint_levels_available: [],
    concepts_revealed: null,
    ...overrides,
  } as PublicProblem;
}

function submission(overrides: Partial<Submission> = {}): Submission {
  return {
    id: "s1",
    user_id: "u1",
    problem_version_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    mode: "submit",
    language: "python",
    source: "def solve(): ...",
    status: "completed",
    verdict: "wrong_answer",
    passed_tests: 5,
    total_tests: 6,
    runtime_ms: 44,
    memory_kb: 14_300,
    created_at: "2026-07-26T10:00:00.000Z",
    ...overrides,
  } as Submission;
}

const HIDDEN_FAILURE = submission({
  failure: {
    kind: "assertion",
    message: "Output did not match the expected result.",
    first_failing_test_index: 3,
    tests: { public_passed: 2, public_total: 2, hidden_passed: 3, hidden_total: 4 },
    failing_test: {
      index: 3,
      origin: "hidden" as const,
      args: [[5, -2, 100000, 3], 3],
      expected: [1, 3],
      actual: null,
      status: "failed",
    },
  },
});

describe("SubmissionsPanel", () => {
  it("says what to do rather than showing an empty list before the first submit", () => {
    render(<SubmissionsPanel problem={problem()} submissions={[]} selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByText(/no submissions yet/i)).toBeInTheDocument();
  });

  it("renders a failing hidden case as a full case — input, expected, and the user's output", () => {
    render(
      <SubmissionsPanel problem={problem()} submissions={[HIDDEN_FAILURE]} selectedId="s1" onSelect={vi.fn()} />,
    );

    // The whole point of the change: a hidden failure is actionable, not just "a hidden test failed".
    // No heading over it — the verdict above already says the attempt failed.
    expect(screen.queryByText(/failing case/i)).not.toBeInTheDocument();
    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText(/\[\[5,-2,100000,3\],3\]|100000/)).toBeInTheDocument();
    expect(screen.getByText("Expected")).toBeInTheDocument();
    expect(screen.getByText("Your output")).toBeInTheDocument();
    // Named from the signature, exactly as a public case is rendered.
    expect(screen.getByText(/nums =/)).toBeInTheDocument();
  });

  it("labels a wrong answer as rejected, with the case count but not the public/hidden split", () => {
    render(
      <SubmissionsPanel problem={problem()} submissions={[HIDDEN_FAILURE]} selectedId="s1" onSelect={vi.fn()} />,
    );
    expect(screen.getAllByText(/rejected/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/wrong answer/i)).not.toBeInTheDocument();
    expect(screen.getByText("5 / 6 test cases")).toBeInTheDocument();
    // The "hidden test" tag on the failing case already says which side it came from.
    expect(screen.queryByText(/public 2\/2/)).not.toBeInTheDocument();
    expect(screen.queryByText(/45 ms/)).not.toBeInTheDocument();
  });

  it("marks each attempt pass/fail with a glyph, not colour alone", () => {
    const accepted = submission({ id: "s2", verdict: "accepted", passed_tests: 6 });
    const { container } = render(
      <SubmissionsPanel
        problem={problem()}
        submissions={[accepted, HIDDEN_FAILURE]}
        selectedId="s2"
        onSelect={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("✓");
    expect(container.textContent).toContain("✗");
  });

  it("shows the submitted code under the failing case", () => {
    const { container } = render(
      <SubmissionsPanel problem={problem()} submissions={[HIDDEN_FAILURE]} selectedId="s1" onSelect={vi.fn()} />,
    );
    expect(screen.getByText("Code")).toBeInTheDocument();
    // Highlighting splits the source across spans, so assert on the rendered text as a whole.
    expect(container.textContent).toContain("def solve(): ...");
  });

  it("selects a past attempt on click instead of only ever showing the newest", async () => {
    const onSelect = vi.fn();
    const older = submission({ id: "s0", verdict: "runtime_error", passed_tests: 0 });
    render(
      <SubmissionsPanel
        problem={problem()}
        submissions={[HIDDEN_FAILURE, older]}
        selectedId="s1"
        onSelect={onSelect}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /runtime error/i }));
    expect(onSelect).toHaveBeenCalledWith("s0");
  });

  it("lists nothing for an attempt that is still being judged", () => {
    // Not a placeholder row, not a blank detail — an unjudged attempt has no verdict, no counts and
    // no failing case, so it simply isn't in the tab until the judge comes back.
    const inFlight = submission({ id: "s-judging", status: "running", verdict: null, passed_tests: 0 });
    const { container } = render(
      <SubmissionsPanel
        problem={problem()}
        submissions={[inFlight, HIDDEN_FAILURE]}
        selectedId="s-judging"
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(container.textContent).not.toMatch(/judging/i);
    // …and the one attempt on screen is the judged one, not the pending id's stand-in.
    expect(screen.getByRole("button", { name: /rejected/i })).toBeInTheDocument();
    // No detail either: the selected attempt isn't judged, so nothing below the list.
    expect(screen.queryByText("Input")).not.toBeInTheDocument();
    expect(screen.queryByText("Code")).not.toBeInTheDocument();
  });

  it("says 'no submissions yet' while the first attempt is still being judged", () => {
    const inFlight = submission({ id: "s-judging", status: "queued", verdict: null, passed_tests: 0 });
    render(
      <SubmissionsPanel problem={problem()} submissions={[inFlight]} selectedId="s-judging" onSelect={vi.fn()} />,
    );
    expect(screen.getByText(/no submissions yet/i)).toBeInTheDocument();
  });

  it("shows only the five most recent attempts", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      submission({ id: `s${i}`, created_at: `2026-07-${20 + i}T10:00:00.000Z` }),
    ).reverse(); // newest first, as the API returns them
    render(<SubmissionsPanel problem={problem()} submissions={many} selectedId="s7" onSelect={vi.fn()} />);

    expect(screen.getAllByRole("button")).toHaveLength(5);
    // The five newest — the three oldest are dropped, not the other way round.
    expect(screen.getByText("Jul 27")).toBeInTheDocument();
    expect(screen.queryByText("Jul 22")).not.toBeInTheDocument();
  });

  it("never falls back to a previous attempt when the selected one isn't in the list yet", () => {
    // The tab is switched to the instant a verdict lands, a beat before the refetch that adds the
    // judged row. Showing the newest row's verdict and code under the heading of the one just
    // submitted would be a lie about which attempt is on screen.
    const { container } = render(
      <SubmissionsPanel problem={problem()} submissions={[HIDDEN_FAILURE]} selectedId="s-not-here" onSelect={vi.fn()} />,
    );
    expect(screen.queryByText("Input")).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("def solve(): ...");
    expect(screen.queryByText("5 / 6 test cases")).not.toBeInTheDocument();
  });

  it("shows only the verdict and the code that worked on an accepted attempt", () => {
    const accepted = submission({
      verdict: "accepted",
      passed_tests: 6,
      source: "def pairSumIndices(nums, target):\n    return [0, 1]\n",
      failure: { kind: "solved", message: "Accepted" },
      reveal: {
        editorial_md: "Use a hash map.",
        solutions: { python: "def reference(): ...", cpp: "int reference() { return 0; }" },
        target_complexity: { time: "O(n)", space: "O(n)" },
        concepts: [],
      },
    });
    const { container } = render(
      <SubmissionsPanel problem={problem()} submissions={[accepted]} selectedId="s1" onSelect={vi.fn()} />,
    );

    expect(screen.getAllByText(/accepted/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/pairSumIndices/)).toBeInTheDocument();
    // No case block at all on a pass — nothing failed, so there's nothing to show.
    expect(screen.queryByText("Input")).not.toBeInTheDocument();
    expect(screen.queryByText("Your output")).not.toBeInTheDocument();
    // Not the editorial, and not the reference implementation — this is a record of the attempt.
    expect(screen.queryByTestId("solution-pane")).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("Use a hash map");
    expect(container.textContent).not.toContain("def reference");
  });
});

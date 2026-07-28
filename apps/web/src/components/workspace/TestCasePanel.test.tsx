import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ProblemDetail, TestOutcome } from "@shared";
import { TestCasePanel } from "./TestCasePanel";

function problem(overrides: Partial<ProblemDetail> = {}): ProblemDetail {
  return {
    id: "p1",
    status: "active",
    primary_type: "arrays_hashing",
    support_types: [],
    shape: "pairing_matching",
    problem_rating: 1050,
    is_probe: false,
    title: "Pair Sum Indices",
    statement_md: "…",
    signature: {
      func_name: "solve",
      params: [
        { name: "nums", type: { kind: "int", nullable: false, list_depth: 1 } },
        { name: "target", type: { kind: "int", nullable: false, list_depth: 0 } },
      ],
      returns: { kind: "int", nullable: false, list_depth: 1 },
      order_insensitive: false,
    },
    starter_code: "",
    public_tests: [
      { args: [[2, 7, 11, 15], 9], expected: [0, 1] },
      { args: [[3, 2, 4], 6], expected: [1, 2] },
    ],
    complexity: { time: "O(n)", space: "O(n)" },
    par_minutes: 10,
    created_at: "2026-01-01T00:00:00Z",
    served_at: "2026-01-01T00:00:00Z",
    revealed_hints: [],
    ...overrides,
  } as ProblemDetail;
}

const RESULTS: TestOutcome[] = [
  { index: 0, verdict: "pass", value: [0, 1], printed: "", duration_ms: 1 },
  { index: 1, verdict: "wrong_answer", value: null, printed: "", duration_ms: 1 },
];

describe("TestCasePanel", () => {
  it("lists every public case before anything has run, with no marks yet", () => {
    render(<TestCasePanel problem={problem()} />);

    expect(screen.getByRole("tab", { name: /Case 1/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Case 2/ })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "passed" })).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "failed" })).not.toBeInTheDocument();
    // The values are readable up front — that is the point of showing the cases at all.
    expect(screen.getByText(/\[\[2,7,11,15\],9\]|\[2,7,11,15\]/)).toBeInTheDocument();
  });

  it("marks each case pass or fail once results land", () => {
    render(<TestCasePanel problem={problem()} results={RESULTS} />);

    expect(screen.getByRole("img", { name: "passed" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "failed" })).toBeInTheDocument();
  });

  it("names each input after its signature parameter rather than showing a positional blob", () => {
    const { container } = render(<TestCasePanel problem={problem()} results={RESULTS} />);
    expect(container.textContent).toContain("nums = ");
    expect(container.textContent).toContain("target = ");
  });

  it("shows the selected case's own expected and actual output, and switches with the tab", async () => {
    const { container } = render(<TestCasePanel problem={problem()} results={RESULTS} />);

    // Case 1 (passing) is selected by default.
    expect(container.textContent).toContain("[0,1]");

    await userEvent.click(screen.getByRole("tab", { name: /Case 2/ }));
    expect(container.textContent).toContain("[3,2,4]");
    expect(container.textContent).toContain("[1,2]");
    expect(container.textContent).toContain("null");
  });

  it("shows the error message for a case that errored", () => {
    render(
      <TestCasePanel
        problem={problem()}
        results={[
          { index: 0, verdict: "error", error: "boom", printed: "", duration_ms: 1 },
          { index: 1, verdict: "pass", value: [1, 2], printed: "", duration_ms: 1 },
        ]}
      />,
    );
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("degrades to a plain message for a problem with no public examples", () => {
    render(<TestCasePanel problem={problem({ public_tests: [] })} />);
    expect(screen.getByText(/no public example cases/i)).toBeInTheDocument();
  });
});

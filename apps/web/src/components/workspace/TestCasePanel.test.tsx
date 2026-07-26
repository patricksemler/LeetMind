import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { PublicProblem, PublicTestResult } from "@leetmind/shared";
import { TestCasePanel } from "./TestCasePanel";

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
    examples: [
      { args: [[2, 7, 11, 15], 9], expected: [0, 1], explanation: "nums[0] + nums[1] = 9." },
      { args: [[3, 2, 4], 6], expected: [1, 2] },
    ],
    difficulty_rating: 1050,
    expected_active_minutes: [4, 10],
    comparator: "unordered",
    starter_code: { python: "", cpp: "" },
    hint_levels_available: [],
    concepts_revealed: null,
    ...overrides,
  } as PublicProblem;
}

const RESULTS: PublicTestResult[] = [
  { index: 0, status: "passed", passed: true, actual: [0, 1] },
  { index: 1, status: "failed", passed: false, actual: null },
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

  it("shows only the marks — no pass counter, and no restatement of the example's prose", () => {
    const { container } = render(<TestCasePanel problem={problem()} results={RESULTS} />);
    expect(container.textContent).not.toMatch(/\d\/\d/);
    // The explanation lives on the problem statement; repeating it here undoes the compactness
    // the case list exists for.
    expect(container.textContent).not.toContain("nums[0] + nums[1]");
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

  it("explains a case that never ran instead of rendering an empty output box", () => {
    render(
      <TestCasePanel
        problem={problem()}
        results={[
          { index: 0, status: "error", passed: false },
          { index: 1, status: "not_run", passed: false },
        ]}
      />,
    );
    expect(screen.getByText("error")).toBeInTheDocument();
  });

  it("degrades to a plain message for a problem with no public examples", () => {
    render(<TestCasePanel problem={problem({ examples: [] })} />);
    expect(screen.getByText(/no public example cases/i)).toBeInTheDocument();
  });
});

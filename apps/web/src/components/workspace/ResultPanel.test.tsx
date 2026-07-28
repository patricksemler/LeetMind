import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProblemDetail } from "@shared";
import { ResultPanel, type LastResult } from "./ResultPanel";

function problem(): ProblemDetail {
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
      params: [{ name: "nums", type: { kind: "int", nullable: false, list_depth: 1 } }],
      returns: { kind: "int", nullable: false, list_depth: 0 },
      order_insensitive: false,
    },
    starter_code: "",
    public_tests: [],
    complexity: { time: "O(n)", space: "O(n)" },
    par_minutes: 10,
    created_at: "2026-01-01T00:00:00Z",
    served_at: "2026-01-01T00:00:00Z",
    revealed_hints: [],
  } as ProblemDetail;
}

describe("ResultPanel", () => {
  it("prompts to submit when nothing has run yet", () => {
    render(<ResultPanel problem={problem()} result={null} />);
    expect(screen.getByText(/no submissions yet/i)).toBeInTheDocument();
  });

  it("points at the test case panel for a plain run", () => {
    const result: LastResult = { kind: "run", passed: true, solved: false, results: [], code: "" };
    render(<ResultPanel problem={problem()} result={result} />);
    expect(screen.getByText(/see the test cases below/i)).toBeInTheDocument();
  });

  it("shows accepted with no failing case for a solved submit", () => {
    const result: LastResult = {
      kind: "submit",
      passed: true,
      solved: true,
      results: [],
      code: "def solve(nums): return nums",
    };
    render(<ResultPanel problem={problem()} result={result} />);
    expect(screen.getByText("accepted")).toBeInTheDocument();
    expect(screen.getByTestId("results-panel")).toHaveTextContent("def solve");
  });

  it("shows rejected with the failing private case for a failed submit", () => {
    const result: LastResult = {
      kind: "submit",
      passed: false,
      solved: false,
      results: [],
      failingCase: { input: [[1, 2]], expected: 3, actual: 4 },
      code: "def solve(nums): return 4",
    };
    render(<ResultPanel problem={problem()} result={result} />);
    expect(screen.getByText("rejected")).toBeInTheDocument();
    expect(screen.getByText("Your output").nextElementSibling).toHaveTextContent("4");
  });
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProblemDetail } from "@shared";
import { StatementPane } from "./StatementPane";

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
    statement_md: "Return the indices of two values whose sum equals `target`.",
    constraints: ["2 <= nums.length <= 10^5", "-10^9 <= nums[i], target <= 10^9"],
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
    public_tests: [{ args: [[2, 7, 11, 15], 9], expected: [0, 1] }],
    complexity: { time: "O(n)", space: "O(n)" },
    par_minutes: 10,
    created_at: "2026-01-01T00:00:00Z",
    served_at: "2026-01-01T00:00:00Z",
    revealed_hints: [],
  } as ProblemDetail;
}

describe("StatementPane", () => {
  it("renders examples once and places constraints directly after target complexity", () => {
    const { container } = render(<StatementPane problem={problem()} />);

    expect(screen.getAllByText("Examples")).toHaveLength(1);
    expect(container.textContent?.match(/input:/g)).toHaveLength(1);
    expect(screen.getByText("2 <= nums.length <= 10^5")).toBeInTheDocument();

    const headings = Array.from(container.querySelectorAll("h3")).map((node) => node.textContent);
    expect(headings).toEqual(["Examples", "Target complexity", "Constraints"]);
  });
});

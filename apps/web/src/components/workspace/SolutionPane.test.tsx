import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SolutionPane } from "./SolutionPane";

const PYTHON = "def maxSumSubarray(nums, k):\n    return max(nums)\n";

describe("SolutionPane", () => {
  it("renders the reference solution as a Python code block", () => {
    render(<SolutionPane referenceSolution={PYTHON} />);

    expect(screen.getByTestId("solution-pane")).toHaveTextContent("def maxSumSubarray(nums, k):");
  });
});

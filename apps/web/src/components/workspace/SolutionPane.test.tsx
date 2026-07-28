/**
 * The post-reveal solution view's language switch.
 *
 * The switch is the visible end of a chain that starts in the content plane: the generation prompt
 * asks for a `reference_solution_cpp` alongside `reference_solution_py`, the LEETMIND envelope
 * carries it as its own delimited block, `ProblemVersionSchema` keeps it optional, and the API's
 * reveal payloads map the pair into `solutions: {python, cpp}`. These tests pin the two ends of
 * that chain that the user actually sees: both languages present ⇒ a working toggle; Python alone
 * (every version generated before the C++ reference existed) ⇒ a single-language view with no
 * empty tab, no dead toggle, and no error.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SolutionPane } from "./SolutionPane";

const PYTHON = "def maxSumSubarray(nums, k):\n    return max(nums)\n";
const CPP =
  "class Solution {\npublic:\n    long long maxSumSubarray(std::vector<long long> nums, long long k) {\n        return 0;\n    }\n};\n";

const EDITORIAL = "Slide a window of k elements.\n\n## Complexity\n\n- Time: O(n)";

function languageButtons() {
  return within(screen.getByRole("group", { name: "Solution language" })).getAllByRole("button");
}

describe("SolutionPane", () => {
  it("offers a Python/C++ switch when the reveal carries both languages", async () => {
    const user = userEvent.setup();
    render(<SolutionPane editorialMd={EDITORIAL} solutions={{ python: PYTHON, cpp: CPP }} />);

    const buttons = languageButtons();
    expect(buttons.map((b) => b.textContent)).toEqual(["Python", "C++"]);

    // Python is the default, and its source — not the C++ — is what renders.
    expect(buttons[0]).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("solution-pane")).toHaveTextContent("def maxSumSubarray(nums, k):");
    expect(screen.getByTestId("solution-pane")).not.toHaveTextContent("class Solution");

    await user.click(buttons[1]!);

    expect(buttons[1]).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("solution-pane")).toHaveTextContent("class Solution");
    // The type-mapped signature the C++ harness requires survives to the screen intact.
    expect(screen.getByTestId("solution-pane")).toHaveTextContent("std::vector<long long> nums");
  });

  it("renders a Python-only view, with no C++ tab, when the version predates the C++ reference", () => {
    render(<SolutionPane editorialMd={EDITORIAL} solutions={{ python: PYTHON }} />);

    expect(languageButtons().map((b) => b.textContent)).toEqual(["Python"]);
    expect(screen.queryByRole("button", { name: "C++" })).not.toBeInTheDocument();
    expect(screen.getByTestId("solution-pane")).toHaveTextContent("def maxSumSubarray(nums, k):");
  });

  it("renders the editorial write-up as markdown, with no 'Approach' heading of its own", () => {
    render(<SolutionPane editorialMd={EDITORIAL} solutions={{ python: PYTHON }} />);

    // Editorials now lead with the explanation; the only heading is the one that names a
    // genuinely different section.
    const headings = screen.getAllByRole("heading");
    expect(headings.map((h) => h.textContent)).toEqual(["Complexity"]);
  });
});

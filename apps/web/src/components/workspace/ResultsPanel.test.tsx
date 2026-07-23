import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { VerdictEvent } from "@algolift/shared";
import { ResultsPanel } from "./ResultsPanel";

// Distinctive sentinel values — the test asserts these exact strings never reach the DOM in
// submit mode, rather than asserting on the word "expected" (which legitimately appears in
// prose like "Output did not match the expected result").
const SECRET_EXPECTED = "__SECRET_EXPECTED_9F3A__";
const SECRET_ACTUAL = "__SECRET_ACTUAL_2B7C__";
const SECRET_INPUT = "__SECRET_INPUT_11D0__";

function wrongAnswerVerdict(overrides?: Partial<VerdictEvent>): VerdictEvent {
  return {
    submission_id: "sub_1",
    verdict: "wrong_answer",
    passed_tests: 2,
    total_tests: 4,
    runtime_ms: 30,
    memory_kb: 14000,
    failure: {
      kind: "assertion",
      message: "Output did not match the expected result on hidden test 3.",
      first_failing_test_index: 2,
      input_preview: SECRET_INPUT,
      expected_preview: SECRET_EXPECTED,
      actual_preview: SECRET_ACTUAL,
    },
    ...overrides,
  };
}

describe("ResultsPanel", () => {
  it("never renders expected/actual/input values for a submit-mode wrong_answer, even if the payload illegitimately carries them", () => {
    const { container } = render(
      <ResultsPanel
        mode="submit"
        status="completed"
        progress={null}
        verdict={wrongAnswerVerdict()}
        connectionState="closed"
      />,
    );

    expect(container.textContent).not.toContain(SECRET_EXPECTED);
    expect(container.textContent).not.toContain(SECRET_ACTUAL);
    expect(container.textContent).not.toContain(SECRET_INPUT);

    // it still surfaces the safe, non-leaking diagnostic
    expect(screen.getByText(/failed on hidden test/i)).toBeInTheDocument();
    expect(container.textContent).toContain("#3");
  });

  it("shows input/expected/actual previews in run mode", () => {
    const runValues = { input: "[2,7,11,15]", expected: "9", actual: "8" };
    const { container } = render(
      <ResultsPanel
        mode="run"
        status="completed"
        progress={null}
        verdict={wrongAnswerVerdict({
          failure: {
            kind: "assertion",
            message: "Output did not match on the custom input.",
            input_preview: runValues.input,
            expected_preview: runValues.expected,
            actual_preview: runValues.actual,
          },
        })}
        connectionState="closed"
      />,
    );

    expect(container.textContent).toContain(JSON.stringify(runValues.input));
    expect(container.textContent).toContain(JSON.stringify(runValues.expected));
    expect(container.textContent).toContain(JSON.stringify(runValues.actual));
  });

  it("shows the program's actual output on an accepted run — the one thing custom-input Run is for", () => {
    const { container } = render(
      <ResultsPanel
        mode="run"
        status="completed"
        progress={null}
        verdict={{
          submission_id: "sub_run_1",
          verdict: "accepted",
          passed_tests: 0,
          total_tests: 0,
          runtime_ms: 12,
          memory_kb: 13000,
          failure: {
            kind: "ok",
            message: "Ran successfully.",
            input_preview: [2, 7, 11, 15],
            actual_preview: [0, 1],
          },
        }}
        connectionState="closed"
      />,
    );

    // Not a graded pass/fail — the badge says "ran", not "accepted", and doesn't claim a
    // passed-test count that never existed.
    expect(screen.getByText("ran")).toBeInTheDocument();
    expect(screen.queryByText(/passed$/)).not.toBeInTheDocument();
    expect(container.textContent).toContain(JSON.stringify([0, 1]));
  });

  it("renders stderr_tail in a monospace block for a runtime error", () => {
    render(
      <ResultsPanel
        mode="submit"
        status="completed"
        progress={null}
        verdict={{
          submission_id: "sub_2",
          verdict: "runtime_error",
          passed_tests: 0,
          total_tests: 4,
          runtime_ms: 10,
          memory_kb: 12000,
          failure: { kind: "runtime_error", message: "boom", stderr_tail: "Traceback (most recent call last):\nRuntimeError: boom" },
        }}
        connectionState="closed"
      />,
    );
    expect(screen.getByText(/RuntimeError: boom/)).toBeInTheDocument();
  });

  it("shows a live per-test progress bar while running, before any verdict has landed", () => {
    const { container } = render(
      <ResultsPanel mode="submit" status="running" progress={{ passed: 3, total: 7 }} verdict={null} connectionState="open" />,
    );
    expect(container.textContent).toContain("Running tests");
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "3");
    expect(bar).toHaveAttribute("aria-valuemax", "7");
  });

  it("shows an empty state before anything has run", () => {
    render(<ResultsPanel mode={null} status={null} progress={null} verdict={null} connectionState="idle" />);
    expect(screen.getByText(/run against custom input or submit/i)).toBeInTheDocument();
  });

  it("renders the editorial + complexity from verdict.reveal on an accepted submit — the real API shape, not the mock-only failure.editorial_md", () => {
    const { container } = render(
      <ResultsPanel
        mode="submit"
        status="completed"
        progress={null}
        verdict={{
          submission_id: "sub_3",
          verdict: "accepted",
          passed_tests: 4,
          total_tests: 4,
          runtime_ms: 20,
          memory_kb: 14000,
          failure: { kind: "solved", message: "Accepted" },
          reveal: {
            editorial_md: "Use a hash map to track complements.",
            target_complexity: { time: "O(n)", space: "O(n)" },
            concepts: [{ id: "arrays_hashing", name: "Arrays & Hashing", role: "primary", weight: 1 }],
          },
        }}
        connectionState="closed"
      />,
    );

    expect(screen.getByText(/use a hash map to track complements/i)).toBeInTheDocument();
    expect(container.textContent).toContain("O(n)");
  });
});

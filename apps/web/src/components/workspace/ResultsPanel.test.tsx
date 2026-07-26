import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { VerdictEvent } from "@leetmind/shared";
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
      message: "Output did not match the expected result.",
      first_failing_test_index: 2,
      input_preview: SECRET_INPUT,
      expected_preview: SECRET_EXPECTED,
      actual_preview: SECRET_ACTUAL,
      tests: { public_passed: 2, public_total: 2, hidden_passed: 0, hidden_total: 2 },
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

    // it still surfaces the safe, non-leaking diagnostic — WHICH hidden test, and the fact that
    // every visible example passed, which is the actionable half
    expect(screen.getByText(/every public example passed/i)).toBeInTheDocument();
    expect(container.textContent).toContain("hidden test #1");
    expect(container.textContent).toContain("public 2/2");
    expect(container.textContent).toContain("hidden 0/2");
  });

  it("withholds previews on a submit failure with no recorded split, rather than assuming they are safe", () => {
    // Older rows carry no `tests` summary. The component cannot prove the failing test was public,
    // so it must not render values a payload merely happens to contain.
    const { container } = render(
      <ResultsPanel
        mode="submit"
        status="completed"
        progress={null}
        verdict={wrongAnswerVerdict({
          failure: {
            kind: "assertion",
            message: "Output did not match the expected result.",
            first_failing_test_index: 2,
            input_preview: SECRET_INPUT,
            expected_preview: SECRET_EXPECTED,
            actual_preview: SECRET_ACTUAL,
          },
        })}
        connectionState="closed"
      />,
    );

    expect(container.textContent).not.toContain(SECRET_EXPECTED);
    expect(container.textContent).not.toContain(SECRET_ACTUAL);
    expect(container.textContent).not.toContain(SECRET_INPUT);
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

  it("renders nothing before anything has run — the case list below is the panel in that state", () => {
    const { container } = render(
      <ResultsPanel mode={null} status={null} progress={null} verdict={null} connectionState="idle" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a graded run — the per-case marks already carry the result", () => {
    const { container } = render(
      <ResultsPanel
        mode="run"
        status="completed"
        progress={null}
        verdict={wrongAnswerVerdict()}
        connectionState="closed"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("still renders for a run that failed to compile — a crash has no per-case marks to speak through", () => {
    render(
      <ResultsPanel
        mode="run"
        status="completed"
        progress={null}
        verdict={wrongAnswerVerdict({
          verdict: "compilation_error",
          failure: { kind: "compilation_error", message: "boom", stderr_tail: "line 3: unexpected token" },
        })}
        connectionState="closed"
      />,
    );
    expect(screen.getByText(/unexpected token/)).toBeInTheDocument();
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

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { BaselineItem, BaselineSession } from "@leetmind/shared";
import { Providers } from "../../test/testUtils";
import { BaselineRunner } from "./BaselineRunner";

vi.mock("../../lib/api", () => ({
  api: {
    skipBaselineItem: vi.fn(),
    concepts: vi.fn(),
    progress: vi.fn(),
  },
}));

import { api } from "../../lib/api";

function item(overrides: Partial<BaselineItem> = {}): BaselineItem {
  return {
    id: "item-1",
    baseline_session_id: "session-1",
    position: 0,
    problem_version_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    rationale: "Baseline: arrays_hashing, low-mid difficulty.",
    selection_evidence: { concept_id: "arrays_hashing", title: "Pair Sum", expected_active_minutes: [5, 12] },
    state: "pending",
    active_ms: 0,
    started_at: null,
    completed_at: null,
    ...overrides,
  } as BaselineItem;
}

function session(items: BaselineItem[], overrides: Partial<BaselineSession> = {}): BaselineSession {
  return {
    id: "session-1",
    user_id: "u1",
    status: "active",
    rationale: { summary: "Short adaptive baseline across 6 concepts." },
    created_at: new Date().toISOString(),
    completed_at: null,
    planned_count: 6,
    items,
    ...overrides,
  } as BaselineSession;
}

function renderRunner(s: BaselineSession) {
  vi.mocked(api.concepts).mockResolvedValue({
    concepts: [
      { id: "arrays_hashing", name: "Arrays & Hashing", description: "", misconceptions: [], min_rating: 800, max_rating: 2400, sort_order: 0 },
    ],
    edges: [],
  });
  return render(
    <Providers>
      <MemoryRouter>
        <BaselineRunner baseline={s} />
      </MemoryRouter>
    </Providers>,
  );
}

describe("BaselineRunner", () => {
  it("gives skipping the same visual weight as attempting — the whole flow depends on skipping feeling safe", async () => {
    renderRunner(session([item()]));

    const attempt = await screen.findByRole("link", { name: "Try it" });
    const skip = screen.getByRole("button", { name: /Haven't learned this yet/i });

    expect(attempt).toBeInTheDocument();
    expect(skip).toBeInTheDocument();
    // Both are real, enabled affordances sitting together — not a button and a buried text link.
    expect(skip).toBeEnabled();
  });

  it("explains what a skip buys rather than warning about what it costs", async () => {
    renderRunner(session([item()]));

    await userEvent.click(await screen.findByRole("button", { name: /Haven't learned this yet/i }));

    expect(await screen.findByText(/useful information, not a failure/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip it" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Let me try" })).toBeInTheDocument();
  });

  it("sends reason=inability when the skip is confirmed", async () => {
    vi.mocked(api.skipBaselineItem).mockResolvedValue({
      item: item({ state: "skipped_inability" }),
      mastery_change: {
        changes: [
          { concept_id: "arrays_hashing", before_rating: 1200, after_rating: 1150, before_uncertainty: 350, after_uncertainty: 300 },
        ],
        outcome: 0,
        explanation: "Skipped — lowered the estimate and tightened the uncertainty.",
      },
    });

    renderRunner(session([item()]));
    await userEvent.click(await screen.findByRole("button", { name: /Haven't learned this yet/i }));
    await userEvent.click(screen.getByRole("button", { name: "Skip it" }));

    await waitFor(() => {
      expect(api.skipBaselineItem).toHaveBeenCalledWith("item-1", { reason: "inability" });
    });
    // No mastery-change panel: the skip is recorded server-side, the UI just moves on.
    expect(screen.queryByTestId("mastery-delta")).not.toBeInTheDocument();
  });

  it("reports progress against the planned count, not just the items materialised so far", async () => {
    renderRunner(
      session([
        item({ id: "a", position: 0, state: "solved" }),
        item({ id: "b", position: 1, state: "skipped_inability" }),
        item({ id: "c", position: 2, state: "pending" }),
      ]),
    );

    // Two resolved of six planned — the remaining probes don't exist as rows yet, which is exactly
    // why `planned_count` has to come from the plan rather than from `items.length`.
    expect(await screen.findByText("2 of 6 answered")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Baseline progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "2");
    expect(bar).toHaveAttribute("aria-valuemax", "6");
  });

  it("offers only a Review link for a resolved probe — there is nothing left to skip", async () => {
    renderRunner(session([item({ state: "solved" })]));

    expect(await screen.findByRole("link", { name: "Review" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Haven't learned this yet/i })).not.toBeInTheDocument();
  });

  it("labels an inability skip in the user's own terms rather than as a failure", async () => {
    renderRunner(session([item({ state: "skipped_inability" })]));
    expect(await screen.findByText("skipped — not learned yet")).toBeInTheDocument();
  });
});

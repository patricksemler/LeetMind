import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProgressResponse } from "@leetmind/shared";
import { Providers } from "../test/testUtils";
import { Concepts } from "./Concepts";

vi.mock("../lib/api", () => ({
  api: {
    concepts: vi.fn(),
    progress: vi.fn(),
  },
}));

import { api } from "../lib/api";

function emptyProgress(overrides: Partial<ProgressResponse> = {}): ProgressResponse {
  return {
    concepts: [],
    reviews_due: [],
    stats: { solve_bands: [], error_categories: [], median_active_ms: null },
    records: { highest_unassisted_difficulty_solved: null },
    history: [],
    ...overrides,
  };
}

describe("Concepts", () => {
  it("joins mastery data by concept_id — not id — so an attempted concept shows its rating instead of rendering unattempted", async () => {
    vi.mocked(api.concepts).mockResolvedValue({
      concepts: [{ id: "arrays_hashing", name: "Arrays & Hashing", description: "", misconceptions: [], min_rating: 800, max_rating: 2400, sort_order: 0 }],
      edges: [],
    });
    // The real GET /api/progress response keys each row by `concept_id`, not `id`
    // (apps/api/src/routes/progress.ts) — this fixture matches that real shape.
    vi.mocked(api.progress).mockResolvedValue(
      emptyProgress({
        concepts: [
          {
            concept_id: "arrays_hashing",
            name: "Arrays & Hashing",
            rating: 1450,
            uncertainty: 120,
            attempts: 9,
            solves: 7,
            unassisted_solves: 5,
            trend: "up",
          },
        ],
      }),
    );

    render(
      <Providers>
        <Concepts />
      </Providers>,
    );

    expect(await screen.findByText("Arrays & Hashing")).toBeInTheDocument();
    // Keying by `id` (the old bug) would find no match and this attempted concept would render
    // with no rating badge at all, identical to an untouched one.
    expect(await screen.findByText("1450")).toBeInTheDocument();
  });

  it("renders a multi-parent concept's subtree once, not once per parent", async () => {
    const mk = (id: string, name: string) => ({
      id,
      name,
      description: "",
      misconceptions: [],
      min_rating: 800,
      max_rating: 2400,
      sort_order: 0,
    });
    // "shared" has two parents ("root_a", "root_b") and its own child "shared_child" — the DAG
    // shape that used to render the whole {shared, shared_child} subtree twice (QA-PLAN.md §3).
    vi.mocked(api.concepts).mockResolvedValue({
      concepts: [
        mk("root_a", "Root A"),
        mk("root_b", "Root B"),
        mk("shared", "Shared Concept"),
        mk("shared_child", "Shared Child"),
      ],
      edges: [
        { parent_id: "root_a", child_id: "shared" },
        { parent_id: "root_b", child_id: "shared" },
        { parent_id: "shared", child_id: "shared_child" },
      ],
    });
    vi.mocked(api.progress).mockResolvedValue(emptyProgress());

    render(
      <Providers>
        <Concepts />
      </Providers>,
    );

    expect(await screen.findByText("Root A")).toBeInTheDocument();
    expect(screen.getByText("Root B")).toBeInTheDocument();
    // "Shared Concept" appears once under each parent it's reachable from (that's the DAG shape,
    // not a bug) — but its SUBTREE only expands once. Previously the whole {shared, shared_child}
    // subtree rendered again under the second parent with no indication it was the same node.
    expect(screen.getAllByText("Shared Concept")).toHaveLength(2);
    expect(screen.getAllByText("Shared Child")).toHaveLength(1);
    // The second (non-expanding) occurrence carries a marker instead of looking like a silently
    // truncated branch.
    expect(screen.getByText(/also under/i)).toBeInTheDocument();
  });

  it("still renders the taxonomy when the progress fetch fails, with a retry notice instead of every concept silently reading as unattempted", async () => {
    vi.mocked(api.concepts).mockResolvedValue({
      concepts: [{ id: "arrays_hashing", name: "Arrays & Hashing", description: "", misconceptions: [], min_rating: 800, max_rating: 2400, sort_order: 0 }],
      edges: [],
    });
    vi.mocked(api.progress).mockRejectedValue(new Error("network down"));

    render(
      <Providers>
        <Concepts />
      </Providers>,
    );

    // The taxonomy itself isn't gated on the progress fetch succeeding.
    expect(await screen.findByText("Arrays & Hashing")).toBeInTheDocument();
    expect(screen.getByText(/mastery data failed to load/i)).toBeInTheDocument();

    // Earlier tests in this file also call the (shared, un-reset) `api.progress` mock, so assert
    // the retry causes another call relative to its own baseline rather than an absolute count.
    const callsBeforeRetry = vi.mocked(api.progress).mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(vi.mocked(api.progress).mock.calls.length).toBeGreaterThan(callsBeforeRetry);
  });
});

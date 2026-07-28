import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GetConceptsResponse } from "@shared";
import { Providers } from "../test/testUtils";
import { Concepts } from "./Concepts";

vi.mock("../lib/api", () => ({
  api: {
    concepts: vi.fn(),
  },
}));

import { api } from "../lib/api";

function mkConcept(id: string, name: string) {
  return {
    id,
    name,
    description: "",
    misconceptions: [],
    min_rating: 800,
    max_rating: 2400,
    sort_order: 0,
  };
}

function mkResponse(overrides: Partial<GetConceptsResponse> = {}): GetConceptsResponse {
  return { concepts: [], edges: [], ratings: [], ...overrides };
}

describe("Concepts", () => {
  it("joins ratings by concept_id — not id — so a rated concept shows its Elo instead of rendering unattempted", async () => {
    vi.mocked(api.concepts).mockResolvedValue(
      mkResponse({
        concepts: [mkConcept("arrays_hashing", "Arrays & Hashing")],
        // The API keys each rating row by `concept_id`, not `id` — keying by `id` here would find
        // no match and the concept would render with no badge at all, identical to an untouched
        // one.
        ratings: [{ concept_id: "arrays_hashing", rating: 1450, attempts: 9 }],
      }),
    );

    render(
      <Providers>
        <Concepts />
      </Providers>,
    );

    expect(await screen.findByText("Arrays & Hashing")).toBeInTheDocument();
    expect(await screen.findByText("1450")).toBeInTheDocument();
  });

  it("renders a concept with no rating row as unattempted rather than inventing a 1200", async () => {
    vi.mocked(api.concepts).mockResolvedValue(
      mkResponse({ concepts: [mkConcept("two_pointers", "Two Pointers")], ratings: [] }),
    );

    render(
      <Providers>
        <Concepts />
      </Providers>,
    );

    expect(await screen.findByText("Two Pointers")).toBeInTheDocument();
    // The seeded default is 1200, and showing it would assert an estimate nothing measured. A
    // never-probed concept carries no badge at all.
    expect(screen.queryByText("1200")).not.toBeInTheDocument();
  });

  it("renders a multi-parent concept's subtree once, not once per parent", async () => {
    // "shared" has two parents ("root_a", "root_b") and its own child "shared_child" — the DAG
    // shape that used to render the whole {shared, shared_child} subtree twice (QA-PLAN.md §3).
    vi.mocked(api.concepts).mockResolvedValue(
      mkResponse({
        concepts: [
          mkConcept("root_a", "Root A"),
          mkConcept("root_b", "Root B"),
          mkConcept("shared", "Shared Concept"),
          mkConcept("shared_child", "Shared Child"),
        ],
        edges: [
          { parent_id: "root_a", child_id: "shared" },
          { parent_id: "root_b", child_id: "shared" },
          { parent_id: "shared", child_id: "shared_child" },
        ],
      }),
    );

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
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConceptTags } from "./ConceptTags";

const CONCEPTS = [
  { id: "arrays_hashing", role: "primary" as const, weight: 0.7 },
  { id: "two_pointers", role: "secondary" as const, weight: 0.3 },
];

describe("ConceptTags", () => {
  it("hides concepts before solve/give-up, even if concept data is present in props", () => {
    render(<ConceptTags revealed={false} concepts={CONCEPTS} />);
    expect(screen.queryByTestId("concept-tags")).not.toBeInTheDocument();
    expect(screen.queryByText("arrays_hashing")).not.toBeInTheDocument();
    expect(screen.getByText(/hidden until you solve or give up/i)).toBeInTheDocument();
  });

  it("hides concepts when concepts_revealed is null, regardless of the revealed flag", () => {
    render(<ConceptTags revealed concepts={null} />);
    expect(screen.queryByTestId("concept-tags")).not.toBeInTheDocument();
  });

  it("shows concepts once revealed=true and concept data is available", () => {
    render(<ConceptTags revealed concepts={CONCEPTS} />);
    expect(screen.getByTestId("concept-tags")).toBeInTheDocument();
    expect(screen.getByText("arrays_hashing")).toBeInTheDocument();
    expect(screen.getByText("two_pointers")).toBeInTheDocument();
  });

  it("resolves display names when a name lookup is provided", () => {
    render(<ConceptTags revealed concepts={CONCEPTS} names={{ arrays_hashing: { id: "arrays_hashing", name: "Arrays & Hashing", description: "", misconceptions: [], min_rating: 800, max_rating: 2400, sort_order: 0 } }} />);
    expect(screen.getByText("Arrays & Hashing")).toBeInTheDocument();
  });
});

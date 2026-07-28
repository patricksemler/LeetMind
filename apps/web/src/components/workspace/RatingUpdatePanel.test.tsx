import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RatingUpdateView } from "@shared";
import { RatingUpdatePanel } from "./RatingUpdatePanel";

const UPDATE: RatingUpdateView = {
  type_slug: "arrays_hashing",
  rating_before: 1200,
  rating_after: 1236,
  delta: 36,
  problem_rating: 1180,
  expected_score: 0.4,
  performance_score: 1,
  k_factor: 40,
  metrics: { runs: 2, submissions: 1, hints_revealed: 0, minutes: 6.5, gave_up: false },
};

describe("RatingUpdatePanel", () => {
  it("shows the before/after rating and the signed delta", () => {
    render(<RatingUpdatePanel update={UPDATE} />);

    expect(screen.getByText("1200")).toBeInTheDocument();
    expect(screen.getByText("1236")).toBeInTheDocument();
    expect(screen.getByText("+36")).toBeInTheDocument();
  });

  it("lists the metrics that shaped the update", () => {
    render(<RatingUpdatePanel update={UPDATE} />);
    expect(screen.getByText("runs")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("shows a negative delta without a leading plus", () => {
    render(<RatingUpdatePanel update={{ ...UPDATE, delta: -12 }} />);
    expect(screen.getByText("-12")).toBeInTheDocument();
  });
});

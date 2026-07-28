import { describe, expect, it } from "vitest";
import { withConceptNames } from "./conceptNames";

describe("withConceptNames", () => {
  const names = { arrays_hashing: "Arrays & Hashing", dp_1d: "1D DP", dp_1d_2d: "1D + 2D DP" };

  it("replaces slugs with display names so one panel never shows both forms", () => {
    expect(
      withConceptNames("arrays_hashing is your weakest concept.", ["arrays_hashing"], names),
    ).toBe("Arrays & Hashing is your weakest concept.");
  });

  it("replaces the longest slug first, so one slug being a prefix of another can't corrupt it", () => {
    expect(withConceptNames("dp_1d_2d and dp_1d", ["dp_1d", "dp_1d_2d"], names)).toBe(
      "1D + 2D DP and 1D DP",
    );
  });

  it("leaves text alone when no names are available or a slug has no display name", () => {
    expect(withConceptNames("arrays_hashing wins", ["arrays_hashing"], undefined)).toBe(
      "arrays_hashing wins",
    );
    expect(withConceptNames("greedy wins", ["greedy"], names)).toBe("greedy wins");
    expect(withConceptNames("", ["arrays_hashing"], names)).toBe("");
  });
});

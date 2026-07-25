import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GiveUpResponse } from "@leetmind/shared";
import { Providers } from "../../test/testUtils";
import { GiveUpControl } from "./GiveUpControl";

vi.mock("../../lib/api", () => ({
  api: { giveUp: vi.fn() },
}));
import { api } from "../../lib/api";

const RESPONSE: GiveUpResponse = {
  editorial_md: "## Approach\nMaintain a hash map of values seen so far.",
  concepts: [
    { id: "arrays_hashing", name: "Arrays & Hashing", description: "", misconceptions: [], min_rating: 800, max_rating: 2400, sort_order: 0 },
  ],
  mastery_change: {
    changes: [{ concept_id: "arrays_hashing", before_rating: 1200, after_rating: 1180, before_uncertainty: 300, after_uncertainty: 280 }],
    outcome: 0,
    explanation: "Give-up floors the outcome at 0.",
  },
};

/** Mirrors how routes/Problem.tsx wires GiveUpControl: reveal state lives in the parent. */
function Harness() {
  const [result, setResult] = useState<GiveUpResponse | null>(null);
  return (
    <div>
      <GiveUpControl versionId="v1" activeMs={12345} onGaveUp={setResult} />
      {result && (
        <div data-testid="reveal">
          <div data-testid="editorial">{result.editorial_md}</div>
          <div data-testid="concepts">{result.concepts.map((c) => c.name).join(", ")}</div>
        </div>
      )}
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.giveUp).mockResolvedValue(RESPONSE);
});

describe("GiveUpControl", () => {
  it("requires an explicit confirm and only then reveals the editorial and concepts", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <Harness />
      </Providers>,
    );

    expect(screen.queryByTestId("reveal")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /give up & show editorial/i }));
    expect(api.giveUp).not.toHaveBeenCalled(); // confirm dialog, not taken yet

    const dialog = screen.getByRole("dialog", { name: /give up on this problem/i });
    await user.click(screen.getByRole("button", { name: /^give up$/i }));

    expect(api.giveUp).toHaveBeenCalledWith("v1", { workout_item_id: undefined, active_ms: 12345 });
    expect(await screen.findByTestId("reveal")).toBeInTheDocument();
    expect(screen.getByTestId("editorial")).toHaveTextContent("Maintain a hash map");
    expect(screen.getByTestId("concepts")).toHaveTextContent("Arrays & Hashing");
    expect(dialog).not.toBeInTheDocument();
  });
});

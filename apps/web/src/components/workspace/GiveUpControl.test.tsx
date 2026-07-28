import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GiveUpResponse } from "@shared";
import { Providers } from "../../test/testUtils";
import { GiveUpControl } from "./GiveUpControl";

vi.mock("../../lib/api", () => ({
  api: { giveUp: vi.fn() },
}));
import { api } from "../../lib/api";

const RESPONSE: GiveUpResponse = {
  reference_solution: "def pairSumIndices(nums, target):\n    ...\n",
  rating_update: {
    type_slug: "arrays_hashing",
    rating_before: 1200,
    rating_after: 1180,
    delta: -20,
    problem_rating: 1150,
    expected_score: 0.6,
    performance_score: 0,
    k_factor: 40,
    metrics: { runs: 2, submissions: 0, hints_revealed: 1, minutes: 5, gave_up: true },
  },
};

/** Mirrors how routes/Problem.tsx wires GiveUpControl: reveal state lives in the parent. */
function Harness() {
  const [result, setResult] = useState<GiveUpResponse | null>(null);
  return (
    <div>
      <GiveUpControl problemId="p1" onGaveUp={setResult} />
      {result && (
        <div data-testid="reveal">
          <div data-testid="solution">{result.reference_solution}</div>
          <div data-testid="delta">{result.rating_update.delta}</div>
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
  it("reveals the solution and rating update on the click itself, with no confirm step", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <Harness />
      </Providers>,
    );

    expect(screen.queryByTestId("reveal")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^see solution$/i }));

    expect(api.giveUp).toHaveBeenCalledWith("p1");
    expect(await screen.findByTestId("reveal")).toBeInTheDocument();
    expect(screen.getByTestId("solution")).toHaveTextContent("pairSumIndices");
    expect(screen.getByTestId("delta")).toHaveTextContent("-20");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("surfaces a failed give-up inline, since no dialog is left to hold the error", async () => {
    const user = userEvent.setup();
    vi.mocked(api.giveUp).mockRejectedValue(new Error("Couldn't reach the server."));

    render(
      <Providers>
        <Harness />
      </Providers>,
    );

    await user.click(screen.getByRole("button", { name: /^see solution$/i }));

    expect(await screen.findByText("Couldn't reach the server.")).toBeInTheDocument();
    expect(screen.queryByTestId("reveal")).not.toBeInTheDocument();
  });
});

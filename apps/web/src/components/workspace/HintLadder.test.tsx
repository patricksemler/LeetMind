import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HintLevel } from "@leetmind/shared";
import { Providers } from "../../test/testUtils";
import { HintLadder } from "./HintLadder";

vi.mock("../../lib/api", () => ({
  api: {
    getHints: vi.fn(),
    takeHint: vi.fn(),
  },
}));

import { api } from "../../lib/api";

const HINT_TEXT: Record<HintLevel, string> = {
  l1_orientation: "Think about what you'd need to remember as you scan once.",
  l2_conceptual: "A lookup keyed by value turns a second scan into a single check.",
  l3_structural: "Walk the array once, checking a hash map for the complement.",
  outline: "1. seen = {}\n2. for i, x: ...",
  editorial: "## Approach\n...",
};

function makeStatefulApi() {
  let taken: HintLevel[] = [];
  const LADDER: HintLevel[] = ["l1_orientation", "l2_conceptual", "l3_structural", "outline"];

  vi.mocked(api.getHints).mockImplementation(async () => ({
    taken: [...taken],
    available: LADDER.filter((l) => !taken.includes(l)),
    penalties: { l1_orientation: 0.9, l2_conceptual: 0.75, l3_structural: 0.6, outline: 0.4, editorial: 0 },
  }));

  vi.mocked(api.takeHint).mockImplementation(async ({ level }) => {
    if (!taken.includes(level)) taken.push(level);
    const idx = LADDER.indexOf(level);
    const next = idx >= 0 && idx + 1 < LADDER.length ? LADDER[idx + 1]! : "editorial";
    const caps = { l1_orientation: 0.9, l2_conceptual: 0.75, l3_structural: 0.6, outline: 0.4, editorial: 0 };
    return { level, text: HINT_TEXT[level], penalty_cap: caps[level], next_level_penalty: caps[next as HintLevel] };
  });

  return { reset: () => (taken = []) };
}

beforeEach(() => {
  vi.clearAllMocks();
  makeStatefulApi();
});

describe("HintLadder", () => {
  it("shows the penalty cap before a hint is taken, and does not take it without explicit confirm", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <HintLadder versionId="v1" />
      </Providers>,
    );

    const revealButton = await screen.findByRole("button", { name: /reveal this hint/i });
    expect(screen.getByText(/caps score at 90%/i)).toBeInTheDocument();
    expect(api.takeHint).not.toHaveBeenCalled();

    await user.click(revealButton);
    const dialog = screen.getByRole("dialog", { name: /take this hint/i });
    expect(within(dialog).getByText(/90%/)).toBeInTheDocument();
    expect(api.takeHint).not.toHaveBeenCalled(); // still not taken — confirm hasn't happened yet

    await user.click(within(dialog).getByRole("button", { name: /^take hint$/i }));

    expect(api.takeHint).toHaveBeenCalledWith({ problem_version_id: "v1", level: "l1_orientation" });
    expect(await screen.findByText(HINT_TEXT.l1_orientation)).toBeInTheDocument();
  });

  it("taking L2 leaves L1 visibly taken and marks both as taken", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <HintLadder versionId="v1" />
      </Providers>,
    );

    await user.click(await screen.findByRole("button", { name: /reveal this hint/i }));
    const dialog1 = screen.getByRole("dialog", { name: /take this hint/i });
    await user.click(within(dialog1).getByRole("button", { name: /^take hint$/i }));
    await screen.findByText(HINT_TEXT.l1_orientation);

    // L2 is now the available rung
    const l2Reveal = await screen.findByRole("button", { name: /reveal this hint/i });
    await user.click(l2Reveal);
    const dialog2 = screen.getByRole("dialog", { name: /take this hint/i });
    expect(within(dialog2).getByText(/75%/)).toBeInTheDocument();
    await user.click(within(dialog2).getByRole("button", { name: /^take hint$/i }));

    expect(await screen.findByText(HINT_TEXT.l2_conceptual)).toBeInTheDocument();
    // L1's text is still visible — taken hints stay visible
    expect(screen.getByText(HINT_TEXT.l1_orientation)).toBeInTheDocument();
    expect(api.takeHint).toHaveBeenCalledTimes(2);
  });

  it("shows a pending label on the reveal button while the take is in flight, not just a disabled 'Reveal this hint'", async () => {
    const user = userEvent.setup();
    // One-time override (not the stateful mock from makeStatefulApi) so this take never resolves
    // until the test says so — enough to observe the pending label without needing the mocked
    // server's own `taken` bookkeeping to advance.
    let resolveTake!: (v: Awaited<ReturnType<typeof api.takeHint>>) => void;
    vi.mocked(api.takeHint).mockReturnValueOnce(new Promise((resolve) => (resolveTake = resolve)));

    render(
      <Providers>
        <HintLadder versionId="v1" />
      </Providers>,
    );

    await user.click(await screen.findByRole("button", { name: /reveal this hint/i }));
    const dialog = screen.getByRole("dialog", { name: /take this hint/i });
    await user.click(within(dialog).getByRole("button", { name: /^take hint$/i }));

    const pendingButton = await screen.findByRole("button", { name: /revealing…/i });
    expect(pendingButton).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^reveal this hint$/i })).not.toBeInTheDocument();

    resolveTake({ level: "l1_orientation", text: HINT_TEXT.l1_orientation, penalty_cap: 0.9, next_level_penalty: 0.75 });
    await waitFor(() => expect(screen.queryByRole("button", { name: /revealing…/i })).not.toBeInTheDocument());
  });
});

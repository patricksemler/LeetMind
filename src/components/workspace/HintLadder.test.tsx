import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HintLevel } from "@shared";
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
  // Editorials no longer open with an "## Approach" heading — they lead with the explanation
  // itself (see the generation prompt’s hint-ladder section).
  editorial: "A lookup keyed by value turns the second scan into a single check.\n...",
};

function makeStatefulApi(initialTaken: HintLevel[] = []) {
  let taken: HintLevel[] = [...initialTaken];
  const LADDER: HintLevel[] = ["l1_orientation", "l2_conceptual", "l3_structural", "outline"];

  vi.mocked(api.getHints).mockImplementation(async () => ({
    taken: [...taken],
    available: LADDER.filter((l) => !taken.includes(l)),
    penalties: {
      l1_orientation: 0.9,
      l2_conceptual: 0.75,
      l3_structural: 0.6,
      outline: 0.4,
      editorial: 0,
    },
    // The server hands back the text of rungs already paid for, so the ladder redraws from one read.
    texts: Object.fromEntries(taken.map((l) => [l, HINT_TEXT[l]])),
    editorial_md: null,
    solutions: null,
    transcribed: false,
  }));

  vi.mocked(api.takeHint).mockImplementation(async ({ level }) => {
    if (!taken.includes(level)) taken.push(level);
    const idx = LADDER.indexOf(level);
    const next = idx >= 0 && idx + 1 < LADDER.length ? LADDER[idx + 1]! : "editorial";
    const caps = {
      l1_orientation: 0.9,
      l2_conceptual: 0.75,
      l3_structural: 0.6,
      outline: 0.4,
      editorial: 0,
    };
    return {
      level,
      text: HINT_TEXT[level],
      penalty_cap: caps[level],
      next_level_penalty: caps[next as HintLevel],
    };
  });

  return { reset: () => (taken = []) };
}

beforeEach(() => {
  vi.clearAllMocks();
  makeStatefulApi();
});

describe("HintLadder", () => {
  it("numbers the rungs and never surfaces the scoring penalty the server applies", async () => {
    render(
      <Providers>
        <HintLadder versionId="v1" />
      </Providers>,
    );

    expect(await screen.findByText("Hint #1")).toBeInTheDocument();
    expect(screen.getByText("Hint #4")).toBeInTheDocument();
    expect(screen.queryByText(/L1 —|Orientation|Outline/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/caps score/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/90%/)).not.toBeInTheDocument();
  });

  it("renders hints taken in an earlier session straight from the read, taking nothing again", async () => {
    makeStatefulApi(["l1_orientation", "l2_conceptual"]);
    render(
      <Providers>
        <HintLadder versionId="v1" />
      </Providers>,
    );

    expect(await screen.findByText(HINT_TEXT.l1_orientation)).toBeInTheDocument();
    expect(screen.getByText(HINT_TEXT.l2_conceptual)).toBeInTheDocument();
    // No "Loading…" pass, and above all no re-POST per rung: revisiting a problem is a read.
    expect(screen.queryByText(/loading…/i)).not.toBeInTheDocument();
    expect(api.takeHint).not.toHaveBeenCalled();
  });

  it("recovers the text when the server reports a rung as taken but sends none", async () => {
    // What an API older than the `texts` field returns. Without a fallback the rung is stuck on
    // "Loading…" with nothing on the way to replace it.
    vi.mocked(api.getHints).mockResolvedValue({
      taken: ["l1_orientation", "l2_conceptual"],
      available: ["l3_structural"],
      penalties: {
        l1_orientation: 0.9,
        l2_conceptual: 0.75,
        l3_structural: 0.6,
        outline: 0.4,
        editorial: 0,
      },
      texts: {},
      editorial_md: null,
      solutions: null,
      transcribed: false,
    });

    render(
      <Providers>
        <HintLadder versionId="v1" />
      </Providers>,
    );

    expect(await screen.findByText(HINT_TEXT.l1_orientation)).toBeInTheDocument();
    expect(screen.getByText(HINT_TEXT.l2_conceptual)).toBeInTheDocument();
    expect(screen.queryByText(/loading…/i)).not.toBeInTheDocument();
  });

  it("never draws one problem's revealed hint against another problem's ladder", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <Providers>
        <HintLadder versionId="v1" />
      </Providers>,
    );

    await user.click(await screen.findByRole("button", { name: /^reveal$/i }));
    expect(await screen.findByText(HINT_TEXT.l1_orientation)).toBeInTheDocument();

    // Moving to the next problem re-renders this same component rather than remounting it, so the
    // text revealed a moment ago is still in state — it must not be shown against the new ladder.
    makeStatefulApi();
    rerender(
      <Providers>
        <HintLadder versionId="v2" />
      </Providers>,
    );

    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /^reveal$/i })).toHaveLength(1),
    );
    expect(screen.queryByText(HINT_TEXT.l1_orientation)).not.toBeInTheDocument();
  });

  it("offers no Reveal until the server has said which rungs are taken", async () => {
    // A ladder that assumes "nothing taken" while the fetch is in flight shows a live Reveal on a
    // rung the user already paid for, then swaps it for hint text — the flicker, held still here.
    vi.mocked(api.getHints).mockReturnValue(new Promise(() => {}));
    render(
      <Providers>
        <HintLadder versionId="v1" />
      </Providers>,
    );

    expect(await screen.findByText("Hint #1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^reveal$/i })).not.toBeInTheDocument();
  });

  it("takes the hint on the click itself — no confirm step in between", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <HintLadder versionId="v1" />
      </Providers>,
    );

    const revealButton = await screen.findByRole("button", { name: /^reveal$/i });
    expect(api.takeHint).not.toHaveBeenCalled();

    await user.click(revealButton);

    expect(api.takeHint).toHaveBeenCalledWith({
      problem_version_id: "v1",
      level: "l1_orientation",
    });
    expect(await screen.findByText(HINT_TEXT.l1_orientation)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("taking L2 leaves L1 visibly taken and marks both as taken", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <HintLadder versionId="v1" />
      </Providers>,
    );

    await user.click(await screen.findByRole("button", { name: /^reveal$/i }));
    await screen.findByText(HINT_TEXT.l1_orientation);

    // L2 is now the available rung — the only Reveal left belongs to it.
    await user.click(await screen.findByRole("button", { name: /^reveal$/i }));

    expect(api.takeHint).toHaveBeenLastCalledWith({
      problem_version_id: "v1",
      level: "l2_conceptual",
    });
    expect(await screen.findByText(HINT_TEXT.l2_conceptual)).toBeInTheDocument();
    // L1's text is still visible — taken hints stay visible
    expect(screen.getByText(HINT_TEXT.l1_orientation)).toBeInTheDocument();
    expect(api.takeHint).toHaveBeenCalledTimes(2);
  });

  it("shows the revealed hint without waiting on the hints refetch", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <HintLadder versionId="v1" />
      </Providers>,
    );

    const reveal = await screen.findByRole("button", { name: /^reveal$/i });
    // From here the refetch that `onSuccess` kicks off never lands, so anything keyed on the
    // server's `taken` stays stale for the rest of the test — the flicker, held still. The rung
    // used to drop back to an un-taken "Reveal" for exactly this window.
    vi.mocked(api.getHints).mockReturnValue(new Promise(() => {}));
    await user.click(reveal);

    expect(await screen.findByText(HINT_TEXT.l1_orientation)).toBeInTheDocument();
    // …and the ladder has moved on: the only "Reveal" left sits in rung 2's row, not the one just
    // taken.
    const rung2 = screen.getByText("Hint #2").closest("div")!;
    expect(within(rung2).getByRole("button", { name: /^reveal$/i })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^reveal$/i })).toHaveLength(1);
  });

  it("shows a pending label on the reveal button while the take is in flight, not just a disabled 'Reveal'", async () => {
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

    await user.click(await screen.findByRole("button", { name: /^reveal$/i }));

    const pendingButton = await screen.findByRole("button", { name: /revealing…/i });
    expect(pendingButton).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^reveal$/i })).not.toBeInTheDocument();

    resolveTake({
      level: "l1_orientation",
      text: HINT_TEXT.l1_orientation,
      penalty_cap: 0.9,
      next_level_penalty: 0.75,
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /revealing…/i })).not.toBeInTheDocument(),
    );
  });
});

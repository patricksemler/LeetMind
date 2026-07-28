import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "../../test/testUtils";
import { HintLadder } from "./HintLadder";

vi.mock("../../lib/api", () => ({
  api: { revealHint: vi.fn() },
}));

import { api } from "../../lib/api";

const HINT_TEXT = [
  "Think about what you'd need to remember as you scan once.",
  "A lookup keyed by value turns a second scan into a single check.",
  "Walk the array once, checking a hash map for the complement.",
  "1. seen = {}\n2. for i, x: ...",
];

/** Mirrors how routes/Problem.tsx wires HintLadder: revealed-hint state lives in the parent. */
function Harness({ initial = [] as string[] }: { initial?: string[] }) {
  const [revealedHints, setRevealedHints] = useState<string[]>(initial);
  return (
    <HintLadder
      problemId="p1"
      revealedHints={revealedHints}
      onRevealed={(rung, text) =>
        setRevealedHints((prev) => {
          const next = [...prev];
          next[rung - 1] = text;
          return next;
        })
      }
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.revealHint).mockImplementation(async (_id, rung) => ({
    rung,
    text: HINT_TEXT[rung - 1]!,
  }));
});

describe("HintLadder", () => {
  it("numbers the rungs", () => {
    render(
      <Providers>
        <Harness />
      </Providers>,
    );

    expect(screen.getByText("Hint #1")).toBeInTheDocument();
    expect(screen.getByText("Hint #4")).toBeInTheDocument();
  });

  it("renders hints already revealed, with no further reveal call", () => {
    render(
      <Providers>
        <Harness initial={[HINT_TEXT[0]!, HINT_TEXT[1]!]} />
      </Providers>,
    );

    expect(screen.getByText(HINT_TEXT[0]!)).toBeInTheDocument();
    expect(screen.getByText(HINT_TEXT[1]!)).toBeInTheDocument();
    expect(api.revealHint).not.toHaveBeenCalled();
    // Only rung 3 is next — rung 4 stays locked with no button of its own.
    expect(screen.getAllByRole("button", { name: /^reveal$/i })).toHaveLength(1);
  });

  it("offers only one Reveal at a time, on the next unrevealed rung", () => {
    render(
      <Providers>
        <Harness />
      </Providers>,
    );
    expect(screen.getAllByRole("button", { name: /^reveal$/i })).toHaveLength(1);
    const rung1 = screen.getByText("Hint #1").closest("div")!;
    expect(within(rung1).getByRole("button", { name: /^reveal$/i })).toBeInTheDocument();
  });

  it("takes the hint on the click itself — no confirm step in between", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <Harness />
      </Providers>,
    );

    const revealButton = screen.getByRole("button", { name: /^reveal$/i });
    await user.click(revealButton);

    expect(api.revealHint).toHaveBeenCalledWith("p1", 1);
    expect(await screen.findByText(HINT_TEXT[0]!)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("taking rung 2 leaves rung 1 visibly revealed", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <Harness />
      </Providers>,
    );

    await user.click(screen.getByRole("button", { name: /^reveal$/i }));
    await screen.findByText(HINT_TEXT[0]!);

    await user.click(screen.getByRole("button", { name: /^reveal$/i }));

    expect(api.revealHint).toHaveBeenLastCalledWith("p1", 2);
    expect(await screen.findByText(HINT_TEXT[1]!)).toBeInTheDocument();
    expect(screen.getByText(HINT_TEXT[0]!)).toBeInTheDocument();
  });

  it("replaces Reveal with a spinner while the take is in flight", async () => {
    const user = userEvent.setup();
    let resolveTake!: (v: Awaited<ReturnType<typeof api.revealHint>>) => void;
    vi.mocked(api.revealHint).mockReturnValueOnce(new Promise((resolve) => (resolveTake = resolve)));

    render(
      <Providers>
        <Harness />
      </Providers>,
    );

    await user.click(screen.getByRole("button", { name: /^reveal$/i }));

    const pendingStatus = await screen.findByRole("status", { name: /revealing…/i });
    expect(screen.queryByRole("button", { name: /^reveal$/i })).not.toBeInTheDocument();
    expect(pendingStatus).toHaveClass("justify-self-end");
    expect(pendingStatus.querySelector("svg")).toBeInTheDocument();

    resolveTake({ rung: 1, text: HINT_TEXT[0]! });
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: /revealing…/i })).not.toBeInTheDocument(),
    );
  });

  it("slides revealed text in once, then leaves it alone", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <Harness />
      </Providers>,
    );

    await user.click(screen.getByRole("button", { name: /^reveal$/i }));
    const text = await screen.findByText(HINT_TEXT[0]!);
    const entering = text.closest(".content-enter")!;
    expect(entering).toBeInTheDocument();

    fireEvent.animationEnd(entering);
    expect(entering).not.toHaveClass("content-enter");

    // Taking the next rung re-renders the whole ladder; rung 1 is settled content by then and must
    // not animate again — nor must showing the panel after it was hidden.
    await user.click(screen.getByRole("button", { name: /^reveal$/i }));
    await screen.findByText(HINT_TEXT[1]!);
    expect(entering).not.toHaveClass("content-enter");
  });

  it("disables further reveals when told to", () => {
    render(
      <Providers>
        <HintLadder problemId="p1" revealedHints={[]} disabled onRevealed={() => {}} />
      </Providers>,
    );
    expect(screen.queryByRole("button", { name: /^reveal$/i })).not.toBeInTheDocument();
  });
});

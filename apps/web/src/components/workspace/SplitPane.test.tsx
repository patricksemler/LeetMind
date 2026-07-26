import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { SplitPane } from "./SplitPane";

function renderSplit(storageKey?: string) {
  return render(<SplitPane storageKey={storageKey} left={<p>statement</p>} right={<p>editor</p>} />);
}

/** The container has no layout in jsdom, so a pointer drag can't be simulated meaningfully —
 * `getBoundingClientRect` is all zeroes and every position maps to the same clamped percentage.
 * The keyboard path exercises the identical clamp-and-persist code, so it's what's asserted here. */
beforeEach(() => {
  window.localStorage.clear();
});

describe("SplitPane", () => {
  it("remembers the width across mounts instead of snapping back to the default", async () => {
    const user = userEvent.setup();
    const { unmount } = renderSplit("test-split");

    const separator = screen.getByRole("separator");
    expect(separator).toHaveAttribute("aria-valuenow", "42");

    separator.focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(separator).toHaveAttribute("aria-valuenow", "46");

    unmount();
    renderSplit("test-split");
    // Restored on the first render, not after one — a width applied from an effect shows the
    // default first and visibly jumps.
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "46");
  });

  it("keeps the stored width inside the allowed range", async () => {
    const user = userEvent.setup();
    renderSplit("test-split");

    const separator = screen.getByRole("separator");
    separator.focus();
    await user.keyboard("{End}");
    expect(separator).toHaveAttribute("aria-valuenow", "65");
    await user.keyboard("{ArrowRight}");
    expect(separator).toHaveAttribute("aria-valuenow", "65");

    await user.keyboard("{Home}");
    expect(separator).toHaveAttribute("aria-valuenow", "25");
    await user.keyboard("{ArrowLeft}");
    expect(separator).toHaveAttribute("aria-valuenow", "25");
  });

  it("advances once per key repeat, even when several arrive before a re-render", () => {
    renderSplit("test-split");
    const separator = screen.getByRole("separator");

    // A held arrow key delivers repeats faster than React re-renders. Handlers reading the rendered
    // width all see the same stale value, so holding the key moved the divider exactly one step.
    act(() => {
      fireEvent.keyDown(separator, { key: "ArrowRight" });
      fireEvent.keyDown(separator, { key: "ArrowRight" });
      fireEvent.keyDown(separator, { key: "ArrowRight" });
    });

    expect(separator).toHaveAttribute("aria-valuenow", "48");
  });

  it("ignores a stored width that is out of range or unparseable", () => {
    window.localStorage.setItem("leetmind:pref:test-split", "999");
    renderSplit("test-split");
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "42");
  });

  it("without a storage key, nothing is persisted", async () => {
    const user = userEvent.setup();
    const { unmount } = renderSplit();

    screen.getByRole("separator").focus();
    await user.keyboard("{ArrowRight}");
    expect(window.localStorage.length).toBe(0);

    unmount();
    renderSplit();
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "42");
  });
});

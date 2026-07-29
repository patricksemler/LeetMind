import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SplitPane } from "./SplitPane";

function renderSplit(storageKey?: string) {
  return render(
    <SplitPane storageKey={storageKey} first={<p>statement</p>} second={<p>editor</p>} />,
  );
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

  it("tracks a pointer-captured drag and persists once on release", () => {
    renderSplit("test-split");
    const separator = screen.getByRole("separator");
    vi.spyOn(separator.parentElement!, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 200,
      bottom: 100,
      width: 200,
      height: 100,
      toJSON: () => ({}),
    });

    fireEvent(separator, new MouseEvent("pointerdown", { bubbles: true, clientX: 84 }));
    fireEvent(separator, new MouseEvent("pointermove", { bubbles: true, clientX: 120 }));
    expect(separator).toHaveAttribute("aria-valuenow", "60");
    expect(document.body.style.userSelect).toBe("none");

    fireEvent(separator, new MouseEvent("pointerup", { bubbles: true, clientX: 120 }));
    expect(document.body.style.userSelect).toBe("");
    expect(window.localStorage.getItem("leetmind:pref:test-split")).toBe("60");
  });

  it("ignores a stored width that is out of range or unparseable", () => {
    window.localStorage.setItem("leetmind:pref:test-split", "999");
    renderSplit("test-split");
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "42");
  });

  it("a vertical split steps on the up/down arrows and reports itself as a horizontal separator", async () => {
    const user = userEvent.setup();
    render(
      <SplitPane
        orientation="vertical"
        first={<p>editor</p>}
        second={<p>cases</p>}
        initialFirstPct={62}
      />,
    );

    const separator = screen.getByRole("separator");
    expect(separator).toHaveAttribute("aria-orientation", "horizontal");
    expect(separator).toHaveAttribute("aria-valuenow", "62");

    separator.focus();
    await user.keyboard("{ArrowDown}");
    expect(separator).toHaveAttribute("aria-valuenow", "64");
    // Left/right belong to the other axis and must not move this one.
    await user.keyboard("{ArrowRight}");
    expect(separator).toHaveAttribute("aria-valuenow", "64");
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

import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Dialog } from "./Dialog";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>Open dialog</button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Test dialog"
        footer={<button>Confirm</button>}
      >
        <button>Middle</button>
      </Dialog>
    </div>
  );
}

describe("Dialog", () => {
  it("traps Tab focus inside the dialog instead of letting it escape to the page", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Tabbing forward from the last focusable element (Confirm) must wrap to the first (Close),
    // not escape to the "Open dialog" trigger button behind the overlay.
    const closeButton = screen.getByRole("button", { name: "Close" });
    const middleButton = screen.getByRole("button", { name: "Middle" });
    const confirmButton = screen.getByRole("button", { name: "Confirm" });

    closeButton.focus();
    await user.tab();
    expect(document.activeElement).toBe(middleButton);
    await user.tab();
    expect(document.activeElement).toBe(confirmButton);
    await user.tab();
    expect(document.activeElement).toBe(closeButton);

    // Shift+Tab backward from the first focusable element wraps to the last.
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(confirmButton);
  });

  it("returns focus to the trigger element after closing via Escape", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = screen.getByRole("button", { name: "Open dialog" });
    trigger.focus();
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });
});

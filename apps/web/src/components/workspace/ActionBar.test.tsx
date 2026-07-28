import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionBar } from "./ActionBar";

describe("ActionBar", () => {
  it("cross-fades the controls to one status spinner while an action is running", () => {
    const props = {
      onRun: vi.fn(),
      onSubmit: vi.fn(),
      submitting: false,
    };
    const { rerender } = render(<ActionBar {...props} running={false} />);

    expect(screen.getByRole("button", { name: "Run" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Submit" })).toBeVisible();

    rerender(<ActionBar {...props} running />);

    expect(screen.queryByRole("button", { name: "Run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit" })).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Running…" })).toBeVisible();
    expect(screen.getByTestId("action-spinner").querySelector("svg")).toBeInTheDocument();
  });
});

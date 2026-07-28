import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Providers } from "../test/testUtils";
import { DemoExperience } from "./DemoExperience";
import { createDemoExecutor } from "./demoScenario";

vi.mock("../components/workspace/EditorPane", () => ({
  EditorPane: ({ value, readOnly }: { value: string; readOnly?: boolean }) => (
    <textarea aria-label="Code editor" value={value} readOnly={readOnly} onChange={() => {}} />
  ),
}));

describe("DemoExperience", () => {
  it("walks through run, submit, rating feedback, and replay without a backend", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <DemoExperience executor={createDemoExecutor({ delayMs: 0 })} />
      </Providers>,
    );

    expect(screen.getByText(/Start with one problem/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    expect(screen.getByLabelText("Code editor")).toHaveAttribute("readonly");

    await user.click(screen.getByRole("button", { name: "Start demo" }));
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText(/The examples pass/i)).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: "passed" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("accepted")).toBeInTheDocument();
    expect(screen.getByTestId("rating-update-panel")).toHaveTextContent("1035");
    expect(screen.getByTestId("rating-update-panel")).toHaveTextContent("1048");

    await user.click(screen.getByRole("button", { name: "Replay" }));
    expect(screen.getByText(/Start with one problem/i)).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Result" }));
    expect(screen.getByText(/No submissions yet/i)).toBeInTheDocument();
  });
});

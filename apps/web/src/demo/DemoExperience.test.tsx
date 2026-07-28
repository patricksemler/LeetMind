import { fireEvent, render, screen } from "@testing-library/react";
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
  it("guides the full practice loop and concludes with the repository link", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <DemoExperience executor={createDemoExecutor({ delayMs: 0 })} conclusionDelayMs={0} />
      </Providers>,
    );

    expect(screen.getByRole("heading", { name: /Welcome to LeetMind/i })).toBeInTheDocument();
    expect(screen.getByText("Guided preview")).toBeInTheDocument();
    expect(screen.queryByText(/about one minute/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/preloaded, read-only solution/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/interactive demo/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/static product tour/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Begin demo" }));
    expect(screen.getByRole("heading", { name: /A problem is ready/i })).toBeInTheDocument();
    expect(screen.getByText(/Open your next challenge/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText(/Explore, then reveal a hint/i)).toBeInTheDocument();
    expect(screen.getByRole("tabpanel", { name: "Problem" })).not.toHaveClass("content-enter");
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    expect(screen.getByLabelText("Code editor")).toHaveAttribute("readonly");
    expect((screen.getByLabelText("Code editor") as HTMLTextAreaElement).value).toMatch(
      /^# This solution is preloaded and read-only in the demo\./,
    );

    const hintCoach = screen.getByText(/Explore, then reveal a hint/i).closest('[role="status"]')!;
    expect(hintCoach).toBeVisible();
    expect(hintCoach).toHaveClass("coach-mark-enter");
    fireEvent.animationEnd(hintCoach);
    expect(hintCoach).not.toHaveClass("coach-mark-enter");

    await user.click(screen.getByRole("tab", { name: "Result" }));
    expect(hintCoach).not.toBeVisible();
    expect(screen.getByRole("tabpanel", { name: "Result" })).not.toHaveClass("content-enter");
    await user.click(screen.getByRole("tab", { name: "Problem" }));
    expect(screen.getByText(/Explore, then reveal a hint/i).closest('[role="status"]')).toBe(
      hintCoach,
    );
    // Showing the panel again must not re-arm the entrance — the card is already in place.
    expect(hintCoach).not.toHaveClass("coach-mark-enter");

    await user.click(screen.getByRole("button", { name: "Reveal" }));
    expect(await screen.findByText(/As you scan the list/i)).toBeInTheDocument();
    expect(screen.getByText(/Check the public examples/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText(/Both examples pass/i)).toBeInTheDocument();
    const submitCoach = screen
      .getByText(/Submit against the hidden suite/i)
      .closest('[role="status"]') as HTMLElement;
    expect(submitCoach).toHaveClass("coach-mark-enter");
    expect(submitCoach.style.getPropertyValue("--coach-mark-delay")).toBe("150ms");
    expect(screen.getAllByRole("img", { name: "passed" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("accepted")).toBeInTheDocument();
    expect(screen.getByTestId("rating-update-panel")).toHaveTextContent("1035");
    expect(screen.getByTestId("rating-update-panel")).toHaveTextContent("1048");
    expect(
      await screen.findByRole("dialog", { name: /That’s the LeetMind loop/i }),
    ).toBeInTheDocument();

    const repositoryLink = screen.getByRole("link", { name: /View repository/i });
    expect(repositoryLink).toHaveAttribute("href", "https://github.com/patricksemler/LeetMind");
    expect(repositoryLink).toHaveAttribute("target", "_blank");
    await user.click(screen.getByRole("button", { name: "Replay" }));
    expect(screen.getByRole("heading", { name: /Welcome to LeetMind/i })).toBeInTheDocument();
  });
});

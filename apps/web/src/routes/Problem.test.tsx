import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { ProblemDetail } from "@shared";
import { Providers } from "../test/testUtils";
import { draftKey } from "../lib/draft";
import { Problem } from "./Problem";

vi.mock("../lib/api", () => ({
  api: {
    openProblem: vi.fn(),
    run: vi.fn(),
    submit: vi.fn(),
  },
}));

vi.mock("../components/workspace/ProblemWorkspace", () => ({
  ProblemWorkspace: ({
    problem,
    source,
    onSourceChange,
  }: {
    problem: ProblemDetail;
    source: string;
    onSourceChange: (source: string) => void;
  }) => (
    <main>
      <h1>{problem.title}</h1>
      <textarea
        aria-label="Source"
        value={source}
        onChange={(event) => onSourceChange(event.target.value)}
      />
    </main>
  ),
}));

import { api } from "../lib/api";

function problem(id: string): ProblemDetail {
  return {
    id,
    status: "active",
    primary_type: "arrays_hashing",
    support_types: [],
    shape: "count_structures",
    problem_rating: 1000,
    is_probe: true,
    title: `Problem ${id}`,
    statement_md: "Return a value.",
    constraints: [],
    signature: {
      func_name: "solve",
      params: [],
      returns: { kind: "int", nullable: false, list_depth: 0 },
      order_insensitive: false,
    },
    starter_code: `starter ${id}`,
    public_tests: [],
    complexity: { time: "O(1)", space: "O(1)" },
    par_minutes: 5,
    created_at: "2026-01-01T00:00:00Z",
    served_at: "2026-01-01T00:00:00Z",
    revealed_hints: [],
  };
}

function Navigation() {
  const navigate = useNavigate();
  return (
    <nav>
      <button onClick={() => navigate("/problem/p1")}>Problem one</button>
      <button onClick={() => navigate("/problem/p2")}>Problem two</button>
    </nav>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.mocked(api.openProblem).mockImplementation(async (id) => problem(id));
});

it("initializes and restores source independently for each problem", async () => {
  const user = userEvent.setup();
  window.localStorage.setItem(draftKey("p1"), "saved p1");

  render(
    <Providers>
      <MemoryRouter initialEntries={["/problem/p1"]}>
        <Navigation />
        <Routes>
          <Route path="/problem/:problemId" element={<Problem />} />
        </Routes>
      </MemoryRouter>
    </Providers>,
  );

  expect(await screen.findByRole("heading", { name: "Problem p1" })).toBeInTheDocument();
  const source = screen.getByRole("textbox", { name: "Source" });
  expect(source).toHaveValue("saved p1");
  await user.clear(source);
  await user.type(source, "edited p1");

  await user.click(screen.getByRole("button", { name: "Problem two" }));
  expect(await screen.findByRole("heading", { name: "Problem p2" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Source" })).toHaveValue("starter p2");

  await user.click(screen.getByRole("button", { name: "Problem one" }));
  expect(await screen.findByRole("heading", { name: "Problem p1" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Source" })).toHaveValue("edited p1");
});

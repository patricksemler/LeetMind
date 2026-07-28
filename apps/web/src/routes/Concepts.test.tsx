import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MeResponse, TypeProfileView } from "@shared";
import { Providers } from "../test/testUtils";
import { Concepts } from "./Concepts";

vi.mock("../lib/api", () => ({
  api: { me: vi.fn() },
}));

import { api } from "../lib/api";

function mkType(overrides: Partial<TypeProfileView> = {}): TypeProfileView {
  return {
    slug: "arrays_hashing",
    name: "Arrays & Hashing",
    rating: 1200,
    attempts: 0,
    evidenced: false,
    ...overrides,
  };
}

function mkResponse(types: TypeProfileView[]): MeResponse {
  return { types };
}

describe("Concepts", () => {
  it("shows an evidenced type's rating badge", async () => {
    vi.mocked(api.me).mockResolvedValue(
      mkResponse([mkType({ rating: 1450, attempts: 9, evidenced: true })]),
    );

    render(
      <Providers>
        <Concepts />
      </Providers>,
    );

    expect(await screen.findByText("Arrays & Hashing")).toBeInTheDocument();
    expect(await screen.findByText("1450")).toBeInTheDocument();
  });

  it("renders an unevidenced type with no rating badge, rather than inventing a 1200", async () => {
    vi.mocked(api.me).mockResolvedValue(
      mkResponse([mkType({ slug: "two_pointers", name: "Two Pointers", evidenced: false })]),
    );

    render(
      <Providers>
        <Concepts />
      </Providers>,
    );

    expect(await screen.findByText("Two Pointers")).toBeInTheDocument();
    // The seeded default is 1200, and showing it would assert an estimate nothing measured. An
    // unevidenced type carries no badge at all.
    expect(screen.queryByText("1200")).not.toBeInTheDocument();
  });

  it("lists every type flat, in the order the server sends them", async () => {
    vi.mocked(api.me).mockResolvedValue(
      mkResponse([
        mkType({ slug: "arrays_hashing", name: "Arrays & Hashing" }),
        mkType({ slug: "two_pointers", name: "Two Pointers" }),
      ]),
    );

    render(
      <Providers>
        <Concepts />
      </Providers>,
    );

    expect(await screen.findByText("Arrays & Hashing")).toBeInTheDocument();
    expect(screen.getByText("Two Pointers")).toBeInTheDocument();
  });
});

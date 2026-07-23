import { describe, expect, it } from "vitest";
import { isValidParamType, paramTypeToString, parseParamType } from "./signature.js";

describe("parseParamType", () => {
  it("parses scalars", () => {
    expect(parseParamType("int")).toEqual({ kind: "scalar", name: "int" });
    expect(parseParamType("float")).toEqual({ kind: "scalar", name: "float" });
    expect(parseParamType("bool")).toEqual({ kind: "scalar", name: "bool" });
    expect(parseParamType("str")).toEqual({ kind: "scalar", name: "str" });
  });

  it("parses tree and linked-list types, nullable and non-nullable", () => {
    expect(parseParamType("TreeNode")).toEqual({ kind: "tree", nullable: false });
    expect(parseParamType("TreeNode?")).toEqual({ kind: "tree", nullable: true });
    expect(parseParamType("ListNode")).toEqual({ kind: "linkedlist", nullable: false });
    expect(parseParamType("ListNode?")).toEqual({ kind: "linkedlist", nullable: true });
  });

  it("parses a single-level list", () => {
    expect(parseParamType("list[int]")).toEqual({
      kind: "list",
      of: { kind: "scalar", name: "int" },
    });
  });

  it("parses arbitrarily nested lists", () => {
    expect(parseParamType("list[list[int]]")).toEqual({
      kind: "list",
      of: { kind: "list", of: { kind: "scalar", name: "int" } },
    });

    expect(parseParamType("list[list[list[str]]]")).toEqual({
      kind: "list",
      of: {
        kind: "list",
        of: { kind: "list", of: { kind: "scalar", name: "str" } },
      },
    });
  });

  it("parses a list of nullable tree nodes", () => {
    expect(parseParamType("list[TreeNode?]")).toEqual({
      kind: "list",
      of: { kind: "tree", nullable: true },
    });
  });

  it("round-trips through paramTypeToString", () => {
    for (const t of ["int", "float", "bool", "str", "TreeNode", "TreeNode?", "ListNode", "ListNode?", "list[int]", "list[list[int]]", "list[list[list[bool]]]"]) {
      expect(paramTypeToString(parseParamType(t))).toBe(t);
    }
  });

  it("rejects invalid input", () => {
    const badInputs = [
      "",
      "integer",
      "Int",
      "list",
      "list[]",
      "list[int",
      "list[int]]",
      "listint]",
      "TreeNode??",
      "Tree",
      "Node",
      "list[bogus]",
      "list[list[bogus]]",
      "int ",
      " int",
      "int|float",
    ];
    for (const bad of badInputs) {
      expect(() => parseParamType(bad), `expected "${bad}" to throw`).toThrow();
      expect(isValidParamType(bad), `expected "${bad}" to be invalid`).toBe(false);
    }
  });

  it("isValidParamType rejects non-string input without throwing", () => {
    expect(isValidParamType(undefined)).toBe(false);
    expect(isValidParamType(null)).toBe(false);
    expect(isValidParamType(42)).toBe(false);
    expect(isValidParamType({})).toBe(false);
  });

  it("isValidParamType accepts valid input", () => {
    expect(isValidParamType("list[list[int]]")).toBe(true);
  });
});

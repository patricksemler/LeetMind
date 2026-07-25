import { parseParamType } from "@leetmind/shared";
import { describe, expect, it } from "vitest";
import type { Signature } from "../types.js";
import { cppType, generateMainCpp } from "./codegen.js";

describe("cppType — CONTRACTS §7 type mapping table", () => {
  it.each([
    ["int", "long long"],
    ["float", "double"],
    ["bool", "bool"],
    ["str", "std::string"],
    ["list[int]", "std::vector<long long>"],
    ["list[float]", "std::vector<double>"],
    ["list[bool]", "std::vector<bool>"],
    ["list[str]", "std::vector<std::string>"],
    ["list[list[int]]", "std::vector<std::vector<long long>>"],
    ["list[list[list[int]]]", "std::vector<std::vector<std::vector<long long>>>"],
    ["TreeNode", "TreeNode*"],
    ["TreeNode?", "TreeNode*"],
    ["ListNode", "ListNode*"],
    ["ListNode?", "ListNode*"],
    ["list[TreeNode?]", "std::vector<TreeNode*>"],
  ] as const)("%s -> %s", (paramType, expected) => {
    expect(cppType(parseParamType(paramType))).toBe(expected);
  });
});

describe("generateMainCpp — structural properties (no Docker)", () => {
  const twoSum: Signature = {
    name: "twoSum",
    params: [
      { name: "nums", type: "list[int]" },
      { name: "target", type: "int" },
    ],
    returns: "list[int]",
  };

  it("is deterministic: the same signature always produces byte-identical output", () => {
    expect(generateMainCpp(twoSum)).toBe(generateMainCpp(twoSum));
  });

  it("includes the vendored json.hpp and injects TreeNode/ListNode before including solution.cpp", () => {
    const src = generateMainCpp(twoSum);
    expect(src).toContain('#include "json.hpp"');
    const treeNodeIdx = src.indexOf("struct TreeNode");
    const listNodeIdx = src.indexOf("struct ListNode");
    const includeSolutionIdx = src.indexOf('#include "solution.cpp"');
    expect(treeNodeIdx).toBeGreaterThan(-1);
    expect(listNodeIdx).toBeGreaterThan(-1);
    expect(includeSolutionIdx).toBeGreaterThan(-1);
    expect(treeNodeIdx).toBeLessThan(includeSolutionIdx);
    expect(listNodeIdx).toBeLessThan(includeSolutionIdx);
  });

  it("emits exactly one sentinel emission call site and never emits an 'expected' JSON key", () => {
    const src = generateMainCpp(twoSum);
    expect(src).toContain("<<<LEETMIND_RESULT>>>");
    // The harness never builds an "expected" field into any per-test result object.
    expect(src).not.toMatch(/result\["expected"\]/);
  });

  it("generates a call_solution wrapper that decodes each param via Codec<T> in declared order", () => {
    const src = generateMainCpp(twoSum);
    expect(src).toContain("Codec<std::vector<long long>>::decode(args_json.at(0))");
    expect(src).toContain("Codec<long long>::decode(args_json.at(1))");
    expect(src).toContain("solution_instance.twoSum(arg0, arg1)");
    expect(src).toContain("Codec<std::vector<long long>>::encode(result)");
  });

  it("supports a zero-parameter signature", () => {
    const sig: Signature = { name: "answer", params: [], returns: "int" };
    const src = generateMainCpp(sig);
    expect(src).toContain("solution_instance.answer()");
  });

  it("supports nested list[list[int]] both as a param and as the return type", () => {
    const sig: Signature = {
      name: "groups",
      params: [{ name: "nums", type: "list[list[int]]" }],
      returns: "list[list[int]]",
    };
    const src = generateMainCpp(sig);
    expect(src).toContain("Codec<std::vector<std::vector<long long>>>::decode(args_json.at(0))");
    expect(src).toContain("Codec<std::vector<std::vector<long long>>>::encode(result)");
  });

  it("supports str params and return", () => {
    const sig: Signature = {
      name: "reverseWords",
      params: [{ name: "s", type: "str" }],
      returns: "str",
    };
    const src = generateMainCpp(sig);
    expect(src).toContain("Codec<std::string>::decode(args_json.at(0))");
    expect(src).toContain("Codec<std::string>::encode(result)");
  });

  it("supports TreeNode? params and return", () => {
    const sig: Signature = {
      name: "invertTree",
      params: [{ name: "root", type: "TreeNode?" }],
      returns: "TreeNode?",
    };
    const src = generateMainCpp(sig);
    expect(src).toContain("solution_instance.invertTree(arg0)");
    expect(src).toContain("Codec<TreeNode*>::decode(args_json.at(0))");
    expect(src).toContain("Codec<TreeNode*>::encode(result)");
    expect(src).toContain("struct TreeNode {");
    expect(src).toContain("TreeNode* decode_tree(const json& j)");
    expect(src).toContain("json encode_tree(TreeNode* root)");
  });

  it("supports ListNode? params and return", () => {
    const sig: Signature = {
      name: "reverseList",
      params: [{ name: "head", type: "ListNode?" }],
      returns: "ListNode?",
    };
    const src = generateMainCpp(sig);
    expect(src).toContain("Codec<ListNode*>::decode(args_json.at(0))");
    expect(src).toContain("Codec<ListNode*>::encode(result)");
    expect(src).toContain("struct ListNode {");
    expect(src).toContain("ListNode* decode_list(const json& j)");
    expect(src).toContain("json encode_list(ListNode* head)");
  });

  it("supports bool and float params/return", () => {
    const sig: Signature = {
      name: "approx",
      params: [
        { name: "x", type: "float" },
        { name: "strict", type: "bool" },
      ],
      returns: "bool",
    };
    const src = generateMainCpp(sig);
    expect(src).toContain("Codec<double>::decode(args_json.at(0))");
    expect(src).toContain("Codec<bool>::decode(args_json.at(1))");
    expect(src).toContain("Codec<bool>::encode(result)");
  });

  it("snapshot: full generated main.cpp for a representative multi-type signature", () => {
    const sig: Signature = {
      name: "solve",
      params: [
        { name: "nums", type: "list[list[int]]" },
        { name: "target", type: "float" },
        { name: "label", type: "str" },
        { name: "root", type: "TreeNode?" },
        { name: "head", type: "ListNode?" },
      ],
      returns: "bool",
    };
    expect(generateMainCpp(sig)).toMatchSnapshot();
  });
});

describe("generateMainCpp — rejects a signature.name that isn't a valid identifier", () => {
  // `signature` comes from LLM-generated content (untrusted per this system's own threat model)
  // and `signature.name` is spliced directly into COMPILED, EXECUTED C++ as
  // `solution_instance.${signature.name}(...)` — QA-PLAN.md §3's C++ parity item: this must fail
  // loudly rather than let whatever string was supplied land in a compiled translation unit.
  it.each([
    "twoSum(); system(\"rm -rf /\"); //",
    "twoSum() { return {}; } int backdoor",
    "twoSum\n#include <cstdlib>",
    "",
    "1twoSum",
    "two-sum",
    "two sum",
  ])("rejects %j", (badName) => {
    expect(() => generateMainCpp({ name: badName, params: [{ name: "a", type: "int" }], returns: "int" })).toThrow(
      /valid identifier/,
    );
  });

  it("still accepts an ordinary identifier", () => {
    expect(() =>
      generateMainCpp({ name: "twoSum", params: [{ name: "a", type: "int" }], returns: "int" }),
    ).not.toThrow();
  });
});

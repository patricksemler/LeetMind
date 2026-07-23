import { describe, expect, it } from "vitest";
import {
  decodeList,
  decodeTree,
  encodeList,
  encodeTree,
  type ListNodeLike,
  type TreeNodeLike,
} from "./treecodec.js";

describe("tree codec", () => {
  it("encodes a balanced tree to the canonical compact LeetCode array", () => {
    // [1,2,3,null,null,4,5]
    const tree: TreeNodeLike = {
      val: 1,
      left: { val: 2, left: null, right: null },
      right: {
        val: 3,
        left: { val: 4, left: null, right: null },
        right: { val: 5, left: null, right: null },
      },
    };
    expect(encodeTree(tree)).toEqual([1, 2, 3, null, null, 4, 5]);
  });

  it("encodes null root to an empty array", () => {
    expect(encodeTree(null)).toEqual([]);
  });

  it("encodes a single-node tree to [val]", () => {
    expect(encodeTree({ val: 42, left: null, right: null })).toEqual([42]);
  });

  it("round-trips arbitrary trees through encode -> decode -> encode", () => {
    const trees: Array<TreeNodeLike | null> = [
      null,
      { val: 1, left: null, right: null },
      {
        val: 1,
        left: { val: 2, left: null, right: null },
        right: {
          val: 3,
          left: { val: 4, left: null, right: null },
          right: { val: 5, left: null, right: null },
        },
      },
      {
        // left-skewed
        val: 1,
        left: { val: 2, left: { val: 3, left: null, right: null }, right: null },
        right: null,
      },
    ];

    for (const tree of trees) {
      const encoded = encodeTree(tree);
      const decoded = decodeTree(encoded);
      expect(encodeTree(decoded)).toEqual(encoded);
    }
  });

  it("decode([]) and decode([null]) both produce a null tree", () => {
    expect(decodeTree([])).toBeNull();
    expect(decodeTree([null])).toBeNull();
  });

  it("decodes the canonical example array to the expected shape", () => {
    const decoded = decodeTree([1, 2, 3, null, null, 4, 5]);
    expect(decoded).toEqual({
      val: 1,
      left: { val: 2, left: null, right: null },
      right: {
        val: 3,
        left: { val: 4, left: null, right: null },
        right: { val: 5, left: null, right: null },
      },
    });
  });
});

describe("list codec", () => {
  it("encodes a linked list to a plain array", () => {
    const list: ListNodeLike = {
      val: 1,
      next: { val: 2, next: { val: 3, next: null } },
    };
    expect(encodeList(list)).toEqual([1, 2, 3]);
  });

  it("encodes null head to an empty array", () => {
    expect(encodeList(null)).toEqual([]);
  });

  it("round-trips through encode -> decode -> encode", () => {
    for (const arr of [[], [1], [1, 2, 3, 4, 5], ["a", "b"]]) {
      const decoded = decodeList(arr);
      expect(encodeList(decoded)).toEqual(arr);
    }
  });

  it("decode([]) produces a null head", () => {
    expect(decodeList([])).toBeNull();
  });

  it("decodes a plain array to the expected linked shape", () => {
    expect(decodeList([1, 2, 3])).toEqual({
      val: 1,
      next: { val: 2, next: { val: 3, next: null } },
    });
  });
});

import type { Concept, ConceptEdge } from "@algolift/shared";

/** Mirrors docs/CONTRACTS.md §3 taxonomy seed exactly — ids are load-bearing elsewhere. */
const NAMES: Record<string, string> = {
  arrays_hashing: "Arrays & Hashing",
  two_pointers: "Two Pointers",
  sliding_window: "Sliding Window",
  stacks_queues: "Stacks & Queues",
  binary_search: "Binary Search",
  linked_list: "Linked List",
  trees_bst: "Trees & BST",
  heaps_pq: "Heaps / Priority Queue",
  tries: "Tries",
  graph_traversal: "Graph Traversal",
  graph_structure: "Graph Structure",
  shortest_paths: "Shortest Paths",
  backtracking: "Backtracking",
  dp_1d: "1-D Dynamic Programming",
  dp_2d: "2-D Dynamic Programming",
  greedy: "Greedy",
  intervals: "Intervals",
  bit_manipulation: "Bit Manipulation",
  math_geometry: "Math & Geometry",
  sorting: "Sorting",
};

const EDGE_PAIRS: Array<[string, string]> = [
  ["arrays_hashing", "two_pointers"],
  ["two_pointers", "sliding_window"],
  ["sliding_window", "stacks_queues"],
  ["arrays_hashing", "binary_search"],
  ["arrays_hashing", "sorting"],
  ["arrays_hashing", "trees_bst"],
  ["linked_list", "trees_bst"],
  ["trees_bst", "heaps_pq"],
  ["trees_bst", "tries"],
  ["trees_bst", "graph_traversal"],
  ["graph_traversal", "graph_structure"],
  ["graph_structure", "shortest_paths"],
  ["graph_traversal", "backtracking"],
  ["backtracking", "dp_1d"],
  ["dp_1d", "dp_2d"],
  ["arrays_hashing", "greedy"],
  ["sorting", "intervals"],
  ["arrays_hashing", "bit_manipulation"],
  ["arrays_hashing", "math_geometry"],
  ["arrays_hashing", "linked_list"],
];

export const CONCEPTS: Concept[] = Object.entries(NAMES).map(([id, name], i) => ({
  id,
  name,
  description: "",
  misconceptions: [],
  min_rating: 800,
  max_rating: 2400,
  sort_order: i,
}));

export const CONCEPT_EDGES: ConceptEdge[] = EDGE_PAIRS.map(([parent_id, child_id]) => ({
  parent_id,
  child_id,
}));

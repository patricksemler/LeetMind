"""The fixed curated taxonomy (PLAN_BACKEND.md §5). Both lists are constants for v1 — no admin UI,
no runtime mutation. `PROBLEM_TYPES` order is also the seeded `ordinal` in migration 0001."""

PROBLEM_TYPES: tuple[str, ...] = (
    "arrays_hashing",
    "two_pointers",
    "sliding_window",
    "binary_search",
    "stack",
    "queue_deque",
    "linked_list",
    "trees",
    "bst",
    "heap_priority_queue",
    "tries",
    "backtracking",
    "graphs_bfs_dfs",
    "graphs_advanced",
    "dp_1d",
    "dp_2d",
    "greedy",
    "intervals",
    "bit_manipulation",
    "math_geometry",
)

SHAPES: tuple[str, ...] = (
    "optimize_subarray",
    "count_structures",
    "kth_element",
    "min_max_window",
    "path_search",
    "decision_feasibility",
    "construct_output",
    "simulate_process",
    "pairing_matching",
    "partition_grouping",
    "query_answering",
    "transform_encode",
)

DEFAULT_RATING = 1200

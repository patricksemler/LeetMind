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

# A shape is an activity archetype, not a Cartesian product with every concept. The previous
# global rotation started every fresh concept at `optimize_subarray`, producing combinations such
# as queue/deque + optimize-subarray at a beginner rating that the independent reviewer correctly
# rejected. Keep the canonical/basic shape first; `planner._lru_shape_for_type` rotates only inside
# the selected concept's compatible tuple.
TYPE_SHAPES: dict[str, tuple[str, ...]] = {
    "arrays_hashing": ("count_structures", "query_answering", "pairing_matching"),
    "two_pointers": ("pairing_matching", "partition_grouping", "optimize_subarray"),
    "sliding_window": ("min_max_window", "optimize_subarray", "count_structures"),
    "binary_search": ("query_answering", "decision_feasibility", "kth_element"),
    "stack": ("simulate_process", "transform_encode", "decision_feasibility"),
    "queue_deque": ("simulate_process", "query_answering", "construct_output"),
    "linked_list": ("transform_encode", "simulate_process", "pairing_matching"),
    "trees": ("path_search", "count_structures", "query_answering"),
    "bst": ("query_answering", "kth_element", "path_search"),
    "heap_priority_queue": ("kth_element", "simulate_process", "min_max_window"),
    "tries": ("query_answering", "transform_encode", "count_structures"),
    "backtracking": ("construct_output", "count_structures", "partition_grouping"),
    "graphs_bfs_dfs": ("path_search", "count_structures", "partition_grouping"),
    "graphs_advanced": ("path_search", "pairing_matching", "decision_feasibility"),
    "dp_1d": ("optimize_subarray", "count_structures", "decision_feasibility"),
    "dp_2d": ("path_search", "count_structures", "construct_output"),
    "greedy": ("partition_grouping", "pairing_matching", "decision_feasibility"),
    "intervals": ("min_max_window", "partition_grouping", "query_answering"),
    "bit_manipulation": ("transform_encode", "count_structures", "decision_feasibility"),
    "math_geometry": ("transform_encode", "count_structures", "decision_feasibility"),
}

DEFAULT_RATING = 1200

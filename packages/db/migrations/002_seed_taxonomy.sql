-- 002_seed_taxonomy.sql — concept taxonomy, prerequisite edges, and the
-- single local user (CONTRACTS.md §3 "Concept taxonomy seed"). Every insert
-- is `on conflict do nothing` so re-running this file (or the whole
-- migration set) is a safe no-op.
--
-- NOTE: prose below deliberately avoids apostrophes/contractions so none of
-- the single-quoted SQL string literals need escaping.

-- ---------------------------------------------------------------------------
-- concepts (ids are fixed — other code references them)
-- ---------------------------------------------------------------------------
insert into concepts (id, name, description, misconceptions, min_rating, max_rating, sort_order) values
  ('arrays_hashing', 'Arrays & Hashing',
   'Storing and looking up values in arrays and hash maps/sets to trade space for near-constant-time access.',
   '["Assuming a hash map lookup is O(1) worst case rather than average case.","Forgetting that dictionary or set iteration order and equality depend on how keys hash.","Reaching for nested loops before considering a map for a single-pass solution."]',
   800, 1800, 10),

  ('two_pointers', 'Two Pointers',
   'Walking two indices across a sequence, converging or moving in the same direction, to avoid an inner loop.',
   '["Using two pointers on unsorted data where the converging-pointer invariant does not hold.","Off-by-one errors when the pointers meet or cross.","Not realizing the technique requires sorted or otherwise structured input to be valid."]',
   900, 1800, 20),

  ('sliding_window', 'Sliding Window',
   'Maintaining a contiguous subrange with a running aggregate, expanding and contracting its bounds instead of recomputing from scratch.',
   '["Recomputing the window aggregate from scratch on every shift instead of updating it incrementally.","Using a fixed-size window template for a variable-size-window problem.","Forgetting to shrink the window when the invariant is violated, not only when it is satisfied."]',
   1000, 1900, 30),

  ('stacks_queues', 'Stacks & Queues',
   'LIFO and FIFO structures used for matching, monotonic scans, and order-preserving processing.',
   '["Using a stack where a queue is required by the ordering of the problem, or the reverse.","Not popping a monotonic stack far enough before pushing, corrupting the invariant.","Ignoring stack-underflow or empty-queue edge cases."]',
   900, 1800, 40),

  ('binary_search', 'Binary Search',
   'Halving a monotonic search space instead of scanning linearly, including on implicit answer-space domains.',
   '["Applying binary search to unsorted or non-monotonic data.","Off-by-one loop bounds causing infinite loops or missed elements.","Not recognizing binary-search-on-the-answer problems where the array itself is not sorted."]',
   900, 1900, 50),

  ('sorting', 'Sorting',
   'Ordering data as a preprocessing step to unlock other techniques such as two pointers, greedy, or interval merging.',
   '["Assuming a language default sort is O(n) or stable when neither is guaranteed.","Sorting by the wrong key, for example end instead of start, for the required greedy invariant.","Re-sorting inside a loop instead of once up front."]',
   800, 1700, 60),

  ('intervals', 'Intervals',
   'Merging, overlapping, and scheduling ranges, almost always after sorting by start or end.',
   '["Treating touching intervals such as [1,2] and [2,3] as non-overlapping when the problem defines them as overlapping, or the reverse.","Sorting by start when the greedy proof requires sorting by end, or the reverse.","Forgetting to merge the current interval before moving to the next one."]',
   1100, 2000, 70),

  ('linked_list', 'Linked Lists',
   'Pointer manipulation over singly and doubly linked nodes: reversal, cycle detection, merging.',
   '["Losing the reference to the next node before rewiring pointers, breaking the rest of the list.","Off-by-one errors with dummy or sentinel head nodes.","Not handling the empty-list or single-node edge cases."]',
   900, 1800, 80),

  ('trees_bst', 'Trees & BST',
   'Recursive and iterative traversal and invariant maintenance over binary trees and binary search trees.',
   '["Assuming any binary tree is a BST and applying BST-only shortcuts.","Confusing traversal orders (preorder, inorder, postorder) and their use cases.","Forgetting that BST validity is a global property, not just left-less-than-node-less-than-right at each node locally."]',
   1000, 2100, 90),

  ('heaps_pq', 'Heaps & Priority Queues',
   'Maintaining the running minimum or maximum, or a top-k set, efficiently via a binary heap instead of re-sorting.',
   '["Using a heap when a fixed-size top-k array or a single sort would be simpler and sufficient.","Forgetting most standard-library heaps are min-heaps, requiring negation for a max-heap.","Assuming heap iteration order is sorted order."]',
   1100, 2100, 100),

  ('tries', 'Tries',
   'Prefix trees for efficient prefix search, autocomplete, and word-set membership.',
   '["Using a trie when a plain hash set would answer the actual question just as well.","Forgetting to mark end-of-word nodes, causing false-positive prefix matches.","Not bounding memory or branching factor for large alphabets."]',
   1200, 2100, 110),

  ('graph_traversal', 'Graph Traversal (BFS/DFS)',
   'Exploring nodes and edges via breadth-first or depth-first search, and choosing correctly between them.',
   '["Using DFS when BFS is required for shortest-path-in-unweighted-graph guarantees.","Forgetting a visited set, causing infinite loops on cyclic graphs.","Not handling disconnected components when the problem implies a single connected traversal."]',
   1100, 2200, 120),

  ('graph_structure', 'Graph Structure (toposort, union-find)',
   'Structural graph algorithms: topological ordering of DAGs and disjoint-set union for connectivity.',
   '["Attempting a topological sort on a graph that has a cycle without detecting it.","Not using path compression or union by rank, degrading union-find toward linear scans.","Confusing connected with reachable in a specific direction on directed graphs."]',
   1300, 2300, 130),

  ('shortest_paths', 'Shortest Paths',
   'Weighted shortest-path algorithms: Dijkstra, BFS for unit-weight graphs, and Bellman-Ford-style relaxation.',
   '["Using Dijkstra on graphs with negative edge weights, where it silently gives wrong answers.","Reaching for a full shortest-path algorithm when unweighted BFS already suffices.","Not relaxing edges enough times, or not detecting negative cycles when required."]',
   1400, 2600, 140),

  ('backtracking', 'Backtracking',
   'Systematic exhaustive search with pruning: choose, explore, then undo the choice.',
   '["Forgetting to undo a choice before trying the next branch, corrupting shared state.","Missing pruning conditions, causing exponential blowup that a simple bound would avoid.","Confusing backtracking with plain brute-force enumeration and not exploiting early termination."]',
   1300, 2300, 150),

  ('dp_1d', '1D Dynamic Programming',
   'Optimal substructure and overlapping subproblems reduced to a single-dimension state, an index or an index plus a small extra dimension.',
   '["Writing the recursive relation but forgetting to memoize, leaving it exponential.","Getting the base cases wrong, especially for the smallest one or two indices.","Not recognizing that a greedy-looking problem actually requires DP because a locally optimal choice is not globally optimal."]',
   1200, 2200, 160),

  ('dp_2d', '2D Dynamic Programming',
   'DP over two interacting dimensions, such as two sequences or an index plus a capacity or count, including grid and knapsack-style problems.',
   '["Allocating and filling the full 2D table when a rolling 1D array would suffice and the extra dimension is unnecessary.","Mixing up which dimension represents which sequence or resource, transposing the recurrence.","Off-by-one errors in the padding row or column used for empty-prefix base cases."]',
   1400, 2600, 170),

  ('greedy', 'Greedy',
   'Making the locally optimal choice at each step and proving, or trusting a known result, that it is globally optimal.',
   '["Applying a greedy strategy without verifying the exchange-argument or matroid property actually holds for this problem.","Confusing the existence of a greedy solution with the correctness of the first greedy idea tried.","Not sorting by the correct key before applying the greedy pass."]',
   1100, 2200, 180),

  ('bit_manipulation', 'Bit Manipulation',
   'Using bitwise operators for compact state, XOR tricks, and O(1) bit-level arithmetic.',
   '["Forgetting sign-extension and two-complement behavior when shifting negative numbers.","Using XOR-based find-the-unique-element tricks on problems where duplicates violate the required preconditions.","Off-by-one errors in bit indices, zero-indexed versus one-indexed bit positions."]',
   900, 1900, 190),

  ('math_geometry', 'Math & Geometry',
   'Number theory, modular arithmetic, and coordinate or geometry reasoning that underlies certain problem families.',
   '["Integer overflow from not applying a required modulus early enough in the computation.","Assuming floating-point geometry comparisons can use exact equality instead of an epsilon tolerance.","Forgetting edge cases like collinear points, zero-area shapes, or division by zero in geometric formulas."]',
   1000, 2100, 200)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- concept_edges (parent -> child, prerequisite direction)
-- ---------------------------------------------------------------------------
insert into concept_edges (parent_id, child_id) values
  ('arrays_hashing', 'two_pointers'),
  ('two_pointers', 'sliding_window'),
  ('sliding_window', 'stacks_queues'),
  ('arrays_hashing', 'binary_search'),
  ('arrays_hashing', 'sorting'),
  ('arrays_hashing', 'trees_bst'),
  ('linked_list', 'trees_bst'),
  ('trees_bst', 'heaps_pq'),
  ('trees_bst', 'tries'),
  ('trees_bst', 'graph_traversal'),
  ('graph_traversal', 'graph_structure'),
  ('graph_structure', 'shortest_paths'),
  ('graph_traversal', 'backtracking'),
  ('backtracking', 'dp_1d'),
  ('dp_1d', 'dp_2d'),
  ('arrays_hashing', 'greedy'),
  ('sorting', 'intervals'),
  ('arrays_hashing', 'bit_manipulation'),
  ('arrays_hashing', 'math_geometry'),
  ('arrays_hashing', 'linked_list')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- single local user (CONTRACTS.md §1 "Single-user mode")
-- ---------------------------------------------------------------------------
insert into users (id, handle) values
  ('00000000000000000000000001', 'local')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- initial user_concept_state: every concept starts at rating 1200 /
-- uncertainty 350 for the local user (all other columns take their table
-- defaults: 0 counters, review_interval_days=1, review_ease=2.5, etc.)
-- ---------------------------------------------------------------------------
insert into user_concept_state (user_id, concept_id, rating, uncertainty)
select '00000000000000000000000001', id, 1200, 350
from concepts
on conflict do nothing;

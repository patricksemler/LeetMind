"""Banned-word detection for hint stage 1 (CONTRACTS.md §10):

    dynamic programming, dp, two pointer, sliding window, binary search, union find, dfs, bfs,
    memo, trie, heap, topological, backtrack, greedy, dijkstra, kadane, monotonic — plus any
    ``` fence.

Matching is case-insensitive and on WORD BOUNDARIES so short tokens like `dp` don't false-fire
inside an unrelated longer word (e.g. "adapt", "dprint") — a substring search would. The leading
boundary is what guards against that; it's never relaxed. Two things ARE relaxed, both confirmed
live as gaps: a hyphenated compound ("two-pointer", "sliding-window", "union-find") between the
words of a multi-word term, and a common English inflection tacked onto the end of the LAST word
("backtracking", "memoization"/"memoized", "heaps") — dropping either let generated content slip
a banned concept past the gate in a form only trivially different from the banned phrase itself.
"""

from __future__ import annotations

import re

BANNED_TERMS: tuple[str, ...] = (
    "dynamic programming",
    "dp",
    "two pointer",
    "sliding window",
    "binary search",
    "union find",
    "dfs",
    "bfs",
    "memo",
    "trie",
    "heap",
    "topological",
    "backtrack",
    "greedy",
    "dijkstra",
    "kadane",
    "monotonic",
)

CODE_FENCE = "```"

# Common English inflections tolerated on the end of a banned term's last word — "backtrack" also
# catches "backtracking"/"backtracks", "memo" also catches "memoization"/"memoized"/"memoize",
# "heap" also catches "heaps"/"heapify". Ordered longest-first so the regex alternation can't stop
# at a short prefix match ("ing" before "ization") and leave the rest dangling outside \b.
_INFLECTION_SUFFIXES = (
    "izations",
    "ization",
    "izing",
    "ized",
    "izes",
    "ize",
    "ing",
    "es",
    "ed",
    "s",
)


def _term_pattern(term: str) -> re.Pattern[str]:
    # Multi-word terms tolerate any run of whitespace OR a hyphen between words (e.g. a model
    # emitting "two   pointer", a line-wrapped "sliding\nwindow", or "union-find" all count as the
    # banned phrase).
    escaped_words = [re.escape(w) for w in term.split(" ")]
    body = r"[\s-]+".join(escaped_words)
    suffix = "(?:" + "|".join(_INFLECTION_SUFFIXES) + ")?"
    return re.compile(rf"\b{body}{suffix}\b", re.IGNORECASE)


_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (t, _term_pattern(t)) for t in BANNED_TERMS
)


def find_banned_terms(text: str) -> list[str]:
    """Returns every banned term (from `BANNED_TERMS`) that appears in `text` as a whole word /
    whole phrase, case-insensitively, plus the literal string `"code fence"` if a ``` fence is
    present. Empty list means clean. Never raises."""
    if not text:
        return []
    hits = [term for term, pattern in _PATTERNS if pattern.search(text)]
    if CODE_FENCE in text:
        hits.append("code fence")
    return hits

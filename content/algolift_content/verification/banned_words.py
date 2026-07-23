"""Banned-word detection for hint stage 1 (CONTRACTS.md §10):

    dynamic programming, dp, two pointer, sliding window, binary search, union find, dfs, bfs,
    memo, trie, heap, topological, backtrack, greedy, dijkstra, kadane, monotonic — plus any
    ``` fence.

Matching is case-insensitive and on WORD BOUNDARIES so short tokens like `dp` don't false-fire
inside an unrelated longer word (e.g. "adapt", "dprint") — a substring search would.
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


def _term_pattern(term: str) -> re.Pattern[str]:
    # Multi-word terms tolerate any run of whitespace between words (e.g. a model emitting
    # "two   pointer" or a line-wrapped "sliding\nwindow" still counts as the banned phrase).
    escaped_words = [re.escape(w) for w in term.split(" ")]
    body = r"\s+".join(escaped_words)
    return re.compile(rf"\b{body}\b", re.IGNORECASE)


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

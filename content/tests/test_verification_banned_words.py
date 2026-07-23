"""Pure-Python tests for the hint-ladder banned-word matcher (CONTRACTS.md §10 stage 1).

No sandbox / DB needed — always runs.
"""

from __future__ import annotations

from algolift_content.verification.banned_words import find_banned_terms


def test_clean_text_has_no_hits() -> None:
    text = "Think about which windows of the array are worth comparing as you slide along."
    assert find_banned_terms(text) == []


def test_detects_single_word_term() -> None:
    assert "dp" in find_banned_terms("use dp here")


def test_detects_multi_word_term_regardless_of_whitespace() -> None:
    assert "sliding window" in find_banned_terms("try a sliding   window approach")
    assert "two pointer" in find_banned_terms("a two pointer scan works")


def test_detects_code_fence() -> None:
    assert "code fence" in find_banned_terms("```python\nprint(1)\n```")


def test_case_insensitive() -> None:
    assert "binary search" in find_banned_terms("Binary Search is the key idea")


def test_dp_does_not_false_positive_inside_adapt() -> None:
    # "adapt" doesn't even contain "dp" as a substring, but this pins down the intent: a
    # word-boundary match must never fire on a longer unrelated word.
    assert find_banned_terms("you'll need to adapt your approach") == []


def test_dp_does_not_false_positive_inside_dprint() -> None:
    # "dprint" starts with the literal substring "dp" but is not the standalone word "dp" —
    # a naive substring search would false-positive here; \bdp\b must not.
    assert find_banned_terms("call dprint(x) to debug") == []


def test_dp_word_boundary_matches_hyphenated_use() -> None:
    assert "dp" in find_banned_terms("a dp-based approach")


def test_multiple_hits_all_reported() -> None:
    hits = find_banned_terms("use a heap and also a memo table with dp, or try dfs")
    assert set(hits) == {"heap", "memo", "dp", "dfs"}


def test_memo_word_boundary_does_not_match_memoize() -> None:
    # "memoize"/"memoization" contain "memo" as a prefix but are not the standalone word
    # "memo" — \bmemo\b must not match inside a longer word either.
    assert find_banned_terms("you could memoize this recursive call") == []


def test_empty_and_none_like_input_is_clean() -> None:
    assert find_banned_terms("") == []

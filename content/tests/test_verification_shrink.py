"""Pure-Python tests for the shrink-candidate generation / size metric in
`leetmind_content.verification.shrink` (the parts that don't need the sandbox — the sandboxed
`shrink_counterexample` end-to-end path is covered in test_verification_gate.py).
"""

from __future__ import annotations

from leetmind_content.verification.shrink import shrink_candidates, size_metric


def test_size_metric_prefers_smaller_lists() -> None:
    assert size_metric([[1, 2, 3, 4, 5]]) > size_metric([[1, 2]])


def test_size_metric_prefers_smaller_ints() -> None:
    assert size_metric([100]) > size_metric([1])
    assert size_metric([-100]) > size_metric([0])


def test_shrink_candidates_includes_list_halving() -> None:
    candidates = shrink_candidates([[1, 2, 3, 4, 5, 6], 3])
    assert [1, 2, 3] in [c[0] for c in candidates]  # first half
    assert [4, 5, 6] in [c[0] for c in candidates]  # second half
    assert [] not in [c[0] for c in candidates]  # n>1, empty isn't offered directly


def test_shrink_candidates_includes_empty_for_singleton_list() -> None:
    candidates = shrink_candidates([[7], 1])
    assert any(c[0] == [] for c in candidates)


def test_shrink_candidates_shrinks_ints_toward_zero() -> None:
    candidates = shrink_candidates([[], 50])
    second_args = [c[1] for c in candidates]
    assert 0 in second_args
    assert 25 in second_args  # halved
    assert 49 in second_args  # decremented


def test_shrink_candidates_of_already_minimal_args_is_small() -> None:
    # [0] has no int candidates (already 0); [] has no list candidates (already empty).
    assert shrink_candidates([[], 0]) == []


def test_shrink_candidates_never_mutates_other_positions() -> None:
    args = [[1, 2, 3], 9]
    for candidate in shrink_candidates(args):
        # exactly one position differs from the original per candidate
        diffs = sum(1 for a, b in zip(args, candidate, strict=True) if a != b)
        assert diffs == 1

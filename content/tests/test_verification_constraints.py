"""Pure-Python tests for `leetmind_content.verification.constraints` (bound extraction for
stage_boundary, CONTRACTS.md §10 stage 4). No sandbox / DB needed — always runs.
"""

from __future__ import annotations

from leetmind_content.verification.constraints import coupled_scalars, parse_bounds


def test_sample_problem_constraints_parse_correctly() -> None:
    constraints_md = "- `1 <= k <= len(nums) <= 50`\n- `-100 <= nums[i] <= 100`"
    bounds = parse_bounds(constraints_md)

    assert bounds["scalar:k"].min == 1
    assert bounds["scalar:k"].max == 50
    # The key assertion: len(nums) inherits min=1 by transitivity through `k`, even though `1`
    # is never textually adjacent to `len(nums)`.
    assert bounds["len:nums"].min == 1
    assert bounds["len:nums"].max == 50
    assert bounds["elem:nums"].min == -100
    assert bounds["elem:nums"].max == 100


def test_k_and_len_nums_are_coupled() -> None:
    bounds = parse_bounds("- `1 <= k <= len(nums) <= 50`")
    assert coupled_scalars(bounds, "nums") == ["k"]


def test_unrelated_scalar_is_not_coupled() -> None:
    constraints_md = "- `1 <= k <= len(nums) <= 50`\n- `0 <= extra <= 10`"
    bounds = parse_bounds(constraints_md)
    assert coupled_scalars(bounds, "nums") == ["k"]
    assert "extra" not in coupled_scalars(bounds, "nums")


def test_simple_two_term_bound() -> None:
    bounds = parse_bounds("- `n <= 100`")
    assert bounds["scalar:n"].max == 100
    assert bounds["scalar:n"].min is None


def test_negative_lower_bound() -> None:
    bounds = parse_bounds("- `-1000 <= x <= 1000`")
    assert bounds["scalar:x"].min == -1000
    assert bounds["scalar:x"].max == 1000


def test_unparseable_constraints_returns_empty_without_raising() -> None:
    assert parse_bounds("Some free-form prose with no inequalities at all.") == {}
    assert parse_bounds("") == {}
    assert parse_bounds(None) == {}  # type: ignore[arg-type]


def test_element_bound_pattern() -> None:
    bounds = parse_bounds("- `0 <= arr[i] <= 9`")
    assert bounds["elem:arr"].min == 0
    assert bounds["elem:arr"].max == 9

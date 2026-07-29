"""§8.4 value-contract comparator fixtures: type-strict equality, float tolerance, order
insensitivity, and nullable structures (level-order trees). Pure unit tests, no Docker."""

from __future__ import annotations

from datetime import UTC, datetime

from leetmind.schemas import GenerationEvent, ValueType, values_equal

INT = ValueType(kind="int")
FLOAT = ValueType(kind="float")
BOOL = ValueType(kind="bool")
STR = ValueType(kind="str")
INT_LIST = ValueType(kind="int", list_depth=1)
NULLABLE_INT_TREE = ValueType(kind="int", nullable=True, list_depth=1)


def test_bool_never_equals_int():
    assert not values_equal(1, True, INT)
    assert not values_equal(True, 1, BOOL)
    assert values_equal(True, True, BOOL)
    assert values_equal(1, 1, INT)


def test_int_return_of_float_is_wrong_answer():
    # declared int: 2.0 is not an acceptable rounding of 2
    assert not values_equal(2, 2.0, INT)


def test_float_accepts_int_and_tolerance():
    assert values_equal(2.0, 2, FLOAT)  # a plain-number return is fine for a float field
    assert values_equal(1.0000001, 1.0000002, FLOAT)
    assert not values_equal(1.0, 1.1, FLOAT)
    assert not values_equal(1.0, True, FLOAT)  # bool is never a number here


def test_string_equality_is_exact():
    assert values_equal("1", "1", STR)
    assert not values_equal("1", "01", STR)
    assert not values_equal(1, "1", STR)


def test_lists_are_ordered_by_default():
    assert values_equal([1, 2, 3], [1, 2, 3], INT_LIST)
    assert not values_equal([1, 2, 3], [3, 2, 1], INT_LIST)


def test_order_insensitive_compares_as_multiset():
    assert values_equal([1, 2, 3], [3, 2, 1], INT_LIST, order_insensitive=True)
    assert not values_equal([1, 2, 3], [1, 2, 2], INT_LIST, order_insensitive=True)
    assert not values_equal([1, 2], [1, 2, 3], INT_LIST, order_insensitive=True)


def test_nullable_tree_leaves():
    # level-order binary tree: int?[]
    assert values_equal([1, None, 3], [1, None, 3], NULLABLE_INT_TREE)
    assert not values_equal([1, None, 3], [1, 2, 3], NULLABLE_INT_TREE)


def test_null_rejected_when_not_nullable():
    assert not values_equal([1, None, 3], [1, None, 3], INT_LIST)


def test_nested_lists():
    grid = ValueType(kind="int", list_depth=2)
    assert values_equal([[1, 2], [3, 4]], [[1, 2], [3, 4]], grid)
    assert not values_equal([[1, 2], [3, 4]], [[1, 2], [4, 3]], grid)


def test_length_mismatch_is_not_equal():
    assert not values_equal([1, 2, 3], [1, 2], INT_LIST)


def test_generation_event_contract_never_contains_raw_error_details():
    now = datetime.now(UTC)
    event = GenerationEvent(
        job_id="job-1",
        status="verifying",
        phase="stress_testing",
        repair_count=0,
        attempt=1,
        max_attempts=2,
        started_at=now,
        phase_started_at=now,
    )

    assert "error" not in event.model_dump()

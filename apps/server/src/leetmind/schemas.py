"""The §8.4 value contract: the single type system shared by the builder, the judge, and (once
generated) the frontend. `ValueType` describes a signature's parameter/return type; `values_equal`
is the comparator's law — the only place "is this answer right" gets decided."""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel

ScalarKind = Literal["int", "float", "bool", "str"]

FLOAT_ABS_TOL = 1e-6
FLOAT_REL_TOL = 1e-6


class ValueType(BaseModel):
    """`T ::= int | float | bool | str | T? | T[]`.

    `list_depth` counts the `[]` nesting (0 = scalar); `nullable` marks the *leaf* scalar as
    `T?` — e.g. a level-order binary tree is `ValueType(kind="int", nullable=True, list_depth=1)`.
    """

    kind: ScalarKind
    nullable: bool = False
    list_depth: int = 0


class Verdict(StrEnum):
    PASS = "pass"
    WRONG_ANSWER = "wrong_answer"
    ERROR = "error"
    TIMEOUT = "timeout"


class TestCase(BaseModel):
    """One test to run: the args passed positionally to the submitted function, the agreed
    expected value (§7.4), and the return type used to compare them."""

    __test__ = False  # not a pytest test despite the name

    args: list[Any]
    expected: Any
    value_type: ValueType
    order_insensitive: bool = False


class TestOutcome(BaseModel):
    __test__ = False  # not a pytest test despite the name

    index: int
    verdict: Verdict
    value: Any = None
    error: str | None = None
    printed: str = ""
    duration_ms: int = 0


def _scalar_equal(expected: object, actual: object, kind: ScalarKind) -> bool:
    if kind == "bool":
        return isinstance(expected, bool) and isinstance(actual, bool) and expected == actual
    if kind == "int":
        return (
            isinstance(expected, int)
            and not isinstance(expected, bool)
            and isinstance(actual, int)
            and not isinstance(actual, bool)
            and expected == actual
        )
    if kind == "float":
        # Type-strict: declared float, but an int return (2 instead of 2.0) is still a plain
        # number and numerically equal, so it's accepted; a bool never is (§8.4).
        if not (isinstance(expected, (int, float)) and not isinstance(expected, bool)):
            return False
        if not (isinstance(actual, (int, float)) and not isinstance(actual, bool)):
            return False
        e, a = float(expected), float(actual)
        return abs(e - a) <= max(FLOAT_ABS_TOL, FLOAT_REL_TOL * max(abs(e), abs(a)))
    if kind == "str":
        return isinstance(expected, str) and isinstance(actual, str) and expected == actual
    raise ValueError(f"unknown scalar kind {kind!r}")


def _compare(
    expected: object,
    actual: object,
    kind: ScalarKind,
    nullable: bool,
    depth: int,
    order_insensitive: bool,
) -> bool:
    if depth > 0:
        if not isinstance(expected, list) or not isinstance(actual, list):
            return False
        if len(expected) != len(actual):
            return False
        if order_insensitive:
            return _multiset_equal(expected, actual, kind, nullable, depth - 1, order_insensitive)
        return all(
            _compare(e, a, kind, nullable, depth - 1, order_insensitive)
            for e, a in zip(expected, actual, strict=True)
        )

    if expected is None or actual is None:
        return nullable and expected is None and actual is None
    return _scalar_equal(expected, actual, kind)


def _multiset_equal(
    expected: list[object],
    actual: list[object],
    kind: ScalarKind,
    nullable: bool,
    sub_depth: int,
    order_insensitive: bool,
) -> bool:
    remaining = list(actual)
    for e in expected:
        for i, a in enumerate(remaining):
            if _compare(e, a, kind, nullable, sub_depth, order_insensitive):
                del remaining[i]
                break
        else:
            return False
    return not remaining


def values_equal(
    expected: object, actual: object, value_type: ValueType, *, order_insensitive: bool = False
) -> bool:
    """The comparator's law (§8.4): type-strict deep equality, `bool` never equals `int`,
    lists ordered unless `order_insensitive`, floats compared with tolerance."""
    return _compare(
        expected,
        actual,
        value_type.kind,
        value_type.nullable,
        value_type.list_depth,
        order_insensitive,
    )


class TypeProfileView(BaseModel):
    """One row of `GET /api/me` (§9): a type's learner-model state."""

    slug: str
    name: str
    rating: float
    attempts: int
    evidenced: bool


class MeResponse(BaseModel):
    types: list[TypeProfileView]

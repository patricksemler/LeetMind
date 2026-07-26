from __future__ import annotations

import copy
from typing import Any

import pytest
from pydantic import ValidationError

from leetmind_content.models import (
    SERVER_ONLY_FIELDS,
    ProblemVersion,
    Signature,
    is_valid_param_type,
    parse_param_type,
)

# ---------------------------------------------------------------------------
# ProblemVersion round-trip
# ---------------------------------------------------------------------------


def test_problem_version_round_trips_full_fixture(sample_problem_dict: dict[str, Any]) -> None:
    pv = ProblemVersion.model_validate(sample_problem_dict)

    assert pv.problem_id == sample_problem_dict["problem_id"]
    assert pv.signature.name == "maxSumSubarray"
    assert len(pv.examples) == 2
    assert len(pv.hidden_tests) == 5
    assert len(pv.mutants_py) == 3
    assert pv.state == "candidate"

    dumped = pv.model_dump(mode="json")
    pv2 = ProblemVersion.model_validate(dumped)
    assert pv2.model_dump(mode="json") == dumped


# ---------------------------------------------------------------------------
# Validators — each rejects its bad case
# ---------------------------------------------------------------------------


def _mutate(base: dict[str, Any], **overrides: Any) -> dict[str, Any]:
    data = copy.deepcopy(base)
    data.update(overrides)
    return data


def test_rejects_concept_weights_not_summing_to_one(sample_problem_dict: dict[str, Any]) -> None:
    data = copy.deepcopy(sample_problem_dict)
    data["concepts"][0]["weight"] = 0.5  # 0.5 + 0.3 = 0.8, off by more than 0.01
    with pytest.raises(ValidationError, match="sum to ~1.0"):
        ProblemVersion.model_validate(data)


def test_accepts_concept_weights_within_tolerance(sample_problem_dict: dict[str, Any]) -> None:
    data = copy.deepcopy(sample_problem_dict)
    data["concepts"][0]["weight"] = 0.705
    data["concepts"][1]["weight"] = 0.295
    ProblemVersion.model_validate(data)  # should not raise (sums to exactly 1.0)


def test_rejects_zero_primary_concepts(sample_problem_dict: dict[str, Any]) -> None:
    data = copy.deepcopy(sample_problem_dict)
    data["concepts"][0]["role"] = "secondary"
    with pytest.raises(ValidationError, match="exactly one concept"):
        ProblemVersion.model_validate(data)


def test_rejects_two_primary_concepts(sample_problem_dict: dict[str, Any]) -> None:
    data = copy.deepcopy(sample_problem_dict)
    data["concepts"][1]["role"] = "primary"
    with pytest.raises(ValidationError, match="exactly one concept"):
        ProblemVersion.model_validate(data)


def test_rejects_empty_examples(sample_problem_dict: dict[str, Any]) -> None:
    data = _mutate(sample_problem_dict, examples=[])
    with pytest.raises(ValidationError):
        ProblemVersion.model_validate(data)


def test_rejects_descending_expected_active_minutes(sample_problem_dict: dict[str, Any]) -> None:
    data = _mutate(sample_problem_dict, expected_active_minutes=[12, 5])
    with pytest.raises(ValidationError, match="ascending"):
        ProblemVersion.model_validate(data)


def test_rejects_nonpositive_expected_active_minutes(sample_problem_dict: dict[str, Any]) -> None:
    data = _mutate(sample_problem_dict, expected_active_minutes=[0, 5])
    with pytest.raises(ValidationError, match="positive"):
        ProblemVersion.model_validate(data)


@pytest.mark.parametrize("rating", [599, 3001, 100, 5000])
def test_rejects_difficulty_rating_out_of_range(sample_problem_dict: dict[str, Any], rating: int) -> None:
    data = copy.deepcopy(sample_problem_dict)
    data["difficulty"]["rating"] = rating
    with pytest.raises(ValidationError):
        ProblemVersion.model_validate(data)


@pytest.mark.parametrize("rating", [600, 1200, 3000])
def test_accepts_difficulty_rating_in_range(sample_problem_dict: dict[str, Any], rating: int) -> None:
    data = copy.deepcopy(sample_problem_dict)
    data["difficulty"]["rating"] = rating
    ProblemVersion.model_validate(data)  # should not raise


# ---------------------------------------------------------------------------
# public_dict() — security critical: must leak nothing server-only
# ---------------------------------------------------------------------------

_DENY_LIST = {
    "hidden_tests",
    "mutants_py",
    "reference_solution_py",
    # Both reference solutions are stripped from `public_dict()` for the same reason: they are the
    # answer. They reach the user only through the earned post-solve reveal the API builds from its
    # own allowlist (apps/api/src/mappers/submission.ts), never as part of the public problem.
    "reference_solution_cpp",
    "brute_force_py",
    "input_generator_py",
    "checker_py",
}


def test_server_only_fields_constant_matches_deny_list() -> None:
    assert set(SERVER_ONLY_FIELDS) == _DENY_LIST


def test_public_dict_strips_server_only_fields(sample_problem_dict: dict[str, Any]) -> None:
    pv = ProblemVersion.model_validate(sample_problem_dict)
    public = pv.public_dict()

    for key in _DENY_LIST:
        assert key not in public, f"public_dict() leaked server-only field {key!r}"

    # Sanity: the source fields really were present pre-strip, so this is a meaningful assertion.
    full = pv.model_dump(mode="json")
    for key in _DENY_LIST:
        assert key in full


def test_public_dict_strips_all_hints_by_default(sample_problem_dict: dict[str, Any]) -> None:
    pv = ProblemVersion.model_validate(sample_problem_dict)
    public = pv.public_dict()
    assert public["hints"] == {}


def test_public_dict_reveals_only_taken_hint_levels(sample_problem_dict: dict[str, Any]) -> None:
    pv = ProblemVersion.model_validate(sample_problem_dict)
    public = pv.public_dict(taken_hint_levels=("l1_orientation", "l2_conceptual"))
    assert set(public["hints"].keys()) == {"l1_orientation", "l2_conceptual"}
    assert public["hints"]["l1_orientation"] == pv.hints.l1_orientation


def test_public_dict_preserves_safe_fields(sample_problem_dict: dict[str, Any]) -> None:
    pv = ProblemVersion.model_validate(sample_problem_dict)
    public = pv.public_dict()
    assert public["title"] == pv.title
    assert public["statement_md"] == pv.statement_md
    assert public["examples"]
    assert public["signature"]["name"] == "maxSumSubarray"


# ---------------------------------------------------------------------------
# parse_param_type / is_valid_param_type
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("scalar", ["int", "float", "bool", "str"])
def test_parse_param_type_scalars(scalar: str) -> None:
    assert parse_param_type(scalar) == {"kind": "scalar", "name": scalar}


def test_parse_param_type_tree_and_linkedlist_nullability() -> None:
    assert parse_param_type("TreeNode") == {"kind": "tree", "nullable": False}
    assert parse_param_type("TreeNode?") == {"kind": "tree", "nullable": True}
    assert parse_param_type("ListNode") == {"kind": "linkedlist", "nullable": False}
    assert parse_param_type("ListNode?") == {"kind": "linkedlist", "nullable": True}


def test_parse_param_type_nested_lists() -> None:
    assert parse_param_type("list[int]") == {"kind": "list", "of": {"kind": "scalar", "name": "int"}}
    assert parse_param_type("list[list[int]]") == {
        "kind": "list",
        "of": {"kind": "list", "of": {"kind": "scalar", "name": "int"}},
    }
    assert parse_param_type("list[TreeNode?]") == {
        "kind": "list",
        "of": {"kind": "tree", "nullable": True},
    }


@pytest.mark.parametrize(
    "garbage",
    ["", "integer", "list[int", "TreeNode??", "list[]", "Node", "list[foo]", "list[int]]", "int32"],
)
def test_parse_param_type_rejects_garbage(garbage: str) -> None:
    assert not is_valid_param_type(garbage)
    with pytest.raises(ValueError):
        parse_param_type(garbage)


def test_signature_rejects_invalid_param_type() -> None:
    with pytest.raises(ValidationError):
        Signature.model_validate(
            {"name": "f", "params": [{"name": "x", "type": "not_a_type"}], "returns": "int"}
        )


def test_signature_accepts_valid_nested_type() -> None:
    sig = Signature.model_validate(
        {"name": "f", "params": [{"name": "grid", "type": "list[list[int]]"}], "returns": "bool"}
    )
    assert sig.params[0].type == "list[list[int]]"

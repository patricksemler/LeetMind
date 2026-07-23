from __future__ import annotations

import pytest

from algolift_content.models import Signature, TestCase
from algolift_content.sandbox import SANDBOX_AVAILABLE, SandboxLimits, run_python, sandbox_probe


def test_sandbox_probe_returns_reason_when_unavailable() -> None:
    """Exercises `sandbox_probe()` unconditionally (unlike the execution test below, which
    skips when the sandbox isn't available) so this module always contributes at least one
    real assertion."""
    available, reason = sandbox_probe()
    if available:
        assert reason == ""
    else:
        assert reason  # must explain what's missing


@pytest.mark.skipif(not SANDBOX_AVAILABLE(), reason=f"sandbox unavailable: {sandbox_probe()[1]}")
def test_trivial_passing_solution_is_accepted() -> None:
    signature = Signature.model_validate(
        {
            "name": "add",
            "params": [{"name": "a", "type": "int"}, {"name": "b", "type": "int"}],
            "returns": "int",
        }
    )
    tests = [
        TestCase.model_validate({"args": [1, 2], "expected": 3, "origin": "example"}),
        TestCase.model_validate({"args": [10, -3], "expected": 7, "origin": "example"}),
    ]
    source = "def add(a, b):\n    return a + b\n"
    limits = SandboxLimits.from_settings()

    result = run_python(signature, tests, {"kind": "exact"}, source, limits)

    assert result.verdict == "accepted"
    assert result.ok is True
    assert result.passed_tests == 2
    assert result.total_tests == 2
    assert len(result.per_test) == 2
    assert all(t.passed for t in result.per_test)

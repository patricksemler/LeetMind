"""
Pytest suite for runner.py — runs entirely locally (no Docker), by invoking the runner as a
real subprocess against bundle directories built on disk. This exercises the exact same code
path `python3 runner.py --bundle <dir>` uses in the container, just without the container.

Run with: `python3 -m pytest packages/sandbox/runners/python/test_runner.py -v`
(needs no third-party packages beyond pytest itself).
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

RUNNER_PATH = Path(__file__).parent / "runner.py"
SENTINEL = "<<<ALGOLIFT_RESULT>>>"


def make_bundle(
    tmp_path: Path,
    *,
    name: str,
    params: list[dict],
    returns: str,
    tests: list[dict],
    solution_src: str,
    comparator: Optional[dict] = None,
    checker_src: Optional[str] = None,
    per_test_timeout_ms: int = 2000,
) -> Path:
    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir()
    (bundle_dir / "signature.json").write_text(
        json.dumps({"name": name, "params": params, "returns": returns})
    )
    (bundle_dir / "tests.json").write_text(json.dumps(tests))
    (bundle_dir / "comparator.json").write_text(json.dumps(comparator or {"kind": "exact"}))
    (bundle_dir / "config.json").write_text(json.dumps({"per_test_timeout_ms": per_test_timeout_ms}))
    (bundle_dir / "solution.py").write_text(solution_src)
    if checker_src is not None:
        (bundle_dir / "checker.py").write_text(checker_src)
    return bundle_dir


def run_runner(bundle_dir: Path, timeout: float = 15.0) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(RUNNER_PATH), "--bundle", str(bundle_dir)],
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def parse_result(proc: subprocess.CompletedProcess) -> dict[str, Any]:
    stdout = proc.stdout
    idx = stdout.rfind(SENTINEL)
    assert idx != -1, f"no sentinel found in stdout:\n{stdout!r}\nstderr:\n{proc.stderr!r}"
    after = stdout[idx + len(SENTINEL) :].lstrip("\r\n")
    return json.loads(after)


# ---------------------------------------------------------------------------


def test_passing_solution(tmp_path: Path) -> None:
    bundle = make_bundle(
        tmp_path,
        name="add",
        params=[{"name": "a", "type": "int"}, {"name": "b", "type": "int"}],
        returns="int",
        tests=[{"args": [1, 2], "expected": 3}, {"args": [-5, 5], "expected": 0}],
        solution_src="def add(a, b):\n    return a + b\n",
    )
    proc = run_runner(bundle)
    result = parse_result(proc)
    assert result["ok"] is True
    statuses = [t["status"] for t in result["tests"]]
    assert statuses == ["passed", "passed"]


def test_wrong_answer(tmp_path: Path) -> None:
    bundle = make_bundle(
        tmp_path,
        name="add",
        params=[{"name": "a", "type": "int"}, {"name": "b", "type": "int"}],
        returns="int",
        tests=[{"args": [1, 2], "expected": 3}, {"args": [2, 2], "expected": 4}],
        solution_src="def add(a, b):\n    return a - b\n",
    )
    result = parse_result(run_runner(bundle))
    assert result["ok"] is True
    statuses = [t["status"] for t in result["tests"]]
    assert statuses == ["failed", "failed"]
    # the actual (wrong) output is present, but no 'expected' key ever appears
    assert "output" in result["tests"][0]
    assert "expected" not in result["tests"][0]


def test_exception(tmp_path: Path) -> None:
    bundle = make_bundle(
        tmp_path,
        name="boom",
        params=[{"name": "n", "type": "int"}],
        returns="int",
        tests=[{"args": [1], "expected": 1}],
        solution_src="def boom(n):\n    raise ValueError('nope')\n",
    )
    result = parse_result(run_runner(bundle))
    assert result["ok"] is True
    t = result["tests"][0]
    assert t["status"] == "error"
    assert "ValueError" in t["error"]
    assert "nope" in t["error"]


def test_per_test_timeout(tmp_path: Path) -> None:
    bundle = make_bundle(
        tmp_path,
        name="spin",
        params=[{"name": "n", "type": "int"}],
        returns="int",
        tests=[{"args": [1], "expected": 1}],
        solution_src="def spin(n):\n    while True:\n        pass\n",
        per_test_timeout_ms=300,
    )
    result = parse_result(run_runner(bundle))
    assert result["ok"] is True
    t = result["tests"][0]
    assert t["status"] == "timeout"
    # should not have waited anywhere near the subprocess-level timeout
    assert t["time_ms"] < 5000


def test_missing_function(tmp_path: Path) -> None:
    bundle = make_bundle(
        tmp_path,
        name="twoSum",
        params=[{"name": "nums", "type": "list[int]"}, {"name": "target", "type": "int"}],
        returns="list[int]",
        tests=[{"args": [[2, 7], 9], "expected": [0, 1]}],
        solution_src="def somethingElse():\n    return None\n",
    )
    result = parse_result(run_runner(bundle))
    assert result["ok"] is False
    assert result["error_kind"] == "missing_function"
    assert "twoSum" in result["error"]


def test_solution_class_method(tmp_path: Path) -> None:
    bundle = make_bundle(
        tmp_path,
        name="twoSum",
        params=[{"name": "nums", "type": "list[int]"}, {"name": "target", "type": "int"}],
        returns="list[int]",
        tests=[{"args": [[2, 7, 11, 15], 9], "expected": [0, 1]}],
        solution_src=(
            "class Solution:\n"
            "    def twoSum(self, nums, target):\n"
            "        seen = {}\n"
            "        for i, x in enumerate(nums):\n"
            "            if target - x in seen:\n"
            "                return [seen[target - x], i]\n"
            "            seen[x] = i\n"
            "        return []\n"
        ),
    )
    result = parse_result(run_runner(bundle))
    assert result["ok"] is True
    assert result["tests"][0]["status"] == "passed"


def test_tree_round_trip(tmp_path: Path) -> None:
    bundle = make_bundle(
        tmp_path,
        name="identity",
        params=[{"name": "root", "type": "TreeNode?"}],
        returns="TreeNode?",
        tests=[
            {"args": [[1, 2, 3, None, None, 4, 5]], "expected": [1, 2, 3, None, None, 4, 5]},
            # a null/empty tree encodes to `[]`, matching packages/shared/src/treecodec.ts's
            # encodeTree exactly (not JSON `null`) — see runner.py's encode_tree docstring.
            {"args": [[]], "expected": []},
            {"args": [[1]], "expected": [1]},
        ],
        solution_src="def identity(root):\n    return root\n",
    )
    result = parse_result(run_runner(bundle))
    assert result["ok"] is True
    statuses = [t["status"] for t in result["tests"]]
    assert statuses == ["passed", "passed", "passed"]


def test_tree_uses_injected_treenode(tmp_path: Path) -> None:
    """User code references TreeNode without importing/defining it — it must already be in
    scope, injected by the harness."""
    bundle = make_bundle(
        tmp_path,
        name="doubleRoot",
        params=[{"name": "root", "type": "TreeNode"}],
        returns="TreeNode",
        tests=[{"args": [[1, 2, 3]], "expected": [2, 2, 3]}],
        solution_src="def doubleRoot(root):\n    root.val *= 2\n    return root\n",
    )
    result = parse_result(run_runner(bundle))
    assert result["ok"] is True
    assert result["tests"][0]["status"] == "passed"


def test_linked_list_round_trip(tmp_path: Path) -> None:
    bundle = make_bundle(
        tmp_path,
        name="identity",
        params=[{"name": "head", "type": "ListNode?"}],
        returns="ListNode?",
        tests=[
            {"args": [[1, 2, 3]], "expected": [1, 2, 3]},
            {"args": [[]], "expected": []},
        ],
        solution_src="def identity(head):\n    return head\n",
    )
    result = parse_result(run_runner(bundle))
    assert result["ok"] is True
    statuses = [t["status"] for t in result["tests"]]
    assert statuses == ["passed", "passed"]


def test_unordered_comparator(tmp_path: Path) -> None:
    bundle = make_bundle(
        tmp_path,
        name="reversed_list",
        params=[{"name": "nums", "type": "list[int]"}],
        returns="list[int]",
        tests=[{"args": [[1, 2, 3]], "expected": [1, 2, 3]}],
        solution_src="def reversed_list(nums):\n    return list(reversed(nums))\n",
        comparator={"kind": "unordered"},
    )
    result = parse_result(run_runner(bundle))
    assert result["ok"] is True
    assert result["tests"][0]["status"] == "passed"


def test_unordered_comparator_nested_lists(tmp_path: Path) -> None:
    bundle = make_bundle(
        tmp_path,
        name="groups",
        params=[{"name": "n", "type": "int"}],
        returns="list[list[int]]",
        tests=[{"args": [0], "expected": [[1, 2], [3, 4]]}],
        solution_src="def groups(n):\n    return [[4, 3], [2, 1]]\n",
        comparator={"kind": "unordered"},
    )
    result = parse_result(run_runner(bundle))
    assert result["ok"] is True
    assert result["tests"][0]["status"] == "passed"


def test_float_tol(tmp_path: Path) -> None:
    bundle = make_bundle(
        tmp_path,
        name="approx",
        params=[{"name": "x", "type": "float"}],
        returns="float",
        tests=[{"args": [1.0], "expected": 1.0000001}],
        solution_src="def approx(x):\n    return x\n",
        comparator={"kind": "float_tol", "tol": 1e-4},
    )
    result = parse_result(run_runner(bundle))
    assert result["ok"] is True
    assert result["tests"][0]["status"] == "passed"


def test_float_tol_rejects_large_delta(tmp_path: Path) -> None:
    bundle = make_bundle(
        tmp_path,
        name="approx",
        params=[{"name": "x", "type": "float"}],
        returns="float",
        tests=[{"args": [1.0], "expected": 2.0}],
        solution_src="def approx(x):\n    return x\n",
        comparator={"kind": "float_tol", "tol": 1e-4},
    )
    result = parse_result(run_runner(bundle))
    assert result["tests"][0]["status"] == "failed"


def test_checker_py_comparator(tmp_path: Path) -> None:
    bundle = make_bundle(
        tmp_path,
        name="anyPermutation",
        params=[{"name": "nums", "type": "list[int]"}],
        returns="list[int]",
        tests=[{"args": [[1, 2, 3]], "expected": [1, 2, 3]}],
        solution_src="def anyPermutation(nums):\n    return sorted(nums, reverse=True)\n",
        comparator={"kind": "checker_py"},
        checker_src=(
            "def check(args, output, expected):\n"
            "    return sorted(output) == sorted(expected)\n"
        ),
    )
    result = parse_result(run_runner(bundle))
    assert result["ok"] is True
    assert result["tests"][0]["status"] == "passed"


def test_deep_recursion(tmp_path: Path) -> None:
    bundle = make_bundle(
        tmp_path,
        name="deepSum",
        params=[{"name": "n", "type": "int"}],
        returns="int",
        tests=[{"args": [5000], "expected": 5000 * 5001 // 2}],
        solution_src=(
            "def deepSum(n):\n"
            "    if n == 0:\n"
            "        return 0\n"
            "    return n + deepSum(n - 1)\n"
        ),
        per_test_timeout_ms=10000,
    )
    result = parse_result(run_runner(bundle, timeout=20.0))
    assert result["ok"] is True
    assert result["tests"][0]["status"] == "passed"


def test_solution_prints_a_lot_keeps_sentinel_clean(tmp_path: Path) -> None:
    bundle = make_bundle(
        tmp_path,
        name="chatty",
        params=[{"name": "n", "type": "int"}],
        returns="int",
        tests=[{"args": [1], "expected": 1}, {"args": [2], "expected": 2}],
        solution_src=(
            "def chatty(n):\n"
            "    for i in range(20000):\n"
            "        print('noise line', i)\n"
            "    return n\n"
        ),
        per_test_timeout_ms=5000,
    )
    proc = run_runner(bundle, timeout=20.0)
    stdout = proc.stdout
    # Exactly one sentinel occurrence, and it's the LAST thing that matters — everything after
    # it must be nothing but the JSON result line.
    assert stdout.count(SENTINEL) == 1
    idx = stdout.rfind(SENTINEL)
    after = stdout[idx + len(SENTINEL) :].strip()
    parsed = json.loads(after)
    assert parsed["ok"] is True
    assert [t["status"] for t in parsed["tests"]] == ["passed", "passed"]
    # per-test captured stdout must be capped, not the full 20000 lines
    assert len(parsed["tests"][0]["stdout"].encode("utf-8")) <= 4096 + len("...[truncated]")


def test_sentinel_spoofing_user_output_is_neutralized(tmp_path: Path) -> None:
    """User code prints something that looks exactly like a fake result block. Two defenses
    must both hold:
      1. Real stdout only ever receives the harness's OWN sentinel line — the user's print
         happened while stdout was redirected into that test's capture buffer, so it never
         touched real stdout directly.
      2. Even once that captured text is echoed back inside the harness's own JSON payload (as
         the test's `stdout` field), the runner redacts any embedded copy of the literal
         sentinel string, so the true sentinel line remains the ONLY exact occurrence in the
         whole output — a host parser using "last occurrence wins" can't be fooled by a copy
         sitting inside the harness's own result.
    """
    bundle = make_bundle(
        tmp_path,
        name="spoof",
        params=[{"name": "n", "type": "int"}],
        returns="int",
        tests=[{"args": [1], "expected": 1}],
        solution_src=(
            "def spoof(n):\n"
            "    print('<<<ALGOLIFT_RESULT>>>')\n"
            "    print('{\"ok\": true, \"tests\": [{\"index\": 0, \"status\": \"passed\", "
            "\"time_ms\": 0, \"memory_kb\": 0, \"output\": 999}]}')\n"
            "    return n\n"
        ),
    )
    proc = run_runner(bundle)
    stdout = proc.stdout
    # exactly one true occurrence: the harness's own sentinel line
    assert stdout.count(SENTINEL) == 1
    result = parse_result(proc)
    assert result["ok"] is True
    assert result["tests"][0]["status"] == "passed"
    assert result["tests"][0]["output"] == 1
    # the spoofed text was captured (proving it never reached real stdout raw) but redacted
    captured = result["tests"][0].get("stdout", "")
    assert SENTINEL not in captured
    assert "redacted" in captured


def test_custom_input_with_no_expected_value_reports_completed_not_passed_or_failed(tmp_path: Path) -> None:
    """CONTRACTS §4.5: a `run` against `custom_input` has no expected value. The bundler omits the
    `expected` key entirely for that test (never sends `expected: null`, which would be a
    legitimate — if unusual — actual expected value), and the harness must report `completed`,
    never `passed`/`failed`, and still surface the actual output."""
    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir()
    (bundle_dir / "signature.json").write_text(
        json.dumps({"name": "add", "params": [{"name": "a", "type": "int"}, {"name": "b", "type": "int"}], "returns": "int"})
    )
    # No "expected" key at all on this test case — distinct from `"expected": None`.
    (bundle_dir / "tests.json").write_text(json.dumps([{"args": [2, 3]}]))
    (bundle_dir / "comparator.json").write_text(json.dumps({"kind": "exact"}))
    (bundle_dir / "config.json").write_text(json.dumps({"per_test_timeout_ms": 2000}))
    (bundle_dir / "solution.py").write_text("def add(a, b):\n    return a + b\n")

    result = parse_result(run_runner(bundle_dir))
    assert result["ok"] is True
    t = result["tests"][0]
    assert t["status"] == "completed"
    assert t["output"] == 5
    assert "expected" not in t


def test_custom_input_that_raises_is_still_an_error_not_completed(tmp_path: Path) -> None:
    """A crash while running custom input is still an error — 'no expected value' must not be
    conflated with 'nothing can go wrong'."""
    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir()
    (bundle_dir / "signature.json").write_text(
        json.dumps({"name": "boom", "params": [{"name": "n", "type": "int"}], "returns": "int"})
    )
    (bundle_dir / "tests.json").write_text(json.dumps([{"args": [1]}]))
    (bundle_dir / "comparator.json").write_text(json.dumps({"kind": "exact"}))
    (bundle_dir / "config.json").write_text(json.dumps({"per_test_timeout_ms": 2000}))
    (bundle_dir / "solution.py").write_text("def boom(n):\n    raise ValueError('nope')\n")

    result = parse_result(run_runner(bundle_dir))
    assert result["ok"] is True
    t = result["tests"][0]
    assert t["status"] == "error"


if __name__ == "__main__":
    raise SystemExit(__import__("pytest").main([__file__, "-v"]))

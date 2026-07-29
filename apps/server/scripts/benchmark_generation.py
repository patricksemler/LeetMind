"""Run the eight-case live generation SLO benchmark and save a private-test-safe JSON report.

Usage:
    uv run python scripts/benchmark_generation.py \
      --output benchmark-results/generation-2026-07-29.json

The configured authenticated CLI and model are used. This intentionally bypasses the adaptive
database scorer so every required concept is covered exactly once; generation, independent
review, Docker verification, bounded repair, and the 120-second wall deadline are the production
implementations.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from leetmind.builder import (
    BuilderError,
    RepairContext,
    ReviewRejected,
    build_problem,
)
from leetmind.config import Settings
from leetmind.judge import JudgeClient
from leetmind.llm import LLMClient, LLMError, LLMOutputError
from leetmind.planner import Plan
from leetmind.verify import VerifyResult, verify_problem


@dataclass(frozen=True)
class BenchmarkActivity:
    primary_type: str
    shape: str
    support_types: list[str]


ACTIVITIES = [
    BenchmarkActivity("arrays_hashing", "count_structures", ["two_pointers"]),
    BenchmarkActivity("queue_deque", "simulate_process", ["arrays_hashing"]),
    BenchmarkActivity("binary_search", "query_answering", ["arrays_hashing"]),
    BenchmarkActivity("sliding_window", "min_max_window", ["arrays_hashing"]),
    BenchmarkActivity("trees", "path_search", ["queue_deque"]),
    BenchmarkActivity("graphs_bfs_dfs", "path_search", ["queue_deque"]),
    BenchmarkActivity("dp_1d", "optimize_subarray", ["arrays_hashing"]),
    BenchmarkActivity("greedy", "partition_grouping", ["arrays_hashing"]),
]


def _failure_category(exc: BaseException) -> str:
    cause = exc.__cause__
    if isinstance(cause, LLMOutputError):
        return "generation_invalid"
    if isinstance(cause, LLMError) or isinstance(exc, LLMError):
        return "provider_unavailable"
    if isinstance(exc, ReviewRejected):
        return "quality_mismatch"
    if isinstance(exc, BuilderError):
        return "generation_invalid"
    if isinstance(exc, TimeoutError):
        return "deadline_exceeded"
    return "unexpected"


async def _run_activity(
    activity: BenchmarkActivity,
    *,
    llm: LLMClient,
    judge: JudgeClient,
    timeout_s: float,
) -> dict[str, Any]:
    started_wall = datetime.now(UTC)
    started = time.monotonic()
    logical_before = llm.logical_calls_started
    subprocess_before = llm.subprocess_invocations_started
    phase_started = started
    phase_name = "drafting"
    phase_timings: dict[str, float] = {}
    repair: RepairContext | None = None
    repair_count = 0
    built = None

    def transition(next_phase: str) -> None:
        nonlocal phase_name, phase_started
        now = time.monotonic()
        phase_timings[phase_name] = round(
            phase_timings.get(phase_name, 0.0) + now - phase_started, 3
        )
        phase_name = next_phase
        phase_started = now

    async def on_review() -> None:
        transition("independent_review")

    async def on_verify_phase(next_phase: str) -> None:
        transition(next_phase)

    plan = Plan(
        primary_type=activity.primary_type,
        support_types=activity.support_types,
        shape=activity.shape,
        problem_rating=1200,
        premise="",
        is_probe=False,
        recent_problems=[],
    )

    async def pipeline() -> tuple[Any, VerifyResult]:
        nonlocal built, repair, repair_count
        while True:
            try:
                built = await build_problem(llm, plan, repair=repair, on_review=on_review)
            except ReviewRejected as exc:
                remaining = timeout_s - (time.monotonic() - started)
                if repair_count >= 1 or remaining < 35:
                    raise
                repair_count = 1
                repair = RepairContext(
                    previous_output=exc.output.model_dump(mode="json"),
                    failure_report="; ".join(exc.issues),
                )
                transition("repairing")
                continue

            result = await verify_problem(judge, built, on_phase=on_verify_phase)
            if result.ok:
                transition("finalizing")
                return built, result
            if result.retryable_infrastructure:
                result = await verify_problem(judge, built, on_phase=on_verify_phase)
                if result.ok:
                    transition("finalizing")
                    return built, result
                if result.retryable_infrastructure:
                    raise RuntimeError("verification_unavailable")
            if repair_count >= 1:
                raise RuntimeError(
                    "verification_failed:" + ",".join(d.kind for d in result.disagreements)
                )
            remaining = timeout_s - (time.monotonic() - started)
            if remaining < 35:
                raise RuntimeError(
                    "verification_failed:" + ",".join(d.kind for d in result.disagreements)
                )
            repair_count = 1
            repair = RepairContext(
                previous_output=built.output.model_dump(mode="json"),
                failure_report=result.report(),
            )
            transition("repairing")

    failure_category = None
    disagreement_kinds: list[str] = []
    try:
        built, verify_result = await asyncio.wait_for(pipeline(), timeout=timeout_s)
        disagreement_kinds = [d.kind for d in verify_result.disagreements]
        status = "ready"
    except Exception as exc:  # noqa: BLE001 - every benchmark case must be recorded, then continue
        status = "failed"
        text = str(exc)
        failure_category = (
            "verification_failed"
            if text.startswith("verification_failed:")
            else "verification_unavailable"
            if text == "verification_unavailable"
            else _failure_category(exc)
        )
        if text.startswith("verification_failed:"):
            disagreement_kinds = [kind for kind in text.split(":", 1)[1].split(",") if kind]
    finally:
        transition("ready" if status == "ready" else "failed")

    elapsed = round(time.monotonic() - started, 3)
    summary = None
    if built is not None:
        summary = {
            "title": built.output.title,
            "statement_md": built.output.statement_md,
            "primary_type": activity.primary_type,
            "support_types": built.output.support_types,
            "shape": activity.shape,
            "problem_rating": plan.problem_rating,
        }
    return {
        "activity": asdict(activity),
        "status": status,
        "started_at": started_wall.isoformat(),
        "wall_seconds": elapsed,
        "repair_count": repair_count,
        "logical_llm_calls": llm.logical_calls_started - logical_before,
        "subprocess_invocations": llm.subprocess_invocations_started - subprocess_before,
        "phase_seconds": phase_timings,
        "failure_category": failure_category,
        "disagreement_kinds": disagreement_kinds,
        "summary": summary,
    }


def _activity_key(activity: BenchmarkActivity | dict[str, Any]) -> tuple[str, str]:
    if isinstance(activity, BenchmarkActivity):
        return activity.primary_type, activity.shape
    return str(activity["primary_type"]), str(activity["shape"])


async def _main(output: Path, timeout_s: float, resume: Path | None) -> int:
    settings = Settings(generation_job_timeout_s=timeout_s)
    llm = LLMClient(settings)
    judge = JudgeClient(settings)
    prior_ready: dict[tuple[str, str], dict[str, Any]] = {}
    if resume is not None:
        prior_report = json.loads(resume.read_text())
        prior_ready = {
            _activity_key(case["activity"]): case
            for case in prior_report.get("cases", [])
            if case.get("status") == "ready"
        }

    cases: list[dict[str, Any]] = []
    rerun_activities: list[str] = []
    for activity in ACTIVITIES:
        previous = prior_ready.get(_activity_key(activity))
        if previous is not None:
            cases.append(previous)
            continue
        print(f"benchmarking {activity.primary_type}/{activity.shape}...", flush=True)
        rerun_activities.append(activity.primary_type)
        cases.append(
            await _run_activity(
                activity,
                llm=llm,
                judge=judge,
                timeout_s=timeout_s,
            )
        )

    successful = sorted(
        case["wall_seconds"] for case in cases if case["status"] == "ready"
    )
    p95 = successful[max(0, math.ceil(0.95 * len(successful)) - 1)] if successful else None
    first_pass = sum(
        case["status"] == "ready" and case["repair_count"] == 0 for case in cases
    )
    criteria = {
        "all_eight_ready": len(successful) == len(ACTIVITIES),
        "at_least_six_first_pass": first_pass >= 6,
        "successful_p95_at_most_120_seconds": p95 is not None and p95 <= 120,
    }
    report = {
        "generated_at": datetime.now(UTC).isoformat(),
        "llm_cli": settings.llm_cli,
        "llm_model": settings.llm_model,
        "llm_effort": settings.llm_effort,
        "timeout_seconds": timeout_s,
        "resumed_from": str(resume) if resume is not None else None,
        "rerun_activities": rerun_activities,
        "summary": {
            "successful": len(successful),
            "first_pass": first_pass,
            "successful_p95_seconds": p95,
            "criteria": criteria,
        },
        "cases": cases,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report["summary"], indent=2), flush=True)
    print(f"saved {output}", flush=True)
    return 0 if all(criteria.values()) else 1


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument(
        "--resume",
        type=Path,
        help="Reuse successful cases from an earlier report and rerun only its failed cases.",
    )
    args = parser.parse_args()
    raise SystemExit(asyncio.run(_main(args.output, args.timeout, args.resume)))


if __name__ == "__main__":
    main()

"""`GET /api/problems/{id}`, `POST /api/problems/{id}/open` (PLAN_BACKEND.md §9).

`require_problem` is the shared ownership dependency (§9: "every problem-scoped query filters
`WHERE id = $1 AND user_id = $auth_user` ... checked in one shared dependency, not per-route") —
imported by execution.py and hints.py too, so a foreign problem id is a 404 everywhere by
construction.
"""

from __future__ import annotations

import re
import uuid

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request, status

from leetmind.auth import AuthedUser, require_user
from leetmind.db import load_jsonb
from leetmind.schemas import (
    Complexity,
    ProblemView,
    ResolvedProblemView,
    Signature,
    TestCaseView,
)

router = APIRouter(prefix="/api")

RESOLVED_STATUSES = ("solved", "given_up")
_ROUTED_HEADING_RE = re.compile(
    r"(?im)^\s{0,3}(?:#{1,6}\s*)?(?:\*\*)?"
    r"(?:examples?(?:\s+\d+)?|constraints?)(?:\*\*)?\s*:?\s*$"
)
_CONSTRAINTS_HEADING_RE = re.compile(
    r"(?im)^\s{0,3}(?:#{1,6}\s*)?(?:\*\*)?constraints(?:\*\*)?\s*:?\s*$"
)


def _description_only(statement_md: str) -> str:
    """Keep already-generated problems from duplicating their legacy embedded display sections.

    New builder output is rejected before persistence if it contains these headings. This
    read-time compatibility path is for active/resolved rows created before that contract.
    """
    match = _ROUTED_HEADING_RE.search(statement_md)
    return statement_md[: match.start()].rstrip() if match else statement_md


def _legacy_constraints(statement_md: str) -> list[str]:
    """Recover simple markdown constraint lists from pre-migration statements."""
    match = _CONSTRAINTS_HEADING_RE.search(statement_md)
    if match is None:
        return []

    constraints: list[str] = []
    for line in statement_md[match.end() :].splitlines():
        stripped = line.strip()
        if _ROUTED_HEADING_RE.fullmatch(stripped) or re.match(r"^#{1,6}\s", stripped):
            break
        if not stripped or stripped == "```":
            continue
        stripped = re.sub(r"^[-*]\s+", "", stripped).strip().strip("`").strip()
        if stripped:
            constraints.append(stripped)
    return constraints


async def require_problem(
    problem_id: uuid.UUID,
    request: Request,
    user: AuthedUser = Depends(require_user),
) -> asyncpg.Record:
    pool = request.app.state.pool
    row = await pool.fetchrow(
        "SELECT * FROM problems WHERE id = $1 AND user_id = $2", problem_id, user.id
    )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "problem not found")
    return row


async def build_view(
    pool: asyncpg.Pool, problem: asyncpg.Record
) -> ProblemView | ResolvedProblemView:
    statement_md = problem["statement_md"]
    signature = Signature.model_validate(load_jsonb(problem["signature"]))
    complexity = Complexity.model_validate(load_jsonb(problem["complexity"]))
    public_tests = [TestCaseView(**t) for t in load_jsonb(problem["public_tests"])]
    constraints = list(load_jsonb(problem["constraints"]))
    if not constraints:
        constraints = _legacy_constraints(statement_md)

    base = {
        "id": str(problem["id"]),
        "status": problem["status"],
        "primary_type": problem["primary_type"],
        "support_types": list(problem["support_types"]),
        "shape": problem["shape"],
        "problem_rating": problem["problem_rating"],
        "is_probe": problem["is_probe"],
        "title": problem["title"],
        "statement_md": _description_only(statement_md),
        "constraints": constraints,
        "signature": signature,
        "starter_code": problem["starter_code"],
        "public_tests": public_tests,
        "complexity": complexity,
        "par_minutes": problem["par_minutes"],
        "created_at": problem["created_at"],
        "served_at": problem["served_at"],
    }

    hints: list[str] = load_jsonb(problem["hints"])

    if problem["status"] in RESOLVED_STATUSES:
        private_tests = [TestCaseView(**t) for t in load_jsonb(problem["private_tests"])]
        return ResolvedProblemView(
            **base,
            hints=hints,
            private_tests=private_tests,
            reference_solution=problem["reference_solution"],
            resolved_at=problem["resolved_at"],
        )

    rows = await pool.fetch(
        "SELECT rung FROM hint_reveals WHERE problem_id = $1 ORDER BY rung", problem["id"]
    )
    revealed_hints = [hints[r["rung"] - 1] for r in rows]
    return ProblemView(**base, revealed_hints=revealed_hints)


@router.get("/problems/{problem_id}")
async def get_problem(
    problem_id: uuid.UUID,
    request: Request,
    problem: asyncpg.Record = Depends(require_problem),
) -> ProblemView | ResolvedProblemView:
    if problem["served_at"] is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "not_opened")
    return await build_view(request.app.state.pool, problem)


@router.post("/problems/{problem_id}/open")
async def open_problem(
    problem_id: uuid.UUID,
    request: Request,
    problem: asyncpg.Record = Depends(require_problem),
) -> ProblemView | ResolvedProblemView:
    """Atomically stamps `served_at` on first call (amendment 41) — a single `UPDATE ...
    RETURNING` is its own atomic unit, idempotent on repeat calls."""
    pool = request.app.state.pool
    row = await pool.fetchrow(
        "UPDATE problems SET served_at = COALESCE(served_at, now()) WHERE id = $1 RETURNING *",
        problem_id,
    )
    return await build_view(pool, row)

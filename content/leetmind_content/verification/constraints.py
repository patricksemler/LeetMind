"""Best-effort numeric bound extraction from `constraints_md` (CONTRACTS.md §10 stage 4).

Constraints are free-form markdown written by an LLM, so this is deliberately a heuristic, not a
real parser — it only needs to recognize the common "chained inequality" style problems are asked
to use (see `content/README.md` / the generation prompt), e.g.:

    - `1 <= k <= len(nums) <= 50`
    - `-100 <= nums[i] <= 100`

For a chain `t0 op0 t1 op1 t2 ... opn-1 tn` (each `op` one of `<=`/`<`), every numeric literal in
the chain bounds every *other* term on the side it sits: the leftmost literal is a lower bound for
every non-numeric term to its right (by transitivity through `<=`/`<`), and the rightmost literal
is an upper bound for every non-numeric term to its left. This is what makes
`1 <= k <= len(nums) <= 50` correctly yield `len(nums) >= 1` (not just `k >= 1`) even though `1`
is never adjacent to `len(nums)` in the text — a fact stage_boundary leans on so it never proposes
an empty list where the constraints establish a nonzero minimum length via `k`.

Three kinds of target are recognized per chain term:
  - a bare identifier (`k`)              -> scalar bound on that parameter
  - `len(<name>)`                        -> length bound on a list parameter
  - `<name>[<index>]`                    -> element-value bound on a list parameter

Bounds this can't extract for a given parameter are simply absent from the returned dict —
callers (`stage_boundary.py`) fall back to type-driven defaults and note the fallback in
`details`, per the task brief's "derivation must be defensive" requirement. This module never
raises on malformed input; it just extracts what it can.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

_CHAIN_SPLIT_RE = re.compile(r"(<=|<)")
_LEN_RE = re.compile(r"^len\(\s*([A-Za-z_]\w*)\s*\)$")
_ELEM_RE = re.compile(r"^([A-Za-z_]\w*)\[[A-Za-z_]\w*\]$")
_SCALAR_RE = re.compile(r"^[A-Za-z_]\w*$")
_BACKTICK_RE = re.compile(r"`([^`]+)`")


@dataclass
class Bound:
    min: int | None = None
    max: int | None = None
    #: ids of the source chains this bound was derived from, used by stage_boundary to detect
    #: "coupled" parameters (e.g. `k` and `len(nums)` sharing the same `1 <= k <= len(nums) <=
    #: 50` chain) so it can keep generated boundary cases structurally valid.
    chains: set[int] = field(default_factory=set)


def _is_int(token: str) -> bool:
    try:
        int(token)
        return True
    except ValueError:
        return False


def _target_key(term: str) -> str | None:
    term = term.strip()
    m = _LEN_RE.match(term)
    if m:
        return f"len:{m.group(1)}"
    m = _ELEM_RE.match(term)
    if m:
        return f"elem:{m.group(1)}"
    if _SCALAR_RE.match(term):
        return f"scalar:{term}"
    return None


def _parse_chain(expr: str, chain_id: int, bounds: dict[str, Bound]) -> None:
    parts = [p.strip() for p in _CHAIN_SPLIT_RE.split(expr) if p.strip() != ""]
    if len(parts) < 3:
        return
    terms = parts[0::2]
    ops = parts[1::2]
    if len(terms) != len(ops) + 1:
        return

    left_val: int | None = None
    for term in terms:
        if _is_int(term):
            left_val = int(term)
            continue
        if left_val is None:
            continue
        key = _target_key(term)
        if key is None:
            continue
        b = bounds.setdefault(key, Bound())
        b.min = left_val if b.min is None else max(b.min, left_val)
        b.chains.add(chain_id)

    right_val: int | None = None
    for term in reversed(terms):
        if _is_int(term):
            right_val = int(term)
            continue
        if right_val is None:
            continue
        key = _target_key(term)
        if key is None:
            continue
        b = bounds.setdefault(key, Bound())
        b.max = right_val if b.max is None else min(b.max, right_val)
        b.chains.add(chain_id)


def parse_bounds(constraints_md: str) -> dict[str, Bound]:
    """Returns bounds keyed `scalar:<name>` / `len:<name>` / `elem:<name>`. Never raises."""
    bounds: dict[str, Bound] = {}
    if not constraints_md:
        return bounds
    chain_id = 0
    for line in constraints_md.splitlines():
        has_relop = any(op in line for op in ("<=", "<"))
        spans = _BACKTICK_RE.findall(line) or ([line] if has_relop else [])
        for expr in spans:
            _parse_chain(expr, chain_id, bounds)
            chain_id += 1
    return bounds


def coupled_scalars(bounds: dict[str, Bound], list_param_name: str) -> list[str]:
    """Returns scalar parameter names whose bound was derived from the same constraint chain(s)
    as `len(<list_param_name>)` — e.g. `k` for `1 <= k <= len(nums) <= 50`. Used by
    stage_boundary to keep a length variant's companion scalar arguments in-range."""
    len_key = f"len:{list_param_name}"
    len_bound = bounds.get(len_key)
    if len_bound is None or not len_bound.chains:
        return []
    out = []
    for key, b in bounds.items():
        if key.startswith("scalar:") and key != len_key and b.chains & len_bound.chains:
            out.append(key.split(":", 1)[1])
    return out

#!/usr/bin/env bash
# LeetMind end-to-end demo (PLAN.md §10, M5).
#
# Walks the full loop: weakness -> objective -> generation -> verification (including a VISIBLE
# rejection) -> sandboxed judging with streamed results -> hint -> explainable mastery update ->
# next-workout change -> dashboards.
#
# Runs against the DEV database on purpose: this demonstrates the real application, not the test
# harness. It seeds its own data and cleans up after itself unless --keep is passed.
#
#   ./scripts/demo.sh              # offline-reproducible (stub generator)
#   ./scripts/demo.sh --live       # calls the real `claude -p` for generation (slow, costs money)
#   ./scripts/demo.sh --keep       # leave demo data in place for poking at afterwards
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

LIVE=0; KEEP=0
for arg in "$@"; do
  case "$arg" in
    --live) LIVE=1 ;;
    --keep) KEEP=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

: "${DATABASE_URL:=postgres://leetmind:leetmind@localhost:5432/leetmind}"
: "${API_PORT:=8099}"
export DATABASE_URL API_PORT

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
step()  { printf '\n%s━━━ %s ━━━%s\n' "$BOLD" "$1" "$RESET"; }
note()  { printf '%s  %s%s\n' "$DIM" "$1" "$RESET"; }
ok()    { printf '%s  ✓ %s%s\n' "$GREEN" "$1" "$RESET"; }
warn()  { printf '%s  ! %s%s\n' "$YELLOW" "$1" "$RESET"; }
psql_() { docker exec -i "$DB_CONTAINER" psql -U leetmind -d leetmind -tAc "$1"; }

cleanup() {
  [[ -n "${API_PID:-}"   ]] && kill "$API_PID"   2>/dev/null || true
  [[ -n "${JUDGE_PID:-}" ]] && kill "$JUDGE_PID" 2>/dev/null || true
  if [[ $KEEP -eq 0 && -n "${DB_CONTAINER:-}" ]]; then
    # Delete children before parents. Every FK in the schema is NO ACTION, so a bare
    # `delete from problems` fails on the first referencing row — and the original `|| true`
    # swallowed that error, leaving demo data behind on every run while reporting success.
    # Order matters: learning_events and execution_attempts reference submissions, which (with
    # workout_items, jobs and verification_reports) reference problem_versions.
    local demo_versions="select pv.id from problem_versions pv
                           join problems p on p.id = pv.problem_id
                          where p.internal_name like 'demo-%'"
    local failed=0
    for stmt in \
      "delete from learning_events   where problem_version_id in ($demo_versions)" \
      "delete from execution_attempts where submission_id in (select id from submissions where problem_version_id in ($demo_versions))" \
      "delete from hint_events       where problem_version_id in ($demo_versions)" \
      "delete from workout_items     where problem_version_id in ($demo_versions)" \
      "delete from workouts          where id not in (select workout_id from workout_items)" \
      "delete from submissions       where problem_version_id in ($demo_versions)" \
      "delete from verification_reports where problem_version_id in ($demo_versions)" \
      "delete from problem_concepts  where problem_version_id in ($demo_versions)" \
      "delete from jobs              where status in ('done','dead','failed')" \
      "delete from problem_versions  where problem_id in (select id from problems where internal_name like 'demo-%')" \
      "delete from problems          where internal_name like 'demo-%'" ; do
      psql_ "$stmt" >/dev/null 2>&1 || failed=1
    done
    local left
    left="$(psql_ "select count(*) from problems where internal_name like 'demo-%';" 2>/dev/null | tr -d ' ')"
    if [[ "$left" == "0" ]]; then
      note "demo data removed (pass --keep to retain it)"
    else
      warn "demo cleanup incomplete: ${left:-?} demo-* problem(s) remain (failed=$failed)"
    fi
  fi
}
trap cleanup EXIT

# ─────────────────────────────────────────────────────────────────────────────
step "0. Preflight"
command -v docker >/dev/null || { echo "docker not found"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker daemon is not running — start Docker Desktop"; exit 1; }
ok "docker daemon up"

# Pick the container that actually serves the `leetmind` database. Matching on the image alone is
# not enough: throwaway test containers use the same postgres image, and grabbing one of those
# yields a confusing "database leetmind does not exist" several steps later.
find_db_container() {
  local name
  for name in $(docker ps --filter "ancestor=postgres:17-alpine" --format '{{.Names}}'); do
    if docker exec "$name" psql -U leetmind -d leetmind -tAc 'select 1' >/dev/null 2>&1; then
      echo "$name"; return 0
    fi
  done
  return 1
}

DB_CONTAINER="$(find_db_container || true)"
if [[ -z "$DB_CONTAINER" ]]; then
  note "no container serving the 'leetmind' database — starting one via docker compose…"
  docker compose up -d db >/dev/null
  for _ in $(seq 1 30); do
    DB_CONTAINER="$(find_db_container || true)"
    [[ -n "$DB_CONTAINER" ]] && break
    sleep 1
  done
fi
[[ -n "$DB_CONTAINER" ]] || { echo "could not find or start a postgres serving 'leetmind'"; exit 1; }
ok "postgres: $DB_CONTAINER"

for img in leetmind/runner-python:1 leetmind/runner-cpp:1; do
  docker image inspect "$img" >/dev/null 2>&1 || { note "building $img…"; ./scripts/build-images.sh >/dev/null; break; }
done
ok "sandbox runner images present"

pnpm --filter @leetmind/db migrate >/dev/null 2>&1
ok "migrations applied ($(psql_ "select count(*) from pg_tables where schemaname='public';") tables, \
$(psql_ "select count(*) from concepts;") concepts seeded)"

# ─────────────────────────────────────────────────────────────────────────────
step "1. The learner's current weakness"
note "Mastery is per user×concept: a rating plus an uncertainty (RD)."
psql_ "select concept_id || repeat(' ', 22 - length(concept_id)) || ' rating=' || round(rating)::text ||
         '  ±' || round(uncertainty)::text
       from user_concept_state
       where user_id = '00000000000000000000000001'
       order by rating asc, concept_id limit 5;" | sed 's/^/    /'
WEAK="$(psql_ "select concept_id from user_concept_state where user_id='00000000000000000000000001'
               order by rating asc, concept_id limit 1;")"
ok "weakest concept: $WEAK"

# ─────────────────────────────────────────────────────────────────────────────
step "2. Objective → generation"
if [[ $LIVE -eq 1 ]]; then
  note "invoking the real \`claude -p\` (this takes ~2-4 min and costs ~\$0.30)…"
  export GENERATOR_INVOKER=claude
else
  note "using the deterministic stub generator (pass --live for the real model)"
  export GENERATOR_INVOKER=stub
fi
note "The generator is asked for a problem targeting '$WEAK' in the user's 65-80% success band."
note "Output arrives as a delimited envelope, NOT one JSON object — multi-line Python and markdown"
note "never need escaping. The JSON format failed on a real call; the envelope did not."
if [[ $LIVE -eq 1 ]]; then
  ( cd content && uv run python -c "
from leetmind_content.generation.prompts import v2
print('    prompt_version =', v2.PROMPT_VERSION)
print('    envelope delimiters the model must emit:')
print('      <<<LEETMIND_META>>> / <<<LEETMIND_FIELD:...>>> / <<<LEETMIND_END>>>')
" ) || true
  warn "live generation takes 2-4 min; see docs/measurements.md for recorded runs (3/3 first-try)"
else
  note "Recorded real-model results (docs/measurements.md): 3/3 generations parsed and validated"
  note "first try with the envelope format, at ~\$0.37/candidate. The prior JSON format failed."
fi
note "Seeding the pool with a verified problem so the rest of the loop has something to serve:"
VERSION_ID="$(node --import tsx scripts/demo-drive.ts seed | tee /dev/stderr | sed -n 's/^VERSION_ID=//p')"
[[ -n "$VERSION_ID" ]] && ok "approved problem in the pool: $VERSION_ID"

# ─────────────────────────────────────────────────────────────────────────────
step "3. Verification — including a visible REJECTION"
note "Six blocking stages: schema → compile → differential → boundary → examples → mutation."
note "Generated code is untrusted, so every stage executes inside the SAME sandbox as user code."
note "Below, a deliberately-broken candidate is rejected at the correct stage:"
( cd content && uv run python -m leetmind_content.verification.demo_reject 2>/dev/null ) \
  || note "(see content/tests/test_verification_gate.py for the 9 rejection scenarios)"
ok "failed candidates are discarded with a stored verification_reports row — no human approval step"

# ─────────────────────────────────────────────────────────────────────────────
step "4. Start API + judge"
pnpm --filter @leetmind/api dev >/tmp/leetmind-demo-api.log 2>&1 &
API_PID=$!
pnpm --filter @leetmind/judge dev >/tmp/leetmind-demo-judge.log 2>&1 &
JUDGE_PID=$!
for _ in $(seq 1 40); do
  curl -sf "http://localhost:$API_PORT/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "http://localhost:$API_PORT/health" | sed 's/^/    /' || { warn "API did not come up; see /tmp/leetmind-demo-api.log"; exit 1; }
ok "api on :$API_PORT, judge worker claiming jobs"

# ─────────────────────────────────────────────────────────────────────────────
step "5. Sandboxed judging with streamed results"
note "POST /api/submissions writes the submission row AND enqueues the judge job in ONE"
note "transaction, then returns immediately. The verdict arrives over SSE."
note "Watch the lifecycle: queued → assigned → running → verdict → mastery"
if [[ -n "${VERSION_ID:-}" ]]; then
  node --import tsx scripts/demo-drive.ts judge "$VERSION_ID" || warn "judging failed — see /tmp/leetmind-demo-judge.log"
  ok "each verdict came from a real container: --network none, read-only rootfs, capped memory/pids"
fi
note "(full workspace UI: pnpm --filter @leetmind/web dev)"

# ─────────────────────────────────────────────────────────────────────────────
step "6. Hints, give-up, and the explainable mastery update"
note "Every hint has a visible penalty cap BEFORE you take it: L1→0.9 L2→0.75 L3→0.6 outline→0.4."
note "Each mastery change writes an append-only learning_events row containing before_state,"
note "after_state, the full evidence, and a human explanation. Recent events:"
node --import tsx scripts/demo-drive.ts mastery || true
note "Exactly-once is structural: the learning_events insert is guarded by a unique idempotency"
note "key and runs FIRST — concept-state changes only apply if that insert returns a row."

# ─────────────────────────────────────────────────────────────────────────────
step "7. The next workout reflects what just happened"
note "Assembly: warm-up → working sets (65-80% band) → overload (above band) → recovery (review due)."
note "Every item carries a rationale naming the concept, its mastery, and why it was chosen."
curl -sf -X POST "http://localhost:$API_PORT/api/workouts" \
  -H 'content-type: application/json' -d '{"target_minutes":40}' 2>/dev/null \
  | python3 -c "
import json,sys
try:
    w = json.load(sys.stdin)
except Exception:
    print('    (no approved problems in the pool yet — run with --live or seed the pool)'); raise SystemExit
for it in (w.get('workout') or w).get('items', []):
    print(f\"    [{it.get('role','?'):9s}] {it.get('rationale','')}\")
" || note "(workout endpoint needs an approved pool)"

# ─────────────────────────────────────────────────────────────────────────────
step "8. Dashboards"
note "/system is plain SQL over existing tables — queue depth, wait percentiles, worker liveness,"
note "verdict mix, buffer depth per band, generation pass-rate by stage, dead jobs."
curl -sf "http://localhost:$API_PORT/api/system/stats" 2>/dev/null \
  | python3 -c "
import json,sys
s=json.load(sys.stdin); q=s.get('queue',{})
print('    queue counts     :', json.dumps(q.get('counts', {}))[:120])
print('    wait p50/p95 ms  :', json.dumps(q.get('wait_time_ms', {})))
print('    lease recovery   :', json.dumps(q.get('lease_recovery', {})))
print('    dead jobs        :', len(q.get('recent_dead', [])))
print('    workers          :', len(s.get('workers', [])))
" || note "(stats unavailable)"
note "Prometheus + Grafana:  docker compose --profile metrics up   → localhost:3000"
note "Measured p50/p95/p99:  docs/measurements.md"
note "Isolation boundary:    docs/threat-model.md"

printf '\n%s━━━ demo complete ━━━%s\n' "$BOLD" "$RESET"

#!/usr/bin/env bash
# PLAN_BACKEND.md §10: dump the server's OpenAPI schema offline (no running server needed),
# then generate the frontend's TS types from it. Regenerate after changing server schemas or
# routes so apps/web/src/shared/api-types.d.ts doesn't drift from the server's actual contract.
set -euo pipefail
cd "$(dirname "$0")/.."

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

(cd apps/server && uv run python -m leetmind.openapi) > "$tmp"
pnpm --filter web exec openapi-typescript "$tmp" -o src/shared/api-types.d.ts

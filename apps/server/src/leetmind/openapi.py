"""Offline OpenAPI dump (PLAN_BACKEND.md §10): `python -m leetmind.openapi > openapi.json`.

Builds the app factory and serializes its schema without touching the DB or starting the
lifespan — `pnpm gen:api` runs this, then `openapi-typescript` turns the JSON into the
frontend's generated types.
"""

import json
import sys

from leetmind.main import create_app


def main() -> None:
    spec = create_app().openapi()
    json.dump(spec, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()

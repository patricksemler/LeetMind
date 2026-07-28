"""Canonical local entrypoint: `uv run python -m leetmind` (or `pnpm dev:server` from the repo
root). Runs uvicorn programmatically so HOST/PORT/LOG_LEVEL from config.py actually take effect —
a bare `uvicorn leetmind.main:app` ignores them. The Docker image keeps its own explicit uvicorn
CMD (see Dockerfile)."""

from __future__ import annotations

import uvicorn

from leetmind.config import get_settings


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "leetmind.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()

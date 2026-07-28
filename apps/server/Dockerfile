FROM python:3.12-slim

# The judge orchestrator shells out to the docker CLI (PLAN_BACKEND.md §8.1); the server container
# needs it installed and the host's docker.sock bind-mounted at run time (see docker-compose.yml).
RUN apt-get update \
    && apt-get install -y --no-install-recommends docker.io \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
COPY migrations ./migrations

RUN uv sync --no-dev

EXPOSE 8080
CMD ["uv", "run", "uvicorn", "leetmind.main:app", "--host", "0.0.0.0", "--port", "8080"]

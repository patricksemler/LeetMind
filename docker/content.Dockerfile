# content/ — Python content plane (generation + verification), run with uv.
# Needs the docker CLI because verification runs reference/brute-force/mutant solutions in the
# same sandbox substrate as the judge, via `docker run` against the host daemon (mounted
# /var/run/docker.sock — see docker-compose.yml). NOTE: the recommended default is
# GENERATOR_INVOKER=claude run on the *host* with `uv run`, not inside this container — see the
# comment on the `content` service in docker-compose.yml.
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates docker.io \
    && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /repo/content

COPY content/pyproject.toml ./
RUN uv sync --no-install-project || true

COPY content/ ./

RUN uv sync

CMD ["uv", "run", "-m", "algolift_content.workers.generate"]

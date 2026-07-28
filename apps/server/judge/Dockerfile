FROM python:3.12-slim

# libseccomp2 backs the seccomp-BPF filter child.py installs before running user code
# (PLAN_BACKEND.md §8.2, amendment 38). No other packages: this image runs untrusted code and
# stays minimal on purpose. The security-relevant flags (--network none, --read-only, --user,
# --cap-drop, --pids-limit, ...) are supplied by the caller's `docker run`, not baked in here.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libseccomp2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /judge
COPY runner.py child.py ./

ENTRYPOINT ["python3", "-u", "/judge/runner.py"]

# AlgoLift Python sandbox runner image — docs/CONTRACTS.md §6.
#
# No network access at runtime: that is enforced entirely by the sandbox's `docker run
# --network none` flag (see packages/sandbox/src/run.ts, buildDockerArgs), NOT by anything in
# this image. This image is intentionally minimal and installs no packages beyond the Python
# stdlib — user/generated code (and the harness itself, runners/python/runner.py) must never
# depend on third-party libraries, so "it imports" can never silently depend on what happens to
# be pip-installed in this image.
FROM python:3.12-slim

LABEL algolift.runner=python

WORKDIR /work

# Debian's base image already maps uid/gid 65534 to nobody/nogroup, which is the UID the
# sandbox always runs containers as (`-u 65534:65534`; see docs/CONTRACTS.md §6 and
# packages/sandbox/src/run.ts's buildDockerArgs). USER is set here too as defense-in-depth so
# the image is safe-by-default even if it were ever launched without that flag.
USER 65534:65534

# No CMD/ENTRYPOINT: the sandbox always supplies argv explicitly, e.g.
# ["python3", "/bundle/runner.py"]. There is nothing sensible to run on its own.

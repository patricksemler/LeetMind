#!/usr/bin/env bash
# Builds and tags the AlgoLift sandbox runner images — docs/CONTRACTS.md §6.
#
# Usage: bash scripts/build-images.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PYTHON_TAG="algolift/runner-python:1"
CPP_TAG="algolift/runner-cpp:1"

echo "==> Building ${PYTHON_TAG} from docker/runner-python/Dockerfile"
docker build \
  -t "${PYTHON_TAG}" \
  -f "${ROOT_DIR}/docker/runner-python/Dockerfile" \
  "${ROOT_DIR}/docker/runner-python"

echo "==> Building ${CPP_TAG} from docker/runner-cpp/Dockerfile"
docker build \
  -t "${CPP_TAG}" \
  -f "${ROOT_DIR}/docker/runner-cpp/Dockerfile" \
  "${ROOT_DIR}/docker/runner-cpp"

echo
echo "==> Image digests"
docker image inspect "${PYTHON_TAG}" --format '{{.RepoTags}}  {{.Id}}'
docker image inspect "${CPP_TAG}" --format '{{.RepoTags}}  {{.Id}}'

#!/usr/bin/env bash
# Run all benchmarks. Writes per-bench output under benchmarks/results/<sha>/.
set -euo pipefail

cd "$(dirname "$0")/.."

SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"
OUT_DIR="benchmarks/results/${SHA}"
mkdir -p "${OUT_DIR}"

echo "Node $(node -v)" | tee "${OUT_DIR}/env.txt"
uname -a | tee -a "${OUT_DIR}/env.txt"

for bench in bench-priority-queue bench-memory bench-queue-drain; do
  echo
  echo "=== ${bench} ==="
  pnpm tsx "benchmarks/${bench}.ts" | tee "${OUT_DIR}/${bench}.txt"
done

echo
echo "Results written to ${OUT_DIR}"

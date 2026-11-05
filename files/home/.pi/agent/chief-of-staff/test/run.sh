#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec node --disable-warning=ExperimentalWarning --test test/*.test.ts "$@"

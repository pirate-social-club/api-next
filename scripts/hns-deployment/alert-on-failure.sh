#!/usr/bin/env bash
set -euo pipefail

failed_unit="${1:-unknown-unit}"
failed_unit="$(tr -cd 'A-Za-z0-9@._:-' <<< "$failed_unit")"
tooling_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$tooling_dir/ping-healthcheck.py" --state failure --label "$failed_unit"

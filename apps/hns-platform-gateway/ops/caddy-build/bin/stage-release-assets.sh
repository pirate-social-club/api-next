#!/usr/bin/env bash
set -euo pipefail

release_dir="${1:?absolute release directory required}"
[[ "$release_dir" = /* && -d "$release_dir/bin" ]] || exit 2
here="$(cd "$(dirname "$0")" && pwd)"
"$here/../build-caddy.sh" "$release_dir/bin/caddy"

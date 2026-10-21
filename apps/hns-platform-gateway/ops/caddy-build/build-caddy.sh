#!/usr/bin/env bash
set -euo pipefail

output="${1:?usage: build-caddy.sh /absolute/output [--dry-run]}"
[[ $# -eq 1 || ( $# -eq 2 && "$2" == --dry-run ) ]] || exit 2
[[ "$output" = /* && "$output" != *$'\n'* && ! -e "$output" && ! -L "$output" ]] || exit 2
[[ -d "$(dirname "$output")" ]] || exit 2
output="$(cd "$(dirname "$output")" && pwd -P)/$(basename "$output")"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
[[ "$output" != "$repo"/* ]] || { echo "build output must be outside the source checkout" >&2; exit 2; }
export GOTOOLCHAIN=local
[[ "$(go env GOVERSION)" == go1.26.2 ]] || { echo "Go1.26.2 is required" >&2; exit 2; }
if [[ "${2:-}" == --dry-run ]]; then
  echo "would build Caddy2.11.4 with the locked rate-limit module for linux/amd64; no output written"
  exit 0
fi

cd "$here"
export GOTOOLCHAIN=local CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOAMD64=v1
export GOFLAGS=
go mod verify
go build -mod=readonly -buildvcs=false -trimpath -tags=nobadger,nomysql,nopgx -o "$output" .
python3 - "$output" <<'PY'
import subprocess, sys
info = subprocess.check_output([sys.argv[1], "build-info"], text=True)
modules = {parts[1]: parts[2] for line in info.splitlines()
           if len(parts := line.split()) >= 3 and parts[0] == "dep"}
assert modules["github.com/caddyserver/caddy/v2"] == "v2.11.4"
assert modules["github.com/mholt/caddy-ratelimit"] == "v0.1.1-0.20260612195517-5625512f24f6"
PY
sha256sum "$output"

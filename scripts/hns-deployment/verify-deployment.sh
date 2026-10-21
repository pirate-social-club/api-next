#!/usr/bin/env bash
# Drift check for systemd timers and scripted use: identical to
# deployment-status.sh but exits nonzero when any drift is detected.
set -euo pipefail
bin_dir="$(dirname "$(readlink -f "$0")")"
"$bin_dir/deployment-status.sh" --verify "$@"

# Report successful verification so the remote dead-man can detect a dead
# host, timer, or credential. Staged roles may omit monitoring configuration.
if [[ -n "${HNS_HEALTHCHECK_URL_FILE:-}" && -n "${DEPLOY_ROOT:-}" ]]; then
  "$bin_dir/heartbeat.sh"
fi

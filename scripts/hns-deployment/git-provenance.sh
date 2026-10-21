#!/usr/bin/env bash
# Sourced by strict Bash release builders; callers share this error policy.
set -euo pipefail

# Shared release provenance gate. This deliberately uses the locally available
# remote-tracking ref and performs no network access. CI is responsible for
# fetching the current protected branch before release construction.

readonly DEPLOYMENT_MAIN_REF="refs/remotes/origin/main"

assert_release_provenance() {
  local commit="${1:?commit required}"
  local break_glass_reason="${2:-}"
  local repo_root="${3:-.}"
  local failure_message=""

  if ! git -C "$repo_root" show-ref --verify --quiet "$DEPLOYMENT_MAIN_REF"; then
    failure_message="required remote-tracking ref $DEPLOYMENT_MAIN_REF is not available locally
fetch the protected branch first with: git fetch origin main"
  elif git -C "$repo_root" merge-base --is-ancestor "$commit" "$DEPLOYMENT_MAIN_REF"; then
    RELEASE_PROVENANCE="origin-main"
    return 0
  else
    failure_message="refusing to stage commit $commit: it is not an ancestor of $DEPLOYMENT_MAIN_REF
fetch the current origin/main and merge through the protected branch first"
  fi

  if [[ -z "$break_glass_reason" ]]; then
    cat >&2 <<EOF
$failure_message.
For an approved disconnected emergency only, pass:
  --break-glass-non-main <incident-or-change-reference>
EOF
    return 1
  fi

  if [[ "$break_glass_reason" == *$'\n'* || "$break_glass_reason" == *$'\r'* ]]; then
    echo "break-glass reference must be a single line" >&2
    return 2
  fi

  RELEASE_PROVENANCE="break-glass"
}

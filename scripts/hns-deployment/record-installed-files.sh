#!/usr/bin/env bash
set -euo pipefail

# Records the complete set of role-owned files installed outside the immutable
# release, then refreshes CONFIG_SHA256 so the manifest itself is protected.

deploy_root=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploy-root) shift; deploy_root="${1:-}" ;;
    --) shift; break ;;
    -*) echo "unknown argument: $1" >&2; exit 2 ;;
    *) break ;;
  esac
  shift
done

if [[ -z "$deploy_root" || $# -eq 0 ]]; then
  echo "usage: record-installed-files.sh --deploy-root DIR /absolute/file [...]" >&2
  exit 2
fi

config_dir="$deploy_root/config"
status_script="$deploy_root/current/bin/deployment-status.sh"
if [[ ! -d "$config_dir" ]]; then
  echo "deployment config directory not found: $config_dir" >&2
  exit 1
fi
if [[ ! -x "$status_script" ]]; then
  echo "deployment status script not found: $status_script" >&2
  exit 1
fi

paths=()
for path in "$@"; do
  if [[ "$path" != /* || "$path" == *$'\n'* || "$path" == *$'\r'* \
    || "$path" == *'\'* || "$path" == *'/../'* || "$path" == *'/./'* ]]; then
    echo "installed file path must be an absolute single-line path: $path" >&2
    exit 2
  fi
  if [[ ! -f "$path" ]]; then
    echo "installed file not found: $path" >&2
    exit 1
  fi
  # Preserve the installed path rather than its current symlink target. A later
  # repoint must make verification read the new target and detect the change.
  paths+=("$path")
done

umask 077
manifest="$config_dir/INSTALLED_SHA256SUMS"
tmp="$(mktemp "$config_dir/.INSTALLED_SHA256SUMS.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

printf '%s\n' "${paths[@]}" | sort -u | while IFS= read -r path; do
  sha256sum -- "$path"
done > "$tmp"
mv -f "$tmp" "$manifest"
trap - EXIT

"$status_script" --deploy-root "$deploy_root" --record-config
echo "recorded installed file manifest $manifest"

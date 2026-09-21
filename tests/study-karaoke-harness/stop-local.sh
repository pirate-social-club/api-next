#!/usr/bin/env bash
# Stops the harness Worker (if running) and removes the disposable database
# container. Pass --keep-database to stop only the Worker. Leaves no harness
# process, container or volume behind otherwise.
set -euo pipefail

keep_database=0
for arg in "$@"; do
  case $arg in
    --keep-database) keep_database=1 ;;
    *)
      printf 'unknown option: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
container=${HARNESS_PG_CONTAINER:-study-karaoke-harness-pg17}
pidfile="$script_dir/.local/harness.pid"

stopped=0
if [[ -f $pidfile ]]; then
  pid=$(cat "$pidfile")
  if [[ $pid =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$pid" 2>/dev/null || true
    stopped=1
  fi
  rm -f "$pidfile"
fi
if pgrep -f '[w]rangler dev' >/dev/null 2>&1; then
  pkill -f '[w]rangler dev' || true
  stopped=1
fi
printf 'harness worker %s\n' "$([[ $stopped == 1 ]] && echo stopped || echo 'not running')"

media_pidfile="$script_dir/.local/media.pid"
media_stopped=0
if [[ -f $media_pidfile ]]; then
  media_pid=$(cat "$media_pidfile")
  if [[ $media_pid =~ ^[0-9]+$ ]] && kill -0 "$media_pid" 2>/dev/null; then
    kill "$media_pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$media_pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$media_pid" 2>/dev/null || true
    media_stopped=1
  fi
  rm -f "$media_pidfile"
fi
printf 'harness playback media %s\n' "$([[ $media_stopped == 1 ]] && echo stopped || echo 'not running')"

if (( keep_database == 1 )); then
  printf 'database container kept\n'
  exit 0
fi
docker rm -f -v "$container" >/dev/null 2>&1 && printf 'database container removed\n' || printf 'database container absent\n'

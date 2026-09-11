#!/bin/sh
# Mounted-checkout invocation for the song-video render host.
#
# Runs the entry point from the checkout it lives in, with the operator's
# environment. Nothing is installed here: Bun 1.4, the pinned FFmpeg tools and
# the installed dependencies must already be present, and a drifted tool is
# refused before any media is touched.
set -eu

cd "$(dirname "$0")/../../.."

command -v bun >/dev/null 2>&1 || { echo "bun 1.4 is required" >&2; exit 1; }
bun_version=$(bun --version 2>/dev/null || echo "")
case "$bun_version" in
  1.4.*) ;;
  *) echo "bun must be version 1.4 (saw: ${bun_version:-none})" >&2; exit 1 ;;
esac
for tool in ffmpeg ffprobe; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required" >&2; exit 1; }
  version=$("$tool" -version 2>/dev/null | head -n 1)
  case "$version" in
    "$tool version 6.1.1"*) ;;
    *) echo "$tool must be version 6.1.1 (saw: $version)" >&2; exit 1 ;;
  esac
done
[ -d node_modules ] || { echo "dependencies are not installed in this checkout" >&2; exit 1; }

exec bun scripts/song-video-render-host.ts

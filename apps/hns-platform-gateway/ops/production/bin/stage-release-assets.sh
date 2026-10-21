#!/usr/bin/env bash
set -euo pipefail
release="${1:?release destination required}"
repo="$(git rev-parse --show-toplevel)"
python3 "$repo/scripts/hns-deployment/build-native-app-bundle.py" community-gateway "$release/native" --execute
cp "$repo/scripts/hns-deployment/verify-native-runtime.py" "$release/bin/verify-native-runtime.py"
mkdir -p "$release/native/systemd"
cp "$repo/apps/hns-platform-gateway/ops/systemd/pirate-hns-community-app-gateway.service" "$release/native/systemd/"

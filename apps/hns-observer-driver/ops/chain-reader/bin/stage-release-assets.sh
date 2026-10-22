#!/usr/bin/env bash
set -euo pipefail
release="${1:?release destination required}"
repo="$(git rev-parse --show-toplevel)"
python3 "$repo/scripts/hns-deployment/build-native-app-bundle.py" observer-driver "$release/native" --execute
cp "$repo/scripts/hns-deployment/verify-native-runtime.py" "$release/bin/verify-native-runtime.py"
mkdir -p "$release/native/systemd"
cp "$repo/apps/hns-observer-driver/ops/systemd/pirate-hns-observer-driver.service" "$release/native/systemd/"
cp "$repo/apps/hns-observer-driver/ops/systemd/cloudflared-hns-authority.service" "$release/native/systemd/"
for name in pirate-hns-production-mainnet-reader.service pirate-hns-secondary-api-tunnel.service; do
  cp "$repo/apps/hns-authority-provisioner/ops/production-mainnet/$name" "$release/native/systemd/"
done
mkdir -p "$release/native/reader/production-mainnet" "$release/native/reader/staging-mainnet"
cp "$repo/apps/hns-authority-provisioner/ops/production-mainnet/read-only-hsd-rpc-production.mjs" "$release/native/reader/production-mainnet/"
cp "$repo/apps/hns-authority-provisioner/ops/staging-mainnet/read-only-hsd-rpc-proxy.mjs" "$release/native/reader/staging-mainnet/"

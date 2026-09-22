#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} != --execute-host || $# != 1 ]]; then
  echo 'Requires --execute-host on the approved staging host.' >&2
  exit 2
fi
docker_cmd=(docker --host unix:///run/pirate-hns-staging/docker.sock)
runtime_root=$("${docker_cmd[@]}" info --format '{{.DockerRootDir}}')
[[ $runtime_root == /var/lib/pirate-hns-staging/docker ]] || exit 1
hsd_image=sha256:0a8e9532e781490e23f536de08719bfac03602654fb9608359f7f27ce6ac0fd3
dns_image=sha256:f976e753a1de8ec62636203ecb12ae5fa3d1055601be167de53f1f673e0abe59
for image in "$hsd_image" "$dns_image"; do
  "${docker_cmd[@]}" image inspect "$image" >/dev/null
done
for name in pirate-hns-staging-hsd pirate-hns-staging-ns1 pirate-hns-staging-ns2; do
  if "${docker_cmd[@]}" container inspect "$name" >/dev/null 2>&1; then
    echo "Existing container requires explicit reconciliation: $name" >&2
    exit 1
  fi
  if "${docker_cmd[@]}" volume inspect "$name-data" >/dev/null 2>&1; then
    echo "Existing volume requires explicit reconciliation: $name-data" >&2
    exit 1
  fi
done

# No cleanup trap: persistent volumes and any partial installation are retained.
# Reconcile exact labels before resuming; never delete or replace automatically.
for name in pirate-hns-staging-hsd pirate-hns-staging-ns1 pirate-hns-staging-ns2; do
  "${docker_cmd[@]}" volume create --label pirate.hns.environment=staging "$name-data"
done
"${docker_cmd[@]}" run -d --pull=never --name pirate-hns-staging-hsd \
  --label pirate.hns.environment=staging --restart=unless-stopped \
  --network=host --cap-drop=ALL --security-opt=no-new-privileges \
  --memory=384m --memory-swap=384m --cpus=0.6 --pids-limit=256 \
  --mount type=volume,source=pirate-hns-staging-hsd-data,target=/data \
  "$hsd_image" node node_modules/hsd/bin/hsd \
  --network=regtest --prefix=/data --listen=false --max-outbound=0 \
  --http-host=127.0.0.1 --http-port=24037 \
  --wallet-http-host=127.0.0.1 --wallet-http-port=24039 \
  --api-key=controlled-progression --index-tx --index-address

for number in 1 2; do
  primary=no
  secondary=yes
  if [[ $number == 1 ]]; then primary=yes; secondary=no; fi
  address="127.0.0.2$number"
  "${docker_cmd[@]}" run -d --pull=never --name "pirate-hns-staging-ns$number" \
    --label pirate.hns.environment=staging --restart=unless-stopped \
    --network=host --user=0:0 --cap-drop=ALL --cap-add=NET_BIND_SERVICE \
    --cap-add=DAC_OVERRIDE --security-opt=no-new-privileges \
    --memory=96m --memory-swap=96m --cpus=0.15 --pids-limit=128 \
    --mount "type=volume,source=pirate-hns-staging-ns$number-data,target=/var/lib/powerdns" \
    --add-host=ns1.pirate:127.0.0.21 --add-host=ns2.pirate:127.0.0.22 \
    "$dns_image" "--local-address=$address" --local-port=53 \
    --api=yes --api-key=isolated-hns-authority-fixture-only --webserver=yes \
    "--webserver-address=$address" --webserver-port=8081 \
    --webserver-allow-from=127.0.0.0/8 --security-poll-suffix= \
    --resolver=127.0.0.21:53 --version-string=anonymous \
    "--primary=$primary" "--secondary=$secondary" \
    --allow-notify-from=127.0.0.21 --allow-axfr-ips= --only-notify=127.0.0.0/8 \
    --also-notify=127.0.0.22 --query-local-address=127.0.0.21 --setuid= --setgid=
done

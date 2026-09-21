# T03 controlled HSD progression harness

A regtest Handshake node for driving real chain progression against the
production observer. It replaces the previously recorded conclusion that no
controlled node was provisionable here; that conclusion attributed the block to
broken Docker TCP publishing, and both Docker's registry and host networking
work.

## Pinned environment

- `hsd` 8.0.0 and its transitive npm graph are integrity-locked by the local
  `package-lock.json`. The `node:22-bookworm-slim` base is digest-pinned in the
  Dockerfile.
- Host networking. The node RPC listens on `127.0.0.1:14037` and the wallet on
  `127.0.0.1:14039`; the API key is `controlled-progression`.
- Regtest genesis block hash
  `ae3895cf597eff05b19e02a70ceeeecb9dc72dbfe6504a50e9343a72f06a87c5`.
- Regtest tree interval is 5 blocks. Production uses 36.

## Run

```sh
docker build -t pirate-hsd-regtest:local apps/hns-authority-provisioner/ops/hsd-regtest
docker run -d --name pirate-hsd-regtest --network host pirate-hsd-regtest:local
```

Then run `bun scripts/hsd-regtest-progression.ts --execute`.
The script requires loopback endpoints and the regtest genesis before any
mutation. It funds a wallet, acquires a name through its auction, publishes a
replacement resource, and asserts convergence through the production observer.
It then invalidates the inclusion block, verifies that the current resource
disappears, rebroadcasts the exact retained transaction bytes, and asserts
current/safe convergence again. Each run generates a fresh name by default;
`HSD_REGTEST_NAME=<unused-name>` optionally selects an explicit fixture name.
This makes repeated runs independent, rather than replaying a prior auction.
This mutates only the disposable regtest chain.

The harness also encodes observed records and checks their wire digest against
the prepared resource digest. Its canonical-JSON observation digest remains a
distinct evidence identity. A repeat run with a generated name included at
1042, converged by 1052, and passed reorg/rebroadcast and wire qualification.

September 9 continuation receipt: t03resumec included at 598; safe still absent
at 603 and converged at 608. Reorg, exact-transaction rebroadcast, re-inclusion,
and safe convergence passed. Transaction:
ad373e2200ef0ca0d1a994ef4dd3ac4644d0f0a3b84fdf416081c662da9f104d.
The observer resource digest (canonical JSON, distinct from encoded-resource
and plan-document hashes) was
e8111987b8a6913317a3e7080d090cdb8d34bc1d637dc7e23c11fbc2986133ef.
Two preceding attempts reached reorg successfully but failed an assertion that
the wallet resend RPC would list the orphaned transaction. Exact raw rebroadcast
avoids creating a second spend of the wallet's pending credit. This proves
observer reorg/republication behavior, not a production recovery action or the
still-unwired lifecycle service loop. Wall-clock slow-block deadline behavior
remains separate coverage.

## What it established

Publishing a resource and reading it back through the two views reproduces the
incident's signature exactly. At the inclusion block the current view returns
the complete resource and the safe view returns null. The safe view converges
within ten blocks on regtest, having still been null at five.

Running the new branch's production observer implementation against the same
node then found two defects that made its safe observation impossible:

- `getblockbyheight` was requested with `verbose` false, so hsd returned the raw
  block as a hex string and the observer rejected it as an invalid response.
  Every safe observation classified as `transport_failure`.
- The block header field is `treeroot`; the observer read `treeRoot`, so the
  commitment tree root was null and every safe observation classified as
  `malformed_response`.

Either defect alone means no operation can ever establish finality: the
operation waits in `waiting_safe_commitment` until its finality deadline
exhausts and it enters recovery. The unit test did not catch this because its
fake answered whichever call the code made and supplied the field name the code
read. These defects were in the new branch code, not the deployed provisioner;
the deployment's separate safe-only observation defect remains the incident
attribution recorded in the task.

## Required CI gate

`bun run test:hns-regtest` is the fail-closed gate for the two maintained live
service suites: the lifecycle composed path and the provisioner service-loop
entrypoint. It deliberately does not include PowerDNS, gateway/TLS, browser or
HSD 6.1.1 transaction-ceremony acceptance.

The command requires a disposable PostgreSQL 17 server with at least 51,200
lock-table entries, plus the HSD 8.0.0 image above. Both HSD endpoints must be
plain HTTP on `127.0.0.1`; the runner rejects a different network or the wrong
fixed regtest genesis before either suite mutates the chain. The API key and
database password below are fixture-only values, never production credentials.
Ports may be overridden to isolate concurrent local work:

```sh
docker run -d --name api-next-hns-regtest-pg --network host \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres \
  -e POSTGRES_INITDB_ARGS='--set=max_locks_per_transaction=512 --set=fsync=off' \
  postgres:17@sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675 \
  -c port=55447 -c listen_addresses=127.0.0.1

docker run -d --name api-next-hns-regtest-hsd --network host pirate-hsd-regtest:local \
  node node_modules/hsd/bin/hsd \
  --network=regtest --http-host=127.0.0.1 --http-port=24047 \
  --wallet-http-host=127.0.0.1 --wallet-http-port=24049 \
  --api-key=controlled-progression --index-tx --index-address

CONTROL_PLANE_POSTGRES_TEST_URL='postgres://postgres:postgres@127.0.0.1:55447/postgres?sslmode=disable' \
HSD_REGTEST_NODE_URL=http://127.0.0.1:24047/ \
HSD_REGTEST_WALLET_URL=http://127.0.0.1:24049/ \
HSD_REGTEST_API_KEY=controlled-progression \
bun run test:hns-regtest
```

The runner uses a private temporary receipt directory for each invocation,
runs the two suites sequentially against the shared chain, and removes local
receipts by default. CI sets `HNS_REGTEST_PRESERVE_RECEIPTS=1`, records the
source SHA and exact PostgreSQL/HSD image identities, and uploads the two fresh
suite receipts plus the completed-suite count report. Remove only the named
containers created for the invocation:

```sh
docker rm -f api-next-hns-regtest-hsd api-next-hns-regtest-pg
```

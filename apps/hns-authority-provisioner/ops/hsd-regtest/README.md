# T03 controlled HSD progression harness

A regtest Handshake node for driving real chain progression against the
production observer. It replaces the previously recorded conclusion that no
controlled node was provisionable here; that conclusion attributed the block to
broken Docker TCP publishing, and both Docker's registry and host networking
work.

## Pinned environment

- `hsd` 8.0.0, installed from npm in `node:22-bookworm-slim`.
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

Then run `HSD_REGTEST_NAME=<unused-name> bun scripts/hsd-regtest-progression.ts --execute`.
The script requires loopback endpoints and the regtest genesis before any
mutation. It funds a wallet, acquires a name through its auction, publishes a
replacement resource, and asserts convergence through the production observer.
It then invalidates the inclusion block, verifies that the current resource
disappears, rebroadcasts the exact retained transaction bytes, and asserts
current/safe convergence again. Use an unused name for each run on a retained
node. This mutates only the disposable regtest chain.

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

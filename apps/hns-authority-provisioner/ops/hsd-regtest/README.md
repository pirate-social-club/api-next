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

Then drive the sequence with `scripts/hsd-regtest-progression.ts`, which funds a
wallet, acquires a name through its auction, publishes a replacement resource,
and reports the current and safe views at each step.

## What it established

Publishing a resource and reading it back through the two views reproduces the
incident's signature exactly. At the inclusion block the current view returns
the complete resource and the safe view returns null. The safe view converges
within ten blocks on regtest, having still been null at five.

Running the production observer against the same node then found two defects
that made a safe observation impossible in any environment:

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
read.

# Nationality upstream integration evidence, 2026-09-14

The lane integrates origin/main at `3e34a9c0bb798748aa13dce711db0f8a36480128`
from local parent `284267298bc43c44d71b84aebbf52dea43c40350`. The merge retains
nationality behavior while adopting the upstream community-creation settlement
extraction and HNS migrations 0168 through 0172. Shared creation helpers live in
one internal module; the 64 pre-extraction declaration ASTs were compared and
preserved. Nationality migrations remain 0173 through 0175. The combined
manifest has 175 entries. Baseline generation succeeded and produced the same
schema and reset bytes as the resolved merge. Shard accounting now assigns the
song-video composed-flow sentinel to shard 1 and render-host to shard 3.

The first merged unit run failed its Megapot pacing test: a configured 20 ms
interval produced a measured 14.2729 ms gap. A deterministic timing seam then
reproduced the underlying bug as 13 ms after 7 ms of transport setup. The start
queue now includes the transport invocation and records its timestamp afterward.
It does not wait for a response before scheduling another request. Sixteen
focused tests pass, including controlled minimum-gap and response-concurrency
proofs. RPC authorization, signing and nonce behavior are unchanged.

After that repair, `bun run check` exited zero. The complete test chain also
exited zero: `bun run test:unit` passed 4,130 tests across 591 files and
`bun run test:node` passed 20 tests. All five workerd configurations passed:
82, 74, 2, 10 and 15 tests, in the repository script order. Each was invoked
with `--maxWorkers=1 --no-file-parallelism` to bound process and memory use.
This supersedes the failed merged run; it is not a claim that the earlier run
passed. The prior lifetime checkpoint's full run remains separate evidence.

Seven PostgreSQL 17 suites passed 50 tests with seven fresh completion
sentinels: creation repository, creation nationality completion, creation
nationality flow, community nationality, community Gates v2, nationality ceremony
store, and join intent fulfillment. They ran against a task-owned Unix-socket
container with a 512 MiB limit. The wrapper exited one during its final cleanup:
`rmdir` found a stale socket and lock after the container was stopped. Those
exact task-owned entries were inspected and removed afterward. The container
and socket directory are gone. Tests and marker validation succeeded, but the
wrapper's exit code is not represented as zero.

The machine-readable summary records counts, limits and digests of temporary
logs under `/tmp/nationality-delivery-2026-09-14/`. These are local command
observations, not signed acceptance receipts. Raw temporary logs may disappear
on reboot; their digests do not preserve their contents. No secrets were added
to this evidence. Full PostgreSQL partitions, the trusted pull-request boundary,
Solid/browser flows, real-document ceremonies and staging acceptance were not
run. Nothing was enabled, pushed or deployed.

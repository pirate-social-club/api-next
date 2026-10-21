# Handshake chain reader

This directory owns the HSD container used by the API observer. Its exact historical role revision is recorded in the source-adoption ledger. The build pins the HSD commit, release tarball, lockfile and base image. Build and rehearse on CI or a bounded remote builder; no workspace or old API source is required.

Keep the chain database in /srv/pirate-hns-observer/shared/data and its managed API key in the private external secret file. The container runs with no capabilities, a read-only filesystem and its declared non-root UID. Its authenticated HTTP listener stays on loopback12037; it is a chain reader and does not load a wallet. Preserve current chain data across release replacement; an empty host must resynchronize before it can be accepted as fresh.

The reader is limited to two CPUs and2GiB RAM. Its memory-plus-swap limit is
also2GiB, which prevents container swap on a host that has swap enabled. Require
those resolved Compose limits and the live cgroup's zero swap limit during
adoption. The owned image and its empty-state boot receipt remain separately
bound to the Docker inputs; changing these runtime bounds does not rebuild HSD.

Install this role's observer-specific service and timer drop-ins alongside the
shared deployment verifier. The verifier has a sixty-second execution bound,
128MiB RAM and no swap. Its timer keeps the shared daily schedule and adds an
initial run three minutes after activation, with up to thirty seconds of jitter.
Accept the replacement manually without a heartbeat, then provide the distinct
observer check URL and restart the timer. Arm hosted coverage only after that
actual scheduled verification succeeds. Record the drop-ins in the installed
file manifest and retain the previous container, selector and units for rollback.

Readiness requires near-complete verification and a bounded tip age. Stronger namespace and finality policy belongs to the API observer. A health response alone does not prove current finality. Release acceptance checks the exact image, mounts, source digest, API authentication, synchronized main chain, unit/file integrity and affected callers. Retain the existing reader until its successor has passed those checks.

The release asset hook also reproduces the existing private observer driver and
pins its Bun runtime and tunnel binary. Install the native-driver verifier
drop-in alongside the existing bounds and timer drop-ins. It extends the same
observer integrity check through a real authenticated private-driver exchange.
See scripts/hns-deployment/native-runtime-recovery.md for immutable historical
application binding, private configuration recovery and bounded rollback.

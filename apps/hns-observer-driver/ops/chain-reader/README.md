# Handshake chain reader

This directory owns the HSD container used by the API observer. Its exact historical role revision is recorded in the source-adoption ledger. The build pins the HSD commit, release tarball, lockfile and base image. Build and rehearse on CI or a bounded remote builder; no workspace or old API source is required.

Keep the chain database in /srv/pirate-hns-observer/shared/data and its managed API key in the private external secret file. The container runs with no capabilities, a read-only filesystem and its declared non-root UID. Its authenticated HTTP listener stays on loopback12037; it is a chain reader and does not load a wallet. Preserve current chain data across release replacement; an empty host must resynchronize before it can be accepted as fresh.

Readiness requires near-complete verification and a bounded tip age. Stronger namespace and finality policy belongs to the API observer. A health response alone does not prove current finality. Release acceptance checks the exact image, mounts, source digest, API authentication, synchronized main chain, unit/file integrity and affected callers. Retain the existing reader until its successor has passed those checks.

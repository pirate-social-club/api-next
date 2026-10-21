# HNS host releases

api-next owns the HNS primary DNS, secondary DNS, DoH resolver, chain reader, gateway and monitoring releases. Private infra independently owns Spaces, Rosen and CI host operations. The per-file adoption ledger records the exact historical source of the imported host roles. No build or runtime reads the frozen Core checkout or the workspace control plane.

Construct each immutable role from a clean commit reachable from freshly fetched origin/main with make-release.sh. SOURCE_COMMIT and SOURCE_PROVENANCE identify api-next source. SHA256SUMS covers the role, generated assets and its bundled verification tools. make-app-release.sh archives this repository only when an independently reviewed app bundle is required. It never obtains old application code from another repository.

A host deployment keeps configuration and state outside releases, verifies every staged digest, records installed files, and then changes the current symlink under exclusive runtime custody. deployment-status.sh checks the complete regular-file set and checksums, source identity, configured app links, recorded installed-file hashes and declared container image identity and running state. It does not inventory every symlink or file type. Effective systemd units and container mounts require separate release acceptance checks. verify-deployment.sh returns nonzero on detected drift. Keep these checks and timers; an external heartbeat proves different things.

The imported templates are not installation acceptance. Before each release, bind exact source and assets, inspect private configuration without printing it, preserve rollback and current encrypted state, and rehearse the changed role. Verify public DNSSEC, DoH and gateway callers as applicable. A gateway rotation also needs coordinated API and Solid provenance and serving checks.

Hosted checks must use separate success and failure endpoints. Keep the monitor dry-run and new backup timers disabled until actual failure, recovery and missed-run delivery reach the operator. A stopped monitor or dead host must be detected by the hosted service outside this fleet. No application webhook is a substitute for that check.

Give every independently scheduled task its own private ping URL. A successful
drift check must not clear an RRSIG failure or reset a backup deadline. Set
HNS_HEALTHCHECK_URL_FILE in each role's environment to a root-owned0600 file
outside the release. The RRSIG and DANE units use their own health environment
for both success and failure delivery. Their period is one hour; the deployment
drift and state-backup jobs are daily. Hosted periods and grace must match the
actual installed timers, including their execution and randomized-delay bounds.

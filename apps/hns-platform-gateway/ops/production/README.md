This directory owns the captured production gateway routing baseline. caddy.json derives from the exact effective bytes captured on October 20; caddy.provenance.json binds its origin, previous live hash and candidate SHA256. Private TLS keys remain in the encrypted edge-state backup and managed runtime flow.

The reviewed candidate retires the older verifier host with HTTP 410 and removes its reverse proxies and rate-limit handler. All other route structures and TLS identities are preserved. Compare both current disk and active configuration before installation, validate with the actual custom Caddy binary and retain bounded rollback. Follow retire-legacy-verifiers.md; a source candidate is not live retirement acceptance.

The release asset hook reproduces the separately running interactive application
gateway from its accepted historical source, without rotating its bundle or
manifest. The gateway-config verifier drop-in covers its actual running Bun
binary, bundle, manifest, installed credentials and local readiness before the
existing Caddy check can report success. Keep the Caddy checks and installed-file
entries. See scripts/hns-deployment/native-runtime-recovery.md for the recovery
recipe, managed configuration custody and rollback. The static gateway bundle and actual readiness are covered separately in the same check.
This does not establish remote ingress acceptance or authorize retiring the static gateway.

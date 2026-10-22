This directory owns the captured production gateway routing baseline. caddy.json preserves the exact effective bytes captured on October20; caddy.provenance.json binds its origin and SHA256. Private TLS keys remain in the encrypted edge-state backup and managed runtime flow.

The capture still contains the older verifier routes and their custom rate-limit handler. Source custody does not establish that those services may be retired or that a stock Caddy binary can load this configuration. Review current callers and the maintained generic gateway builder before a routing successor. Compare the current host bytes before any installation and retain rollback configuration and TLS identity.

The release asset hook reproduces the separately running interactive application
gateway from its accepted historical source, without rotating its bundle or
manifest. The gateway-config verifier drop-in covers its actual running Bun
binary, bundle, manifest, installed credentials and local readiness before the
existing Caddy check can report success. Keep the Caddy checks and installed-file
entries. See scripts/hns-deployment/native-runtime-recovery.md for the recovery
recipe, managed configuration custody and rollback. This does not retire static
or legacy verifiers and does not establish remote ingress acceptance.

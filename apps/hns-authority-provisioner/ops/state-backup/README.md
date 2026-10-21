# HNS edge-state recovery

This independently owned role captures the authoritative SQLite database and signing keys, declared edge state and DANE certificate identity, encrypts the archive with the off-host age recipient, and uploads it with its checksum to the configured immutable remote. A SQLite online backup supplies a consistent database. Stop only the explicitly declared active writers and restore exactly those services after capture; retain failures for recovery.

The systemd unit executes the role from /srv/pirate-hns/current, not an application checkout. Configuration and state remain outside immutable releases. The private recovery identity never belongs on this host or CI. Private infra separately owns paired Spaces wallet/tree/API recovery; this edge archive does not replace it.

The required HNS_CADDY_CONFIG_FILE names the active gateway configuration. Its effective bytes are saved as caddy/caddy.json even when the runtime path is a symlink. Missing or empty configuration refuses before writer quiescence. Restore that file alongside the saved DANE identities and reconcile it with the maintained gateway release; TLS keys alone cannot reconstruct routing.

SPACES_DATA_DIR, HNS_RUNTIME_STATE_DIR and HNS_DANE_CERT_DIR are mandatory directories. A missing path, regular file or symbolic link in their place refuses before writer quiescence, encryption or upload. Configure each directory itself, because tar would otherwise save only its link. No declared source is silently optional. Bind these paths and PDNS_SQLITE_DB to the actual host during release acceptance; the database example uses the primary role's stable shared data directory. Directory existence alone does not prove that all expected state or private keys are present: inventory and isolated restore acceptance remain required.

An upload counts as successful only after archive and sidecar upload and provider COMPLIANCE-retention readback for the exact versioned objects. Keep S3 credentials out of curl arguments by supplying authentication through its private standard-input configuration. Never log that input. Preserve an encrypted recovery point and isolated restore proof before changing the active release.

Heartbeat only after the entire operation succeeds. Signal failures through the hosted failure endpoint and test recovery and a missed scheduled run. Keep deployment integrity checks. Source adoption and local fixtures alone are not full host, remote retention or alert-delivery acceptance.

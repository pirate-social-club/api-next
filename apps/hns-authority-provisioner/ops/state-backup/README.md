# HNS state recovery

The existing primary profile requires Spaces state, HNS runtime state, TLS
identity, the effective Caddy configuration and a consistent PowerDNS SQLite
snapshot. It remains the default. Every declared input is mandatory.
Only explicitly declared active writers are quiesced, then restored even when
capture fails. Private infra owns paired Spaces wallet/tree/API recovery; this
archive does not replace it.

The explicit `staging-hns` profile has no Spaces role. It requires the complete
private runtime directory and a TLS directory inside it; that parent is archived
once. The staging signer database is captured by SQLite online backup. The
profile refuses a declared Spaces directory or a TLS path outside its runtime
directory. Use the staging environment example with the actual .209 paths.
Links, special files and nested filesystems in that runtime directory refuse
capture rather than silently omit state.

Build this role with the standard immutable release builder, install only the
staging units on .209, and bind the private uploader configuration outside the
release. The service holds the existing relocation lock, uses a private tmpfs
and has zero swap. It does not stop serving processes. Successful completion
requires ciphertext, checksum, upload and provider COMPLIANCE-retention proofs
before the separate hosted heartbeat. Keep management keys and the private age
recovery identity off hosts.

Before enabling the timer, independently download and decrypt a real uploaded
object in a bounded zero-swap recovery process. Restore the signer SQLite into
an isolated pinned PowerDNS5.1.5 container and require all four DS sets to match
the current chain. Compare the retained TLS certificate/key and SPKI with TLSA,
and verify the private runtime configuration and gateway credentials. Preserve
the prior ciphertext and current service until recovery passes. Arm the new
backup check only after its actual scheduled job succeeds.

This archive covers staging HNS state. Managed PostgreSQL and Worker deployment
recovery remain separate; it does not authorize resetting their shared branch.

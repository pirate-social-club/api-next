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

The tmpfs creates its own staging directory. Do not add `RuntimeDirectory` for
that same path: systemd can bind the host-managed directory over the private
mount. Check the effective mount is a256MiB tmpfs with mode0700, together with
the service's zero swap cgroup limit, before accepting capture.

The host requires age, rclone, SQLite3, zstd and curl alongside the standard
system tools checked by the script. Use rclone1.74.4 on linux/amd64, matching
the primary's accepted uploader. The old Ubuntu1.53.3 build uses B2 APIv1,
which refuses the current managed credential. Download
`https://downloads.rclone.org/v1.74.4/rclone-v1.74.4-linux-amd64.zip` and require
archive SHA256`fe435e0c36228e7c2f116a8701f01127bb1f694005fc11d1f27186c8bca4115d`
before extraction. Its `rclone` executable must have SHA256
`9f56ca5edfac24a3ed37226c2ba1de69f1ec9e05fa2526cddee5cd97e202be6b`.
Install that root-owned executable at `/usr/local/bin/rclone`, retaining any
previous file for rollback, and confirm the backup service resolves that path.
The distro executable stays available at `/usr/bin/rclone`; this operation
does not change credentials, bucket policy or serving processes.

Before enabling the timer, independently download and decrypt a real uploaded
object in a bounded zero-swap recovery process. Restore the signer SQLite into
an isolated pinned PowerDNS5.1.5 container and require all four DS sets to match
the current chain. Compare the retained TLS certificate/key and SPKI with TLSA,
and verify the private runtime configuration and gateway credentials. Preserve
the prior ciphertext and current service until recovery passes. Arm the new
backup check only after its actual scheduled job succeeds.

This archive covers staging HNS state. Managed PostgreSQL and Worker deployment
recovery remain separate; it does not authorize resetting their shared branch.

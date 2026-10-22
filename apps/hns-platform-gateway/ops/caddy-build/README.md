# Primary Caddy build

The primary gateway requires `http.handlers.rate_limit`. Its retained binary
uses Caddy2.11.4, Go1.26.2 and the rate-limit module at5625512f24f6. The distro
binary does not supply that module. This entrypoint and locked module graph
own the corresponding build without a workspace or frozen-repository input.

Run `build-caddy.sh /absolute/output --dry-run` to inspect the fixed target,
then omit `--dry-run` to build. Use a bounded build process, for example two
CPUs and4GiB RAM. Output must be outside the checkout and must not already
exist. The build disables CGO and VCS stamping, uses the retained build tags,
verifies the module cache and refuses module-graph changes.

The standard `scripts/hns-deployment/make-release.sh` builder accepts this role
directory and compiles `bin/caddy` through its asset stager. Run that builder
under the same resource bounds. Its ordinary protected-source check and final
SHA256SUMS bind the binary to the accepted source; no prebuilt binary is fetched.

Record the source commit, output digest and full module inventory. Compare the
candidate with the retained binary; a matching dependency graph alone is not
byte reproduction. Validate the actual private primary configuration with the
candidate before any installation. Source acceptance does not replace the
running binary. Keep `/usr/local/bin/pirate-caddy.d14fb978` as rollback until a
reviewed successor passes public gateway and DoH acceptance. The staging host
has its own Caddy binary and does not use this build.

The role also preserves the actual primary vendor caddy.service and its
30-production-json.conf override. The override explicitly selects
/usr/local/bin/pirate-caddy and /etc/caddy/caddy.json. Install the preserved
vendor unit at /lib/systemd/system/caddy.service and the override at
/etc/systemd/system/caddy.service.d/30-production-json.conf, both root0644.
Create the caddy system account with home /var/lib/caddy and nologin before
restoring state. The retained primary account is UID996/GID998; check these
IDs are free on a new host or explicitly map the recorded ownership during
restore. Preserve each TLS key's recorded owner/mode and account traversal
permissions. Do not make private keys world-readable or recursively change
the restored tree to work around a failed boot. The public JSON is root0644.

On a fresh host install the custom binary as a versioned0755 file and point
pirate-caddy at it. Restore the encrypted DNSSEC/TLS backup and current owned
public JSON before starting the unit. Validate the restored private TLS paths
as the actual caddy account, then qualify local TLS and public DNSSEC/DANE,
application routing and DoH GET/POST. Retain the prior binary, JSON, unit and
selector for rollback. This recipe owns build and service inputs; an isolated
root-user validation alone is not a full service-account or bare-host proof.

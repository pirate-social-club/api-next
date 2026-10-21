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

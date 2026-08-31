# Interactive community gateway VPS profile

This profile packages the interactive `app.<community-root>` gateway without
replacing the existing `app.pirate` artifact, unit, listeners, releases, or
rollback material. The separate bundle is
`dist/pirate-hns-community-app-gateway.mjs`. Its production gateway and health
listeners are `127.0.0.1:4069` and `127.0.0.1:4071`; shadow uses
`127.0.0.1:4169` and `127.0.0.1:4171`. The separate staging-shadow profile
uses only `127.0.0.1:4269` and `127.0.0.1:4271`. Listener ownership must be
re-inventoried on the VPS before any unit is installed.

Build only from a clean accepted api-next commit:

```bash
bun run --cwd apps/hns-platform-gateway build:community-vps-bundle
sha256sum apps/hns-platform-gateway/dist/pirate-hns-community-app-gateway.mjs
```

The combined production replacement is built with:

```bash
bun run --cwd apps/hns-platform-gateway build:combined-vps-bundle
```

It emits `dist/pirate-hns-community-app-handle-gateway.mjs`. Install that
artifact under the existing production unit's expected
`bin/pirate-hns-community-app-gateway.mjs` release path, together with compact
bytes derived from `community/deployment-manifest.combined.template.json`.
The combined schema binds both exact gateway profiles and computes
`hns-community-app-handle-gateway-sha256:<manifest_sha256>`. It reserves the
exact `app.<root>` label for the interactive community service and sends every
other two-label authority to the read-only handle service; each child service
still performs its complete request and SNI admission independently. The
legacy community-only manifest remains accepted by the legacy bundle for
rollback.

The build embeds the exact source commit and reports the bundle SHA-256. Copy
`community/deployment-manifest.template.json` for production or production
shadow. Copy `community/deployment-manifest.staging-shadow.template.json` only
for the staging-shadow mode. Resolve every placeholder against one named
environment tuple,
replace the source commit and bundle digest with the build output, and encode
the populated object as compact `JSON.stringify` bytes with no trailing
newline. The runtime computes
`hns-community-app-gateway-sha256:<manifest_sha256>` as the immutable gateway
deployment reference. It rejects a changed artifact, source commit, profile,
listener, limit, secret-reference name, registry identity, origin, or extra
manifest member before listening. A production-v1 manifest cannot select the
staging-shadow mode, and a staging manifest cannot select either production
listener pair.

The staging manifest records `public_tls_termination: false` and binds a
synthetic nonpublic SPKI digest used only for authority-tuple equality during
the loopback preflight. It is not evidence of a certificate, TLS termination,
TLSA record, DNSSEC validation, or public reachability.

The four credential names in the manifest are logical systemd credential
names. Values never enter the manifest. The authority database URL must belong
to a separate server-enforced read-only role and use `sslmode=verify-full`.
Its protocol, host, port, database name, and TLS mode must exactly match the
credential-free `authority_database_endpoint` bound into the manifest.
The role may read only the dependencies of
`resolve_hns_community_app_host_authority_v1(TEXT, TIMESTAMPTZ)` and may not
mutate, migrate, own, or administer anything. The forwarder registry is the
same exact registry reference and version installed at both Worker consumers.
The Access pair is outbound only and is added solely to the configured Solid
protected origin.

The production, shadow, and rollback unit names are respectively
`pirate-hns-community-app-gateway.service`,
`pirate-hns-community-app-gateway-shadow.service`, and
`pirate-hns-community-app-gateway-rollback.service`. The existing
`pirate-hns-platform-gateway.service` and
`pirate-hns-platform-gateway-shadow.service` keep their artifact and ports.
The rollback unit uses the same isolated community production listeners and
therefore conflicts with the current community production unit.

The staging unit is
`pirate-hns-community-app-gateway-staging-shadow.service`. It reads only
`/srv/pirate-hns-community-app-gateway-staging-shadow` and
`/etc/pirate/hns-community-app-gateway-staging-shadow`, and it does not share a
release, manifest, credential directory, listener, or unit with production or
production shadow.

The Caddy file is a composition fragment, not a complete candidate. Resolve
its one exact `app.<root>` host only after root selection. Insert the route
ahead of the existing catchall while retaining the exact `app.pirate` route,
DANE certificate policy, verifier, DoH, and HTTP behavior. Keep wildcard
reserved-header deletion separate from exact terminator-header injection.
Before any reload, validate new complete bytes, retain the active bytes and
SHA-256, and probe `app.pirate` against its unchanged `127.0.0.1:4049`
artifact before and after every promotion.

These files are repository templates only. They do not authorize a VPS
connection, build or install on the VPS, service action, credential ceremony,
Caddy change, Access resource, database grant, DNS change, key or certificate
operation, deployment, or Handshake transaction.

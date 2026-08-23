# ZKPassport staging verifier provisioning evidence

Date: 2026-08-18

Status: the dedicated staging verifier runtime is provisioned and publicly
reachable over authenticated TLS. ZKPassport remains disabled in every Worker
environment. No Worker secret was installed and no proof ceremony was run as
part of this provisioning tranche.

## Scope and placement

- Host: `sage-quail-0431` (`94.103.168.209`), the Frankfurt Radicle CI host.
- Public origin: `https://zkpassport-verifier-staging.pirate.sc`.
- DNS: a DNS-only A record points the hostname directly to `94.103.168.209`.
- Runtime bind: `127.0.0.1:8794`; the verifier is not directly public.
- Reverse proxy: Caddy terminates TLS on ports 80/443 and proxies to the
  loopback runtime.
- At provisioning time, the authoritative `pirate.sc` zone was in the existing
  `hippiehecton` Cloudflare account, and no zone migration or nameserver change
  occurred in this tranche. The zone moved to the canonical account on
  2026-08-23; the DNS-only verifier record retained the same target.
- `94.103.168.161` (`ns1-pirate-fluence`) and `81.15.150.159` (`ns2`) were not
  touched.

## Published artifact and runtime

- Source commit: `b12dc941e5d9bbde2dd7508757226d06ec7edc74`.
- Source archive SHA-256:
  `7302906d54c5070e49c223e3123dc761fe72b51c4c0c4e59eaee30ba0166b46b`.
- Release directory:
  `/opt/pirate/zkpassport-verifier/releases/b12dc941e5d9bbde2dd7508757226d06ec7edc74`.
- `/opt/pirate/zkpassport-verifier/current` points to that exact release.
- Dependencies were installed with `bun install --frozen-lockfile`.
- Bun is pinned to `1.3.14`; its official release checksum was verified before
  installation.
- `@zkpassport/sdk` is pinned to `0.14.2`.
- The focused verifier/envelope test run passed 8/8 on the target host.
- Caddy `2.11.4` was installed from its official stable repository.

The host release intentionally contains no Git metadata. The archive digest
above is the provenance bridge between the published repository commit and the
installed release.

## Secret handling

- A distinct request bearer secret and response-signing secret were generated
  directly on the VPS. Their values did not cross the terminal transcript.
- Signing key ID: `staging-2026-08-18-01`.
- Secret directory: `/etc/pirate-zkpassport`, mode `0700`, owner `root:root`.
- Environment file:
  `/etc/pirate-zkpassport/zkpassport-verifier.env`, mode `0600`, owner
  `root:root`.
- No secret value was printed, copied into the repository, installed in a
  Worker, or written to this evidence record.

## Service isolation

- `zkpassport-verifier.service` is enabled and active under the dedicated
  `zkpassport-verifier` user, whose shell is `/usr/sbin/nologin`.
- The service uses `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
  `PrivateDevices`, `NoNewPrivileges`, an empty capability set, restricted
  address families, and a 5 GiB memory ceiling.
- `systemd-analyze security` rated the unit `3.9 OK` during the independent
  read-only audit.
- Observed steady-state memory was approximately 57 MiB.
- Caddy access logs write to standard output; the systemd unit routes standard
  output to journald.
- The previous packaged Caddy configuration is preserved at
  `/etc/caddy/Caddyfile.pre-zkpassport-20260818`.

## Network and coexistence checks

UFW is active with default-deny incoming policy. The only allowed incoming TCP
ports are:

- `22`: SSH;
- `80`: ACME HTTP and HTTPS redirect;
- `443`: verifier HTTPS;
- `8776`: the pre-existing Radicle seed.

The final listener inventory showed:

- public TCP `22`, `80`, `443`, and `8776`;
- public UDP `443` for HTTP/3;
- verifier runtime only on `127.0.0.1:8794`;
- Caddy administration only on `127.0.0.1:2019`.

The Radicle node, CI broker, and `promotion-controller.service` remained active;
the Radicle node continued to own public port `8776`.

## Public validation

- Cloudflare's `1.1.1.1` resolver returned `94.103.168.209` for the staging
  verifier hostname.
- Caddy obtained a Let's Encrypt certificate whose subject and SAN match
  `zkpassport-verifier-staging.pirate.sc`.
- Certificate validation succeeded using the local system trust store over
  TLS 1.3 and HTTP/2.
- `GET /health` returned HTTP 200 with the redacted service result:

  ```json
  {"ok":true,"service":"zkpassport-verifier","sdk_version":"0.14.2"}
  ```

- An unauthenticated public `POST /verify` returned HTTP 401.
- The verifier service and Caddy were active after all probes.

## Deliberately incomplete enablement gates

Provisioning the verifier does not enable ZKPassport. The following gates still
stand:

1. Complete and accept the Solid embedded-SDK client using the server-authored
   query and the owned-session/CSRF transport.
2. Install the matching request and response-signing secrets into the staging
   Worker without exposing their values.
3. Enable ZKPassport in staging only and deploy the reviewed Worker
   configuration.
4. Run a fresh real `@zkpassport/sdk@0.14.2` proof ceremony.
5. Measure the exact serialized completion request before submission and prove
   it is at most the public Worker's `1_048_576`-byte ingress limit.
6. Read back the completed evidence and record only redacted proof count, byte
   count, SDK version, environment, endpoint status, and an optional payload
   digest. Raw proofs, query results, identifiers, and claims must not be
   persisted in the report.

If the real request exceeds 1 MiB, enablement stops for an explicit ingress
limit design review. The verifier's separate 10 MiB ceiling does not override
the Worker's public transport limit.

## Operational note

The host reported a pending kernel update during provisioning. It was not
rebooted because it also carries the active Radicle CI stack. Any reboot must be
scheduled as a separate maintenance action with Radicle continuity checks.

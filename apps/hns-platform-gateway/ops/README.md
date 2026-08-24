# Static platform gateway VPS profile

This directory packages the deployment-facing pieces for the source-closed
`pirate` and `app.pirate` gateway. It reuses the retained VPS, Caddy DANE
terminator, certificate, and signed `pirate` zone without importing or calling
the legacy application, API, verifier, or gateway runtime.

Build the one-file Linux executable from the accepted api-next commit:

```bash
bun run --cwd apps/hns-platform-gateway build:executable
sha256sum apps/hns-platform-gateway/dist/pirate-hns-platform-gateway
```

The shadow unit listens on `127.0.0.1:4149` and exposes health only on
`127.0.0.1:4151`. The production unit listens on the retained Caddy upstream
port `127.0.0.1:4049` and exposes health only on `127.0.0.1:4051`. Neither unit
reads an environment file. The executable accepts exactly one of the two
compiled modes and always verifies the frozen profile digest before listening.

The TLS terminator must remove caller-supplied reserved headers and inject the
exact request headers in
`caddy/static-platform-reverse-proxy-headers.json` on the HTTPS catchall's one
`127.0.0.1:4049` reverse proxy. The SNI placeholder is owned by Caddy after TLS
termination. Do not add those headers to the plaintext port-80 server, the
WebPKI verifier route, or the DoH route. The target gateway independently
rejects missing, duplicate, malformed, or Host-mismatched values.

Before a Caddy reload, require exactly one HTTPS server on `:443`, exactly one
catchall reverse proxy to `127.0.0.1:4049` inside that server, the retained
DANE certificate-selection policy, and an unchanged verifier and DoH route.
Write the candidate to a new file, run the installed Caddy binary's config
validation, and retain the previous JSON bytes and SHA-256 for immediate
rollback. Never edit the live JSON in place.

The shadow rehearsal sends the two exact gateway headers directly to port
4149. It proves the apex redirect, path-preserving app response, `GET`/`HEAD`,
credential stripping, reserved-host failure, health, restart, and source
closure without touching Caddy. Only after those probes pass may the production
unit replace the legacy process on 4049 and the validated Caddy candidate be
loaded. DNS, DNSSEC, TLSA, certificate, HSD, PowerDNS, and backup state remain
unchanged throughout this cutover.

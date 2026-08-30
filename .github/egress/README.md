# CI egress observations

These job-specific allowlists were observed on 2026-08-30 with the signed
Iron Proxy 0.41.0 Linux release. The release checksum manifest signature,
signing-key fingerprint, and archive checksum were verified before execution.
The proxy ran unprivileged on high ports and did not alter host DNS, firewall,
sudo, or Docker configuration.

The observation used a fresh `node_modules` directory, an empty isolated Bun
cache, `bun install --frozen-lockfile`, the dependency audit, and the start of
the repository check. Across 616 requests, the only destinations were
`registry.npmjs.org`, `api.github.com`, and `codeload.github.com`; every request
was allowed and none produced a warn or deny action. The pinned GitHub Action
always includes the two GitHub destinations, so the repository rules need to
declare only `registry.npmjs.org`.

The proxied repository check stopped after Knip because Wrangler emits a proxy
environment warning on stderr and the Knip ratchet treats analyzer stderr as
an error. This was an observation-tool interaction, not a product diagnostic.
The authoritative full check runs without proxy environment variables after
the observation.

Keep separate files even while the domains coincide so later job-specific
traffic does not widen every job. Re-observe after a dependency source,
installer, action, or workflow change and before switching Iron from warn mode
to enforcement.

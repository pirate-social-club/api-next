# Superseded DNS attachment draft

This unexecuted draft was prepared during the kaya.pirate investigation on
2026-11-11. The workspace_owner clarified that the former DNS/gateway servers
were deliberately stopped and that the intended architecture uses contract
resolution with direct browser-to-Cloudflare transport. An operator-managed
VPS or external TLS gateway is excluded. This draft is superseded and is
preserved only on its isolated feature branch; it is not a launch candidate.

prepare-static-host.py was never run against a live configuration, tested as
a release, installed, or deployed. No DNS, certificate, gateway, Handshake,
registry, or Cloudflare state was changed by this draft. Only Python syntax
was checked before preservation. Do not merge or execute this draft as the
native-name implementation. The source task records the corrected direction.

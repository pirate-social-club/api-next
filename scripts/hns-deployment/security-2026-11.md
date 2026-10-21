# DNS image security patch

PowerDNS advisory 2026-11, CVE-2026-52682, affects the previously pinned
authoritative 5.1.3 and dnsdist 1.9.15 images. A crafted DNS response can cause
excessive CPU and memory use. The advisory identifies 5.1.4 and 1.9.16 as the
first fixed versions in these release series:
https://www.dnsdist.org/security-advisories/powerdns-advisory-for-dnsdist-2026-11.html

The maintained primary, secondary, staging fixture and DoH recipes now pin
the official 5.1.4 and 1.9.16 OCI index digests. These are patch updates within
the existing image families. No database migration, signing-key rotation,
delegation, gateway manifest or product binding change accompanies them.
Registry discovery is not host acceptance: verify the actual version and
declared digest on every target before starting a service.

Keep the encrypted, restored DNSSEC/TLS recovery point and old images. Rehearse
the new authority against an isolated copy, preserving all keys and TSIG
transfers, then roll authorities one at a time. Rehearse the DoH frontend on
loopback with a synced owned resolver and HTTP/2. Its public Caddy cutover is a
separate step, followed by GET/POST, signed-answer, rejection and integrity
checks. Never treat an HTTP/1.1 probe against the h2c backend as serving proof.

The public health monitor can operate before that cutover. Its owned units
read doh-health.env, whose DEPLOY_ROOT points to /opt/pirate-hns-doh-health;
that root's current link selects the immutable owned helper release. The
resolver service's deployment root and public Caddy remain unchanged during
this monitoring-only step. Pin the expected A record from a fresh authority
read, install its separate private check URL, and accept the real public probe
and hosted signal before enabling its timer. This does not establish the
data-plane image patch, public cutover or complete host rebuild.

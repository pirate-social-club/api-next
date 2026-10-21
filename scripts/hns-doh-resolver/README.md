# Handshake DoH resolver

api-next owns this dnsdist and hnsd resolver role. Its per-file historical source is recorded in the HNS source-adoption ledger. The release builder, image inputs, entrypoint and health checks are local to this repository. No old application checkout is a build or runtime dependency.

The resolver listens privately on 8054 and the public Caddy route terminates HTTPS for dns.pirate.sc/dns-query. Preserve the existing frontend listener and compose the resolver route into the owned effective gateway configuration; never replace an unrelated gateway configuration from an old example. The acceptance command checks DNS-over-HTTPS GET and POST through the real public serving path. Required checks fail closed; advisory third-party name checks are explicitly weaker.

Build from a clean protected-main commit, verify the immutable role and exact image, inspect private runtime settings without printing them, and retain rollback. Accept the isolated resolver before public gateway release, then test both methods and DNSSEC answers through that gateway. Keep the deployment-integrity and resolver-health timers, with hosted success/failure and missed-run reporting only after tested delivery.

The fifteen-minute public health probe has its own private check URL in doh-health.env, shared only by its success and failure senders. Daily release integrity uses a separate check. The two-minute timer jitter and two-minute probe execution bound fit its five-minute hosted grace. A healthy signal requires a completed public probe; an inactive resolver cannot reset the deadline. The unit-command fixture tests that separation and refuses false success through the former inactive-service shortcut. It is not an end-to-end DNSSEC acceptance test.

The public health probe requires Python3 and curl, HTTP200 and application/dns-message. It parses a complete bounded DNS message, matches the request ID and A-IN question, and requires real expected A data at the queried owner or the end of a validated CNAME chain. HNS_DOH_EXPECTED_IPV4 has no default: supply it through managed role configuration, freshly bind it to the reviewed authoritative record and actual gateway, and update it deliberately during address rotation. A stale expected address must fail the check. The retry budget must fit within110 seconds of the120-second unit bound. These checks prove resolution continuity; they do not verify DNSSEC signatures or consensus independently.

The owned role has distinct Compose service identities (doh and spv) and
containers (pirate-hns-dnsdist and pirate-hns-spv). Its private recursive and
root listeners are 15350 and 15351. Stage at the final immutable path under the
same stable pirate-hns-doh project, using a separate persistent spv directory
and the configured service UID. Existing dnsdist/hnsd-resolver services become
orphans; do not use --remove-orphans or take them down before acceptance. The
public Caddy route remains on its old upstream until the owned SPV is synced
and its actual GET/POST, DNS data and DNSSEC probes pass. Only then load the
reviewed Caddy candidate whose only routing change is the resolver upstream
from 8053 to 8054.
Retain exact prior source/configuration and container identities for rollback.
Retire the old services by exact identity only after public acceptance.

The generic Caddy candidate builder preserves either reviewed DoH upstream
unchanged, so preparing an unrelated HNS gateway candidate cannot switch the
resolver while this role is being adopted. Public routing, gateway manifest
and application bindings are separate from staging an owned resolver.

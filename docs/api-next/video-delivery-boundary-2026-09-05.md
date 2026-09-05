# Video delivery implementation boundary

This is an incomplete delivery-lane checkpoint based on main 3a3b3637.
The delivery writer owns the separate feat/video-delivery-completion worktree;
execution and Solid worktrees were inspected only where needed, never edited.

The first repair preserves a published video as pending when the left join
finds no Stream ingest row. Missing columns, inconsistent bound identity and
unsupported intents still fail closed. Digest binding no longer proves ready
playback: current schema has no durable encoding or configured-access fact.
The mapper cannot emit ready until that authority is implemented. Feed and
guarded Post tests exercise absent, not-started and bound states, retaining
the privacy-negative and age-gating fixtures.

This repair does not add an enrichment consumer, access endpoint, thumbnail
serving route or provider call. It must not be reported as the completed lane
or as playback acceptance. It changes no SQL, migration, generated contract
or client artifact. Current client provenance remains 0.61.0.

Execution owns 0120_video_workflow_execution.sql, grants/gateway, shared
composition and publication-intent production. The shared-ownership agreement
in the delivery record now governs integration. Delivery consumes those
interfaces rather than creating another gateway or ledger, and allocates its
migration only after execution's 0120 merges and a fresh inventory check.
No later migration number is reserved here. The combined client release must
still reconcile execution's membership-loss semantics.

The owner adopted a five-minute token derived from the 180-second asset bound
plus 120 seconds of headroom, with activity-conditioned renewal after four
minutes and no download entitlement. Every issuance and renewal performs the
same current eligibility check. The delivery record freezes rate limits,
rotation and the accepted legitimate-token revocation window. The staging
record owns actual routine/incident key-rotation proof; local tests do not
prove provider invalidation or revocation of previously delivered media.
The configured customer host must be validated; no account-specific host or
signing key is assumed or provisioned. Provider configuration and actual
enforcement remain staging evidence, not facts inferred from documentation.

Cloudflare documents requireSignedURLs as the control that removes bare-ID
access, and signed tokens replace the ID in player/manifest paths. These are
design references only:
https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/
https://developers.cloudflare.com/stream/uploading-videos/upload-via-link/

Completion still requires the durable enrichment/recovery consumer, separate
encoding/error facts, eligibility-checked access and poster routes, the
combined immutable client release, PostgreSQL and required CI gates, final
review, preservation and lane retirement. Live Stream and combined browser
proof remain in video-original-audio-staging-proof.

The next local tranche adds the pure Stream ingest decisions, adapted from
the retired sealed-source spike's no-recopy rule. Only a successfully persisted
initial intent grants one copy; replay, an empty lookup and timeout never do.
Exact creator/digest/provider binding is separate from encoding readiness.
Unsafe signed-access/download configuration, conflicting identities and
multiple matches require reconciliation. Terminal encoding failure retains
the provider identity, and observations retain the original attempt deadlines.

These decisions are not yet a reachable consumer. A durable interpreter must
reload authoritative source facts, persist transitions with compare-and-swap,
and give copy permission only to the winning writer. It must validate provider
observations, use execution's grant issuer and durable waits, and fence stale
observations. Deadline values require recorded policy at composition time;
test clocks here are synthetic, not production deadline selections. No new
public port, provider driver, SQL schema or Worker composition is introduced.

# Video delivery implementation boundary

## Current poster adapter tranche — 2026-09-05

Delivery rebased cleanly onto origin/main aaafc02e. Main now carries client
0.62.0 and 0120_hns_root_health_renewal_recovery.sql; the earlier execution
reservation of 0120 is no longer available. Execution still integrates first,
but its migration number must be reconciled against this actual inventory.
Delivery has allocated no migration and made no client cut.

The poster adapter now calls the shared authorization before resolving the
sealed artifact or reading R2. Its authority query joins the publication's
exact submission, operation, video and analysis revisions to the poster row
and analysis source digest. It derives the storage key from those facts and
requires the exact expected artifact reference, never stripping a client URI.
The storage reader checks key, digest metadata, source identity, poster policy,
JPEG type, size and ETag before either bytes or a conditional success. It passes
the existing ReadableStream directly into the response without another copy;
304 and pre-response failures cancel unused bodies. Each admitted request
currently performs one artifact query and one R2 get in addition to the shared
authorization reads. Conditional requests still read and validate the object;
the feed-scale latency/bytes measurement remains unperformed.

Authorized missing or unreadable artifacts now return a redacted system error.
Ineligible viewers still receive the uniform privacy denial and never resolve
an artifact. Fixture tests establish this distinction and stream ownership,
not real R2 or provider acceptance. The new authority SQL still needs a real
PostgreSQL fixture. Cloudflare and Workers best-practices skills informed the
direct stream handoff and cancellation. The current R2 API reference is design
evidence: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/.

No access endpoint is registered yet. The frozen endpoint definition supports
JSON responses, not JPEG/304; the coordinator-mediated response-contract
extension remains the prerequisite for the registered poster route. Do not use
beforeDecode or another route bypass. Production composition and the Workerd
HTTP harness both call createHttpWorker, which owns the middleware stack.
The required matching-ETag denial test must execute the registered poster
operation through that constructor after the contract extension, not just this
response adapter. Production media-processor composition remains untouched
until execution integration. Full PostgreSQL and CI remain pre-PR gates.

## Earlier checkpoint history

The following paragraphs describe earlier tranches and their then-current
boundaries; the current section above supersedes their inventory and artifact
status. None establishes backend deployability or staging acceptance.

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
# Playback policy implementation boundary — 2026-09-05

The limiter now has a SQLite-backed Durable Object implementation and an
HMAC-pseudonymizing adapter. It sequentially charges source, source/post and
post budgets with no rollback after a later refusal. The counter retains one
window row per object, rejects changing bucket kinds and fails closed on
backward window movement. Workerd tests exercise concurrent admission and
window rollover. Test-only bindings do not establish production composition.

The security loader requires the configured customer host, signing-key ID,
base64 private JWK, base64 32-byte HMAC secret and limiter namespace before
returning dependencies. It imports nonextractable keys and redacts malformed
secret errors. Local test keys are not Cloudflare acceptance evidence. Production
binding declarations, secret classification and awaiting this loader at the
actual composition boundary remain outstanding; no provider secrets were read.

Before staging, measure poster serving alongside mixed-feed join cost at
1, 10 and 20 video items, including fresh bytes and matching-ETag revalidation.
Record authorization/database round trips, R2 reads, bytes served and latency
distribution for public and eligibility-gated viewers. Every request must still
authorize; do not add a batch/cache bypass to reduce the measured cost. This
is an explicit measurement obligation, not a measurement result.

Playback and conditional-poster use cases now call authorizeVideoAccess.
The shared PostgreSQL publication-approval adapter performs one current-policy
query and returns only a boolean, including revision/rights and hold checks.
The existing publication fixture exercises public and member access, missing
posts, age denial, hidden posts and re-opened safety holds against Postgres 17.
Paired caller fixtures compare identical serialized error status/body across
denials and prove matching-ETag requests cannot skip approval.

The poster result is an internal serving descriptor, not a response exposing
the artifact locator. Actual JPEG reading, registered HTTP routes and their
middleware-ordering regression remain outstanding. A use-case test does not
prove the future HTTP transport cannot intercept conditional requests early.
Playback-ready and poster artifact resolution adapters, limiter and secret
loading also remain outstanding. This tranche introduces no client cut or
schema migration and does not establish deployability.

The signing adapter now generates minimal RS256 tokens using an injected
private CryptoKey and configured key identifier, with expiry bounded by the
frozen policy. Ephemeral local-key tests verify signatures and exact claims;
they do not prove Cloudflare accepts the tokens. The deployment-secret importer,
rotation composition and HTTP wiring are still outstanding. No provider key
was read, created or rotated. The Cloudflare skill's current Stream reference
informed the claim shape; its example geo rules are intentionally not adopted.

The application playback-access use case now exercises anonymous access,
current-policy renewal denials, pending-state denial, limiter failure,
redacted provider failures, bounded lifetime and trusted customer-host policy.
The opaque playback reference is resolved through a dedicated durable-approval
interface before selecting the signing subject; it is not interpreted as a
Stream UID. Fixture implementations do not establish durable authorization,
distributed rate enforcement, cryptographic signing or provider acceptance.

This use case is not an HTTP endpoint. Concrete approval, signer and global
rate-limit adapters, endpoint registration and private no-store response
headers remain outstanding. The JPEG/304 poster response also requires the
coordinator-mediated response-contract extension; no transport bypass is added.
Consumer and compare-and-swap integration retain the execution-first sequence.
There is no new migration or client release in this checkpoint.

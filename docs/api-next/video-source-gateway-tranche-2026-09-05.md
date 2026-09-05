# Video source gateway checkpoint

The initial checkpoint 2ee26d7 implemented the dedicated Worker boundary before
the grant migration was reserved. It did not deploy, enable video, issue grants,
or query a grant table. Its default entrypoint returned a sanitized 503 for
valid source requests. The durable follow-up below supersedes that closed
composition; deployment and video activation remain outside this tranche. Unknown paths and
query-bearing requests return 404, including requests with write methods.

## Capability and replay policy

Capabilities will be 32 random bytes encoded as 43 base64url characters. Only
the SHA-256 digest will be stored. Request identity has a non-unique index;
multiple grants may share a request id. Issuance neither recovers an earlier
bearer nor revokes earlier grants. There is no issuer secret, encrypted bearer,
or capability echoed in a resolved grant record. Revocation remains an
operator action, and expiry is bounded by the consumer's supplied ceiling.
The consumer vocabulary remains qencode and stream, allowing Stream to use a
longer ceiling without changing the schema.

The runner persists submitting before grant issuance and provider start. A
replay observes the stored provider token instead of entering submit again.
An accepted start with a lost response and a crash before sending start cannot
always be distinguished. Both retain the two bounded observation windows and
then reconciliation; neither permits a second start. Grant issuance does not
relax that conservative policy or promise request-id replay of a bearer.

No migration file, checksum, baseline, insert, or resolver SELECT is added in
this checkpoint. The ordinal must first be reserved in the execution record
while the control plane is quiescent and checked against freshly fetched
origin/main. The issuer SQL and resolver SQL will land with that reserved file.

## Worker and diagnostic boundary

The configuration declares only CONTROL_PLANE Hyperdrive and
MEDIA_IMMUTABLE_ORIGINALS R2 in development, staging, and production. The fetch
handler exposes only the existing source gateway protocol. Its R2 interface
contains head and get, with no write operations. Resolver injection is a
construction seam for tests, not a deployed binding or request input.

Invocation logs and traces are disabled in every environment. Custom logs
contain only closed event types. Dependency exceptions are caught without
serializing their messages, causes, URLs, or SQL. The Workerd tests intercept
console methods and reject capability, object-key, and digest leakage across
served, expired, range-rejected, and exception paths. These are local handler
and configuration proofs, not an audit of hosted account logging settings.
Cloudflare's invocation-log configuration is documented at
https://developers.cloudflare.com/workers/observability/logs/workers-logs/.

The Workerd suite uses the actual Worker handler and local R2 binding. Only the
grant resolver is a fixture. It proves HEAD, full GET, single and suffix ranges,
multi-range 416, query and unknown-path 404, expiry on each request, replacement
409, sanitized dependency failure, and the default entrypoint's closed state.
It is included in bun run test:workerd and therefore bun run test.

## Deployment coordination

No hostname is selected here. workers.dev and preview URLs are disabled in all
environments, and no route is configured. A staging workers.dev hostname could
satisfy the existing credential-free HTTPS URL rules after authorization;
production requires an owner-selected hostname. The gateway must deploy before
VIDEO_SOURCE_GATEWAY_ORIGIN is pointed at it and before video is enabled.

The already merged media-processor configuration exports VideoAnalysisWorkflow;
the jobs Worker references that processor script through its binding. The first
deployment of the owning processor configuration registers the class and the
jobs configuration references it even with VIDEO_ANALYSIS_ENABLED=false.
Deploying these configurations is distinct from enabling or launching video
analysis. This is a coordination note for any overlapping deployment window;
no deployment or external message was performed by this checkpoint.

## Validation

The first Workerd invocation exited 1 before running tests: compatibility date
2026-09-05 exceeded the pinned runtime's supported date 2026-08-18. The Worker
now uses the repository's existing 2026-08-01 compatibility date; the focused
Workerd rerun passed all nine cases with exit 0.

The first check exposed the new app missing from the dependency matrix. After
adding it, the full unit run exposed eight fixture-inventory failures for the
same app; its fixture directory inventory is now updated. A subsequent check
caught an unknown JSONC config type in the new binding test, which now has an
explicit config shape. Focused dependency and binding tests passed 16 cases
with exit 0 after those repairs. The script-quality check reports zero findings
and one existing size-threshold informational result for check-deps.mjs.

Final bun run check passed with exit 0, including the unchanged inventory of
122 migrations. Knip remained at 0 files, 37 exports, 79 types and 0 duplicates;
existing Biome warnings were not modified. After the fixture repairs, the next
full unit run exited 1 with 3,039 passes and one pre-existing Megapot timing
failure: paces request starts only when the bounded client opts in expected
an interval greater than 15 ms and observed 14.196240000000216 ms. No timing
assertion or implementation was changed. The subsequent full bun run test,
without the concurrent check process, exited 0: 3,040 Bun tests, 20 Node tests,
and 150 Workerd tests, including all nine new gateway cases. PostgreSQL was
not run because this checkpoint contains no schema or SQL changes.

The control plane became quiescent during validation. Commit
fa31b0fbd73e8bad0ad22bdb9558fc71607dd10f reserves
0123_video_source_grants.sql after a fresh origin inventory at 46ea81d8.
The reservation passed tasks-check: 370 valid task files with two unrelated
review-date warnings. This gateway commit still contains no migration file.


Adding the gateway workspace regenerated bun.lock without changing dependency
versions. Bun also normalized the pre-existing api-client workspace metadata
from 0.46.0 to its already checked-in package version 0.62.0; this checkpoint
contains no contract or client source change and does not cut a client release.


## Durable grants and composition follow-up

The reserved 0123 migration now adds digest-keyed source grants and the
non-unique request-id and partial expiry indexes. Issuance copies version,
ETag, size, content type and canonical digest from the seal row in its insert;
physical key is derived through the shared immutable-reference mapping. The
seal reference is a foreign key with cascading grant deletion so account
cleanup cannot strand an authorization or be blocked by it. No raw capability
is a SQL parameter, stored column or resolver result. Repeated issuer calls
create independent grants without revoking the earlier grant.

The dedicated Worker now composes its durable resolver from the existing
Hyperdrive binding through the read-only control-plane runtime. Platform
connection diagnostics are suppressed in this Worker; its own closed event
vocabulary remains the only application logger. The resolver checks revocation
and expiry with CURRENT_TIMESTAMP on every lookup; the gateway also rechecks
expiry and R2 identity. Each HEAD or range GET performs one primary-key read.
Range-heavy Qencode and Stream downloads can therefore multiply database reads
per encode. This is an explicit scaling limit alongside the sweep's status
lookups, not a reason to cache capabilities at this boundary.

Hyperdrive documents STABLE functions, including CURRENT_TIMESTAMP, as
uncacheable: https://developers.cloudflare.com/hyperdrive/concepts/query-caching/.
Before deployment, verify that the bound Hyperdrive configuration has query
caching disabled for authorization reads. Local PostgreSQL tests cannot attest
hosted Hyperdrive caching settings. No additional binding or configuration
mutation was performed here.

The media-processor constructs the issuer from VIDEO_SOURCE_GATEWAY_ORIGIN
when a test issuer is absent. The variable is declared empty in all environments;
activation fails closed until it is configured. Recognition and safety remain
injected providers. VIDEO_ANALYSIS_ENABLED stays false everywhere.

Because workers_dev is false even in staging, an owner-selected gateway
hostname and route are prerequisites of the first Qencode fixture acceptance,
not merely production follow-up. The owner list is therefore: gateway hostname
and route, Workflow read token and its separately authorized Infisical mutation,
ACR sampling policy, combined unconfirmed-submission/membership-loss reason-code
waiver with delivery's client release, and reservation lifetime with cleanup.
Gateway deployment precedes origin configuration and video activation.

A gateway 503 during provider download remains an author-retryable provider
failure in the current contract. The adapter now carries Qencode's documented
error_description into bounded private failure evidence, preserving a source
fetch versus encoding explanation while redacting URLs, the known physical
key, long bearer-like tokens and digests. The evidence is at most 433 ASCII
characters and never changes the public reason code. Qencode field reference:
https://docs.qencode.com/api-reference/transcoding/. This is provider-reported
evidence, not proof that an outage originated inside Qencode.


## Durable grant validation

The focused Qencode, composition, executor and binding run passed 44 cases
with exit 0. The composed PostgreSQL/Workerd run passed 15 cases with exit 0.
The added case, durable source grant composition: submit replay preserves one
grant and start per capability, drives the real queue Worker and exported
Workflow class, loses an accepted start response, replays submit, and reaches
one Post. Its three source URLs have the configured origin, a 43-character
capability and no query. PostgreSQL retains one grant per capability, and the
default gateway resolves those issued grants and serves HEAD through its
read-only database composition. The existing terminal-provider retry drill now
also asserts durable, redacted source-download failure evidence.

The grant, foundation and migration-ledger suites passed 22 cases with 268
assertions and exit 0. This includes five grant cases for digest-only storage,
non-unique request identity, seal mismatches, expiry, revocation, Stream's longer
ceiling, and database constraints and indexes. Baseline schema, reset SQL and
checksums were regenerated. An earlier run failed catalog equality because
BETWEEN changed expression grouping across dump/replay; the migration now uses
explicit lower and upper bounds. A second run found the new table misplaced in
the foundation's sorted inventory. Both failures were corrected without
weakening assertions. No merged migration changed.

Final bun run check passed with exit 0 and a consistent 123-migration inventory.
Earlier attempts found an unsupported toWellFormed type, a URL/Request overload
mismatch in the composed test, and the expected untracked-migration guard before
SQL and checksums were staged together. Those are corrected. Knip remains at
37 exports and 79 types with no unused files or duplicate exports. Script-check
has zero findings; extracting the media binding manifest reduced the existing
binding test below 800 lines without raising a baseline.

The gateway Workerd suite passed all nine cases with exit 0. Two exploratory
attempts to use an unavailable socket as its default-composition fixture did
not settle within 5 and 15 seconds. The cause was not established. They are not
a successful database-outage timing proof. The committed case instead uses
invalid control-plane configuration deterministically, while the resolver
exception fixture proves bare 503 and secret-free logs and the composed grant
case proves a real database read. Hosted and socket-outage timing remain an
explicit follow-up before staging acceptance; no shared PostgreSQL timeout or
test assertion was weakened to hide the result.

No deployment, hostname selection, credential provisioning, public contract
change, or video activation occurred. The full PostgreSQL and remote gates
remain due at pull-request preparation; the results above are the focused
tranche gates. The owned PostgreSQL test container is stopped after use.

The final ordinary `bun run test` exited 0: 3,041 Bun tests, 20 Node tests, and 150 Workerd tests passed. The full PostgreSQL and remote required gates remain due at pull-request preparation; these focused results do not replace them.

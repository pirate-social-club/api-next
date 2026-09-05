# Video source gateway checkpoint

This checkpoint implements the dedicated Worker boundary independently of the
unreserved grant migration. It does not deploy, enable video, issue grants, or
query a grant table. The default entrypoint returns a sanitized 503 for valid
source requests until the durable resolver is composed. Unknown paths and
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

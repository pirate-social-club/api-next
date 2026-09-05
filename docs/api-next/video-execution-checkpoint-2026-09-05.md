# Video execution implementation checkpoint

This is a partial checkpoint for `api-video-execution-completion`, based on
api-next `7d3c8aae`. It does not establish deployable video analysis or playback.
The control-plane activation is `8029bf1` and the implementation register
checkpoint is `496f30e`. Renewal is committed as `8d3aef46`; Workflow transport
groundwork is committed as `9e9044ce`. The task remains active.

## Multipart renewal

The PostgreSQL reproduction uses the application reserve, create-submission,
and renew commands with real publication and persona stores and a fake
multipart gateway. Before the repair it failed with `Video upload action
expired`, code `conflict`, reason `action_expired`, immediately after claim.

Both renewal guards now accept an unfinished claimed reservation. The
finalize manifest, terminal reservation state, ownership, and database expiry
guards remain effective. The regression checks single-part renewal, unchanged
other-part URLs, exact response replay, changed-payload idempotency conflict,
the reservation deadline, and stale renewal after finalize has committed.
Browser restart, source Blob retention, actual R2 uploads, cancellation races,
and batch renewal are not proved by this test.

The test also exposed a renewal replay lookup against the reservation-creation
table. The lookup now reads the command replay table with the same endpoint
and idempotency key used by the transactional writer. Sequential replay no
longer re-signs the part before discovering the stored response.

Reservation `expires_at` and per-part `expires_at` already occupy separate
tables. No migration was added. The hard reservation maximum remains one
hour, and the requested renewed URL lifetime is capped by the remaining
reservation lifetime. The longer mobile-upload retention policy remains open;
this checkpoint cannot recover an upload reopened after that hard deadline.
The existing plain repository error on a finalize/renew race still needs the
task's typed-conflict treatment.

## Workflow transport groundwork

The exact DATA SHA-256 encoding function now lives in shared orchestration
primitives. DATA still resolves to the same `drw-` identifiers. Video uses
that function with `vaw-`; get and create share it, and the exact logical
effect identity remains the sole Workflow payload field.

Transport tests cover accepted create with a lost response, duplicate create,
confirmed absence, distinct creation revisions, retained terminal instances,
unexpected status, transport errors, and impossible result cardinality.
Cloudflare documents that duplicate `createBatch` IDs are skipped and excluded
from its result, unlike `create`. The shared cardinality classifier follows
that contract. See the [Workers API documentation](https://developers.cloudflare.com/workflows/build/workers-api/#createbatch),
checked on 2026-09-05; the pinned workers-types comment about duplicate batch
IDs is older than that documented behavior.

The adapter is not wired into the concrete Worker. Queue launch accounting,
the Workflow runner, allocate/start separation, durable provider waits,
per-capability deadlines, PostgreSQL recovery authority, and cron redispatch
are still required. These transport tests do not count as composed queue or
lost-launch sweep acceptance. Concrete providers, source grants, publication
wakeups, retry identity, failure disposition, sealing recovery, and delivery
remain open under the existing execution and delivery records.

## Validation

The focused publication, multipart, and PostgreSQL checks passed 13 tests.
Shared encoding, DATA, and video transport checks passed another 13 tests.
`bun run check` passed, including unchanged contract/client provenance,
dependency rules, Worker types, and the 119-migration inventory. The local
secret-boundary function audited all nine changed source/test paths with no
violations; no remote PR check was run.

The first `bun run test` run failed an unchanged Megapot timing assertion:
`Expected: > 15; Received: 14.216568000000734`. Its isolated rerun passed with
no code changes. The complete rerun passed 2,947 unit tests, 20 Node tests,
and 131 workerd tests. This retains the initial failure in the evidence.

The standard `bun run test:postgres` command hit its general-suite 900-second
limit and reported `general PostgreSQL suite failed with exit 143`. It had
completed 49 of the 53 tracked files without an assertion failure and had
started `media-persistence.pg.test.ts`. The interrupted file and the three
unstarted files (`community-creation-repository.pg.test.ts`,
`public-post-slug-repository.pg.test.ts`, `study-v2-foundation.pg.test.ts`)
then passed as a separate required-mode run: 38 tests in 84.59 seconds.
All 53 tracked files completed across the two runs, with 361 distinct passing
test names and no assertion failures. The standard command itself did not
pass; this is complete local suite coverage with a recorded harness timeout,
not a green remote PostgreSQL gate. The shared `/tmp` sentinel aggregate was
not treated as independent run-specific evidence. Required CI remains open.

The full unit/workerd rerun log is
`/tmp/api-video-execution-tests-retry-20260905.log`. PostgreSQL logs are
`/tmp/api-video-execution-postgres-20260905.log` and
`/tmp/api-video-execution-postgres-continuation-20260905.log`; the exact
remaining-file inventory is
`/tmp/api-video-execution-postgres-remaining-20260905.json`.

The local harness used a dedicated `api-video-execution-host-pg17` container
on port 55439. Published Docker port connections reset, so the documented
host-network harness workaround was used. No provider, deployment, push,
PR, or live browser acceptance was performed. Both task-owned test containers
were stopped after verification; no unrelated container was changed.

The control-plane record at `496f30e` predates this final PostgreSQL result.
Its final validation refresh is deferred while another control-plane writer
has uncommitted work. This note preserves the completed local evidence without
changing task status or claiming the Workflow integration milestone.

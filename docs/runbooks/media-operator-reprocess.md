# Recovering a terminal song workflow

This command is for an operator using existing PostgreSQL administrator access.
It has no browser endpoint and does not grant users or moderators new permissions.
The database login must be a superuser or have the database-owner role available
without SET ROLE. The audit principal comes from PostgreSQL session_user; it
cannot be supplied in the request. A shared administrator credential identifies
that database role, not an individual operator. The evidence reference must link
to the reviewed operation and its accountable operator role.

Use this only for processing_failed with workflow_terminal_unconverged after
reviewing the persisted operation, provider effects, and the terminal Workflow.
For already-published authority, reconcile the existing publication/alignment;
this command refuses to reopen a publication. Do not use it to bypass moderation,
change ownership or reset provider attempts and automatic retry counters.

The reviewed operator action explicitly resets workflow_replacement_sequence to
zero. Its immutable audit and event record the previous value and the reset value.
This restores up to three automatic replacements if the fresh instance is lost,
including when the previous allowance was exhausted. It does not change retry_count,
provider attempt identities, historical outbox delivery counts, or paid-call
authorization. An ordinary sweep cannot reset the allowance. A zero-sequence
replacement launch requires its exact operator audit in the same transaction.

Prepare a JSON request containing exactly these fields:

```json
{
  "communityId": "target-community",
  "submissionId": "target-submission",
  "actorUserId": "song-owner-id",
  "idempotencyKey": "reviewed-reprocess-request-id",
  "evidenceRef": "operator-review-evidence-reference",
  "expectedCreationRevision": 2,
  "expectedWorkflowRevision": 1
}
```

Supply CONTROL_PLANE_POSTGRES_ADMIN_URL through the authorized secret runner.
Do not put it in the command line, request file, logs, or evidence. Run from the
api-next checkout with its frozen dependencies:

```sh
bun scripts/media-operator-reprocess.ts --request /path/to/request.json
```

The default reads the database identity and target authority without writing.
Compare that output to the reviewed database, submission and revision pair.
A preview is not an execution reservation: the transaction rechecks authority
under a row lock. Once the live operation is separately authorized, execute:

```sh
bun scripts/media-operator-reprocess.ts --request /path/to/request.json --execute
```

The transaction binds the request hash, operator principal, audit action, event
and fresh workflow launch to one revision change. Reusing the identical request
returns its original result. Reusing the key with changed contents is a conflict;
a new key with stale revisions is refused. Preserve the JSON receipt with the
review evidence. If the process loses its response, repeat the identical request
rather than generating a new key. Never decrement revisions or delete audit rows
to retry an uncertain outcome.

The command itself makes no provider calls. Its launch can be consumed by the
running pipeline and cause subsequent provider work, so execution authorization
must include that consequence and its budget. A committed launch is not proof
that recovery has completed. Inspect the outbox, Workflow and submission through
the normal observation surfaces until it converges or produces actionable review.

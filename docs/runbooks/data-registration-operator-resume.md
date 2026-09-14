# Resuming a reconciliation-required DATA registration

This command is for an operator using existing PostgreSQL administrator access.
It has no browser endpoint and does not grant users or moderators new
permissions. The database login must be a superuser or have the database-owner
role available without SET ROLE. The audit principal comes from PostgreSQL
session_user; it cannot be supplied in the request. A shared administrator
credential identifies that database role, not an individual operator. The
evidence reference must link to the reviewed operation and its accountable
operator role.

Use this only for a DATA registration in reconciliation_required after reviewing
the persisted operation, its transaction and its receipt observations. Terminal
reconciliation itself completes a confirmed song from its persisted terms and a
confirmed video through the media-kind projection fence; it fails a reverted
receipt and leaves pending or unavailable evidence durable. This command is for
the cases those paths cannot converge: an inconclusive receipt, or a confirmed
observation recorded before the attached terms were persisted. It returns the
existing attempt to observation under a fresh workflow revision without
signing, broadcasting or resubmitting anything: the attempt keeps its
transaction hash, so the resumed Workflow observes the same transaction again.

Do not use it to bypass moderation or ownership, to change the transaction
identity, or to reset provider attempts. The action records the expected and
resulting workflow revisions and is append-only.

Prepare a JSON request containing exactly these fields:

```json
{
  "registrationOperationId": "data-registration:1315:asset-id:1",
  "idempotencyKey": "reviewed-resume-request-id",
  "evidenceRef": "operator-review-evidence-reference",
  "reasonCode": "receipt_inconclusive",
  "expectedWorkflowRevision": 1
}
```

reasonCode is `receipt_inconclusive` or `terms_evidence_unavailable`.

Supply CONTROL_PLANE_POSTGRES_ADMIN_URL through the authorized secret runner.
Do not put it in the command line, request file, logs, or evidence. Run from the
api-next checkout with its frozen dependencies:

```sh
bun scripts/data-registration-operator-resume.ts --request /path/to/request.json
```

The default reads the database identity and target authority without writing.
Compare that output to the reviewed operation and revision pair. A preview is
not an execution reservation: the transaction rechecks authority under a row
lock. Once the live operation is separately authorized, execute:

```sh
bun scripts/data-registration-operator-resume.ts --request /path/to/request.json --execute
```

The transaction binds the request hash, operator principal, audit action, the
resumed attempt, the advanced workflow revision and the pending replacement
launch to one revision change. Reusing the identical request returns its
original result. Reusing the key with changed contents is a conflict; a new key
with a stale revision is refused. Preserve the JSON receipt with the review
evidence. If the process loses its response, repeat the identical request
rather than generating a new key. Never decrement revisions, delete audit rows
or edit the attempt to retry an uncertain outcome.

The command itself makes no provider calls. Its launch is consumed by the
running pipeline, which observes the chain and can cause subsequent provider
work, so execution authorization must include that consequence and its budget.
A committed launch is not proof that recovery has completed. Inspect the
outbox, Workflow and operation through the normal observation surfaces until it
converges or produces actionable review.

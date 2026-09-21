# Audited additional DATA Workflow attempt

This path permits one explicitly requested revision-5 Workflow after the ordinary
revision-4 replacement ceiling. It does not raise the automatic budget. Migration
0195 must be installed. Only a pending revision-4 operation with no signing
attempts, transitions or receipt observations is eligible. Its current outbox
must be delivered or exhausted. No live recovery is authorized by this runbook.

The reviewed Workflow disposition is an operator assertion, not a fact proved by
PostgreSQL. Before execution, observe the exact revision-4 Cloudflare instance.
The evidence record must identify the instance, its finished or missing status,
observation time and accountable review. Present or indeterminate instances are
not eligible. Never use a database preview as proof of external termination.

Create a restricted-permission JSON request with exactly these fields:

```json
{
  "registrationOperationId": "data-registration:1315:asset-id:1",
  "idempotencyKey": "approved-additional-attempt",
  "evidenceRef": "review-record-with-workflow-status-and-time",
  "reasonCode": "explicit_additional_workflow_attempt",
  "reviewedWorkflowDisposition": "finished",
  "expectedWorkflowRevision": 4
}
```

Use an approved database administrator connection through
`CONTROL_PLANE_POSTGRES_ADMIN_URL`. The operator principal is derived from the
database session, never accepted from the request. Preview performs no writes:

```sh
bun scripts/data-registration-operator-additional-attempt.ts --request /path/request.json
```

Check pending state, revision 4, no current attempt, a terminal current outbox,
zero attempt/transition/receipt counts and no previous additional-attempt action.
Preview is not a reservation. Execution rechecks eligibility transactionally.

Only after separate live authorization covering the subsequent Workflow effects:

```sh
bun scripts/data-registration-operator-additional-attempt.ts --request /path/request.json --execute --assert-reviewed-terminal
```

The command itself performs no provider or chain call, but its committed outbox
can launch a Workflow that performs first signing and broadcast. Identical
lost-response retries replay the immutable action. A changed request or new key
conflicts: this path allows one additional attempt per operation, not a new
automatic retry loop. Never lower revisions, remove the audit or edit attempts.

If any transaction-bearing evidence exists, use terminal reconciliation and the
existing `data-registration-operator-resume` path instead. Never create another
signature or rebroadcast an ambiguous transaction through this path.

After authorized execution, observe the outbox, revision-5 Workflow, operation,
transaction and alert surfaces. Revision 5 remains above the automatic ceiling;
failure does not authorize revision 6.

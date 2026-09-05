# Video reconciliation operator checkpoint

The operator script lists current-creation attempts in required reconciliation
and resolves one attempt through the existing publication store. No migration,
contract or environment flag changes belong to this checkpoint. The control-plane
reservation amendment is still waiting behind another writer.

## Commands and effects

Run from api-next with CONTROL_PLANE_DATABASE_URL supplied through the authorized
environment. Do not paste credentials into arguments or retained output.

```sh
rtk proxy bun scripts/video-reconciliation.ts --submission <submission-id>
rtk proxy bun scripts/video-reconciliation.ts --submission <submission-id> --attempt <request-id>
rtk proxy bun scripts/video-reconciliation.ts --submission <submission-id> --attempt <request-id> --derived-bucket <bucket-name> --apply
```

The first command prints identifiers, stored provider token, capability, phase
and the last observation status. The second previews without provider or R2 calls.
Apply requires an explicit CLOUDFLARE_ACCOUNT_ID and bucket name, plus the existing
Wrangler authentication. It opens an ephemeral remote R2 binding session with no
Worker route or deployment. The temporary config has only the derived bucket;
proxy disposal and temporary-file cleanup run in finally. Live use is a separately
authorized operator action; no live provider or remote binding session was run
while building this checkpoint. Job tokens are private operator output, not a
public status surface. The script never prints exception bodies or media facts.

The observer exposes no allocate or submit operation and cannot issue grants.
It reuses Qencode observation/sealing but permits a single status request after
the automatic windows, bounded to thirty seconds. The stored runtime fence is
unchanged. Successful output sealing uses the existing first-winner artifact
identity. Completed facts are validated and artifact identities rechecked before
resolution; partial artifact recovery remains the existing observer's behavior.
Transport/unavailable outcomes leave PostgreSQL untouched. Infrastructure errors
are not translated to provider failures.

The transaction uses the event sequence read before observation. Completion
persists the immutable stage fact and clears the prohibition only when other
attempts permit it. Confirmed provider failure restores the ordinary retry policy.
Unresolved processing or not-found observations retain required reconciliation
through the existing workflow_terminal branch. This branch does not claim the
provider failed. The tool does not publish or launch a Workflow; normal recovery
remains the queue/sweep's responsibility and its continuation cap remains intact.
An exhausted continuation cap is not reset by this tool.

## Validation

Before operator edits, the reviewed safety tip passed bun run check and bun run
test, both exit 0: 3,049 Bun, 20 Node and 154 Workerd tests.

Focused operator PostgreSQL passed seven tests with 31 assertions, exit 0:
operator resolution: completed; operator resolution: failed; operator resolution:
workflow_terminal; operator refuses non-reconciliation attempt without observation;
operator transport failure writes no observation or submission state; operator
rejects a sequence change during provider observation; operator CLI lists identifiers
without provider composition. The adapter suite includes
operator observation reads expired token without allocate, grant or start.

Initial checks exposed an incorrect immutable-key import and fixture reset that
did not advance event_sequence. A later comparison used a store-returned timestamp
instead of the database value. These fixtures were corrected without weakening
production fences. A union-result TypeScript inference error was corrected with
an explicit outcome union. No full PostgreSQL or remote integration gate is claimed
by these focused results. Final repository gate results are appended below.

Final bun run check and bun run test exited 0. Ordinary totals are 3,050 Bun,
20 Node and 154 Workerd cases. The Qencode adapter suite passed 19 tests with
67 assertions, exit 0. Script-check reported zero findings. The real CLI with
missing required arguments exited 1 with only operator_refused_or_unavailable,
as intended. Workerd retained its existing pump-canceled diagnostic while all
assertions passed. The final PostgreSQL transport case uses the concrete Qencode
observer with a throwing status transport and proves no database writes.

The user subsequently authorized the full integration sequence once the control
plane clears. The reservation amendment, migration rename, full PostgreSQL gate,
remote checks and merge remain pending; this local checkpoint does not claim them.

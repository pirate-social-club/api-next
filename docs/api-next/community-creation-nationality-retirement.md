# Creator nationality retirement

This candidate implements the creator-verification removal in Spec 006's
2026-09-19 amendment. New creation intents author the member policy without
issuing a creator nationality requirement or checking the owner's document
evidence. Join and handle-claim verification retain their existing behavior.
Nationality-only membership is a separate, subsequent change.

Migration 0193 expires optional-route intents waiting on creator nationality,
and nationality drafts stored as `gate_unsupported`. It increments their
revision and preserves the original revision snapshots. A retry of a retired
nationality request returns the expired intent instead of its obsolete action.
Other unsupported drafts are unchanged. Historical nationality states, attempts,
proof sessions and completion events remain stored. Pending and failed creator
states expire; satisfied and unmet states remain unchanged as historical records.
An unmet state never issued a ceremony and cannot become active after cutover. Database guards reject new
creator nationality states and attempts and further updates to creator states.
Late proof callbacks cannot advance an expired creation intent.

## Deployment readback

Deployment is not part of local implementation. Before an authorized staging
cutover, record the deployed Worker version, API client version, and the actual
`NATIONALITY_AUTHORING_ENABLED` value. Read the deployed configuration rather
than inferring it from a checked-in default. Keep nationality authoring disabled
until its separately reviewed policy implementation is deployed.

Run the following aggregate readback before and after migration in the target
application schema. Store the results with the deployment record. It contains
counts only; do not export proof payloads or actor identifiers.

```sql
SELECT creation_contract_version, status, count(*)
FROM community_creation_intents
WHERE jsonb_path_exists(draft,
  '$.policy.accessPaths[*].requirements[*] ? (@.requirement == "nationality-allowed")')
GROUP BY creation_contract_version, status
ORDER BY creation_contract_version, status;

SELECT status, count(*)
FROM nationality_requirement_states
WHERE action_kind = 'community_creation'
GROUP BY status ORDER BY status;

SELECT count(*) AS retained_creator_attempts
FROM nationality_ceremony_attempts
WHERE action_kind = 'community_creation';
```

Confirm that affected waiting and unsupported intents become expired, that
satisfied evidence and attempt counts are retained, and that a new Palm draft
creates successfully. With authoring disabled, a nationality draft must remain
`gate_unsupported` and expose no creator ceremony. Verify an old request retry
returns expiry and that existing join and handle-claim ceremonies still work.
Record the flag value and Worker version again after cutover.

Migration 0193 takes exclusive locks on the three affected tables and briefly
disables the creation update guard inside its transaction. Deploy under a write
fence or a coordinated maintenance window so an old Worker cannot issue creator
ceremonies during the change. Release the fence only after the new Worker and
readbacks are verified. Do not roll back to a Worker that issues retired creator
states against this schema; recovery requires an explicitly reviewed forward
change. Historical evidence is not a rollback mechanism.

## Client transition

The local client candidate is `@pirate/api-client` 0.84.0. Its artifact digest
and source base are recorded in `api-client-v0-84-0-handoff.json`. Version 0.83.0
is reserved by another existing lane. The exact-base breaking-change waivers
cover only removal of `requirements.nationality` from creation responses under
the ratified amendment. Re-evaluate the diff if the integration base changes.

The Solid consumer must regenerate or update against the accepted artifact
before enabling dependent creation surfaces. Avatars remain gated until their
storage and persistence contract lands; nationality selection remains gated
until document-only membership is implemented. This candidate neither provisions
storage nor enables either flag.

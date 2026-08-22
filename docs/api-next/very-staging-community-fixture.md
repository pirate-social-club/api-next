# Very staging ceremony fixture

This runbook describes the narrow staging-only data fixture used to exercise
the real `very.web` join ceremony without enabling HNS or fabricating identity
evidence. Drafting and testing the fixture does not authorize running it.

The fixture creates exactly four runtime records in one transaction:

1. an active, gated `communities` row with `human_verification_lane='very'`;
2. the canonical curated-human `policy_versions` row for that community;
3. the exact `very.web` provider binding; and
4. the matching `community_policy_current` pointer.

The operator supplies an existing active `users.user_id`. That persisted role
identifier is stored in `communities.created_by_user_id` and
`policy_versions.created_by_user_id`; no personal name belongs in the script
or runbook. The community id must begin with
`community-very-staging-fixture-`, making synthetic rows obvious in audits.

## Safety boundary

The command refuses every environment except `API_NEXT_ENV=staging`. Dry-run
is the default. Applying requires both `--apply` and `--confirm-staging`, plus
separate authorization to mutate the staging database. The connection is read
from `CONTROL_PLANE_POSTGRES_ADMIN_URL`; its value must never be logged or
committed.

The seed is idempotent only for an exact active fixture. Conflicting or partial
rows fail closed. A deactivated fixture is never silently reactivated.

The fixture deliberately creates no community-creation intent, canonical
route, HNS evidence, proof session, subject key, receipt, assertion, or
membership. The live ceremony must create all identity evidence through the
normal API.

## Dry-run and apply commands

Inspect the seed without mutation:

```sh
API_NEXT_ENV=staging bun scripts/very-staging-community-fixture.ts seed \
  --community-id community-very-staging-fixture-acceptance-v1 \
  --operator-user-id <persisted-operator-user-id> \
  --dry-run
```

After explicit staging-database authorization, apply the exact same arguments
with `--apply --confirm-staging`.

After desktop and mobile acceptance, inspect deactivation without mutation:

```sh
API_NEXT_ENV=staging bun scripts/very-staging-community-fixture.ts deactivate \
  --community-id community-very-staging-fixture-acceptance-v1 \
  --operator-user-id <persisted-operator-user-id> \
  --dry-run
```

After separate confirmation, apply deactivation with
`--apply --confirm-staging`.

Deactivation changes only the `communities` row: `status` moves from `active`
to `hidden`, and `updated_at` records that transition. The policy version,
provider binding, and current-policy pointer remain unchanged as auditable
records because policy and binding history is append-only. This is a functional
deactivation, not deletion.

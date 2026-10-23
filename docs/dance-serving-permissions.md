# Dance and notification release permissions

The Rewards-off candidate introduces private function boundaries used by HTTP,
Jobs, media processing and the separately deployed video source gateway.
Applying migrations does not grant those serving connections access. Native
upgrade evidence confirmed permission refusals before the missing grants.
Every consumer now receives a read-only permission preflight before upload
through the maintained provenance deployment command, even with intake and
Rewards disabled. Maintenance and ordinary notifications remain composed.

The source contract names exact required function signatures per consumer.
HTTP uses account/review reads and commands, private media leases, notification
reads, the song summary and existing Palm lock. Jobs uses notification delivery
and recovery. Media uses its processor and review-worker purposes for retention,
cleanup and publication. The gateway uses its three private source resolvers
and six existing read-table dependencies. This gate does not require the gateway
to gain account or media-write functions. When consumers share a database
principal, the reviewed role plan combines their requirements.

The preflight opens one repeatable-read, read-only transaction using the actual
serving credential. It checks schema usage, no schema creation, the actual
login/session, elevated membership including SET ROLE paths, trusted owners and
exact definer/search-path shapes. It rejects missing grants, PUBLIC execution,
operator/private-helper execution and any table or column access to the46private
Dance relations. Existing gateway read dependencies must already be readable.
It never grants a permission or reads participant records. Failed upload gates
report known object signatures, not credentials or dependency exceptions.

The render-only command produces a transaction-bounded plan with an exact
source migration-ledger fingerprint, selected role/schema/consumers and plan
digest. It validates the bound owner session, confined runtime role, schema,
function shapes, private denials and ledger before grants and again afterwards.
It calls the existing owner-only purpose binder and supplements its two frozen
context/rubric reads. It adds only the required direct function grants for
notifications, summary and Palm lock. It creates no role or credential, grants
no table access and applies nothing itself. A failure after a grant rolls back
the grant and purpose registration together.

Account erasure is reached through the existing owner trigger on account
deletion. The serving role does not receive direct execution of the private
erasure function. The earlier local prototype granted that extra purpose;
source call-path review removed it from this candidate plan. The production
source gateway is a distinct Worker at video-source.pirate.sc, currently pinned
to older source. Its successor must be included with the media release; the
four principal Worker versions alone do not establish that dependency's parity.

Generate a reviewable plan from the exact candidate checkout, repeating
`--config` for consumers that share the selected runtime principal:

```sh
bun run db:plan:dance-serving --runtime-role SELECTED_RUNTIME_ROLE --config apps/http-worker/wrangler.jsonc --config apps/jobs-worker/wrangler.jsonc --config apps/media-processor-worker/wrangler.jsonc --config apps/video-source-gateway/wrangler.jsonc
```

Use the established managed connection workflow with the exact reviewed branch
and runtime selector for the read-only check:

```sh
bun run db:preflight:dance-serving --config apps/http-worker/wrangler.jsonc
```

The uppercase role above is a placeholder to replace with the selected existing
role. Check the actual provider branch, owner, serving bindings, full-role plan
and source/package identity before applying any separately reviewed SQL. These
tools do not establish those external identities or change production authority.
No financial, policy/producer or feature admission follows from a passing probe.
This is a permission gate; it does not replace actual-prefix migration,
serving/successor Worker, publication, full qualification, erasure, provider,
storage or phone acceptance. Independent audits remain with the workspace_owner.

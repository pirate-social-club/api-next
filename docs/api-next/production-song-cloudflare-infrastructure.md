# Production song Cloudflare infrastructure

This record covers the disabled production infrastructure ceremony on
2026-08-30. It is redacted operational evidence, not deployment or activation
authority. The reviewed source is PR #175 at commit `338a982`.

## Fixed posture

The HTTP, jobs, media-processor, and DATA-registration configurations keep
media upload, media processing, DATA registration, and Megapot rewards false.
The jobs, media, and DATA configurations reuse production Hyperdrive
`884b68c5a7904982a86620ed90032b77`. DATA remains pinned to Aeneid chain `1315`
and the reviewed production testnet signer address.

No database migration, schedule activation, provider request, public upload,
queue message, wallet operation, chain transaction, or canary occurred during
this ceremony.

## Live resource inventory

The following private R2 buckets were created with Standard storage. All were
empty at creation:

| Bucket | Created UTC | Purpose |
| --- | --- | --- |
| `pirate-media-ingress-production` | `2026-08-30T09:23:58.179Z` | Browser upload ingress |
| `pirate-media-immutable-production` | `2026-08-30T09:24:01.870Z` | Sealed immutable originals |
| `pirate-media-derived-production` | `2026-08-30T09:24:04.992Z` | Derived media artifacts |

The ingress bucket is not public. Its CORS policy permits only `PUT` from
`https://app.pirate`, `https://pirate.app`, and `https://pirate.sc`, permits
only the `Content-Type` request header, exposes `ETag`, and caches preflight for
3,600 seconds.

The following empty queues were created without producers or consumers:

| Queue | Cloudflare ID | Role |
| --- | --- | --- |
| `pirate-media-processing-production` | `c43c48cef59f4447b9d0b33bae853b01` | Media ingress queue |
| `pirate-media-processing-production-dlq` | `3ac3d97124fb4fd5abdb94f1baab807e` | Media dead-letter queue |
| `pirate-data-registration-production` | `849e9911ed584ec0a43cad7ae284f529` | DATA ingress queue |
| `pirate-data-registration-production-dlq` | `9aa694e222634a6881897242a2f01223` | DATA dead-letter queue |

The unrelated learner-audio production bucket was not created by this song
infrastructure lane.

## Worker sequencing boundary

Cloudflare rejected `wrangler versions upload` for the nonexistent production
media Worker because a Worker must receive an initial deployment before it can
accept undeployed versions. The command made no Worker, Workflow, consumer, or
deployment. The same constraint applies to the nonexistent jobs and DATA
Workers, so no attempt was made against either one.

Creating those Workers therefore belongs either to an explicitly authorized
first disabled deployment or to the already registered disabled-first
deployment task. Until that authority is recorded, the production Workflows
remain absent and all four production queues retain zero producers and zero
consumers.

## Secret routing

The production DATA Worker may receive only
`DATA_REGISTRATION_PRODUCTION_AENEID_PRIVATE_KEY` and
`FILEBASE_IPFS_TOKEN`. The HTTP Worker alone may receive the two
`MEDIA_INGRESS_R2_PRESIGN_*` names. Provider credentials may go only to their
declared disabled consumer. Blanket synchronization from the shared Infisical
folder is forbidden, and secret values never belong in this record.

The Aeneid signer exists in the approved production Infisical scope. At this
checkpoint the production Filebase token and production R2 presigner identity
still require their browser ceremonies. DATA secret synchronization cannot
occur before the DATA Worker exists.

## Validation and rollback ownership

PR #175 passed the repository check, PostgreSQL 17, and secret-boundary gates.
Focused infrastructure, binding, and Infisical policy tests passed locally,
as did production Wrangler dry runs for all four configurations. A first full
unit run had one unrelated Megapot pacing failure; the exact test passed on
immediate rerun, and the complete unit suite then passed with 2,321 tests and
no failures.

The production infrastructure operator owns rollback while this task is
active. Since the buckets and queues are empty and unbound, rollback means
first proving they remain empty and unattached, then deleting only the exact
production names under separately recorded destructive authority. Never
delete or alter a staging resource, the production Hyperdrive, an active Worker
deployment, or a bucket or queue that has acquired data.

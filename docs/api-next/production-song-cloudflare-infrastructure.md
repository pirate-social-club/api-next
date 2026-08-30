# Production song Cloudflare infrastructure

This record covers the disabled production infrastructure ceremony on
2026-08-30. It is redacted operational evidence, not migration, activation,
provider-effect, or canary authority. The reviewed source is PR #175 at commit
`f88cf643254b0423c137ab953497df4d3f4a0368`.

## Fixed posture

The HTTP, jobs, media-processor, and DATA-registration configurations keep
media upload, media processing, DATA registration, and Megapot rewards false.
The production jobs configuration has no cron trigger. The jobs, media, and
DATA Workers reuse production Hyperdrive
`884b68c5a7904982a86620ed90032b77`. DATA remains pinned to Aeneid chain `1315`
and the reviewed production testnet signer address.

No database migration, provider request, public upload, queue message, wallet
operation, chain transaction, or canary occurred. The three new event Workers
have `workers_dev` and preview URLs disabled. Requests to their stable
`workers.dev` hostnames returned `404`, confirming that the queue and Workflow
consumers did not acquire public HTTP surfaces.

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

The production queues have the following reconciled state:

| Queue | Cloudflare ID | Producers | Consumers |
| --- | --- | ---: | ---: |
| `pirate-media-processing-production` | `c43c48cef59f4447b9d0b33bae853b01` | 1 | 1 |
| `pirate-media-processing-production-dlq` | `3ac3d97124fb4fd5abdb94f1baab807e` | 0 | 0 |
| `pirate-data-registration-production` | `849e9911ed584ec0a43cad7ae284f529` | 1 | 1 |
| `pirate-data-registration-production-dlq` | `9aa694e222634a6881897242a2f01223` | 0 | 0 |

The primary-queue producer is the disabled jobs Worker. Each primary-queue
consumer is its corresponding disabled event Worker. The DLQs are attached by
consumer configuration but have no direct producer or consumer. No message was
sent during provisioning.

The unrelated learner-audio production bucket was not created by this song
infrastructure lane.

## Disabled Worker and Workflow inventory

The first deployments created only the three authorized event Workers and
their declared Workflow and Queue bindings:

| Worker | Deployed version | Secret contract at deployment |
| --- | --- | --- |
| `pirate-jobs-worker-production` | `24c16272-c6ff-4921-b233-82d516fa6ed1` | `COMMUNITY_PURCHASE_FUNDING_RPC_URL` |
| `pirate-media-processor-worker-production` | `760d885a-f35c-4418-9a83-46b8aab790cd` | none while processing is disabled |
| `pirate-data-registration-worker-production` | `4a8c73fb-e06c-4a90-b21f-9358b7dcb1e6` | `DATA_REGISTRATION_PRODUCTION_AENEID_PRIVATE_KEY`, `FILEBASE_IPFS_TOKEN` |

The two production Workflows exist under the exact reviewed names:

- `pirate-media-processing-production` is owned by
  `pirate-media-processor-worker-production` and class
  `MediaProcessingWorkflow`.
- `pirate-data-registration-production` is owned by
  `pirate-data-registration-worker-production` and class
  `DataRegistrationWorkflow`.

The DATA secrets and the jobs RPC sentinel were synchronized from the
production Infisical scope by exact name through an in-memory stream. Values
were neither printed nor persisted. No blanket synchronization, placeholder,
or staging credential was used. The media provider credentials remain an
activation-time gate because media processing is false and provider effects
were outside this ceremony's authority.

## R2 presigner identity

The production R2 token is scoped to Object Read and Write on only
`pirate-media-ingress-production`. Its access-key ID and secret access key are
stored in production Infisical under the exact names
`MEDIA_INGRESS_R2_PRESIGN_ACCESS_KEY_ID` and
`MEDIA_INGRESS_R2_PRESIGN_SECRET_ACCESS_KEY`.

Only those two names were synchronized to the existing
`pirate-http-worker-production` Worker. Its four pre-existing secrets remained
present. Cloudflare recorded the operation as secret-only version
`f4af9c16-654b-4de8-9db9-8e5c71f9233d`; no HTTP code deployment occurred.
`MEDIA_UPLOADS_ENABLED` remains false, and no presigned request or upload was
created.

## Validation and remaining boundaries

PR #175 passed the repository check, PostgreSQL 17, and secret-boundary gates
at the reviewed source. Focused infrastructure, binding, and Infisical policy
tests passed locally, as did production Wrangler dry runs for all four
configurations. A first full unit run had one unrelated Megapot pacing failure;
the exact test passed on immediate rerun, and the complete unit suite then
passed with 2,321 tests and no failures.

Live reconciliation confirmed all three buckets, all four queues, both
Workflows, all three event Worker versions, the exact per-Worker secret names,
the empty production jobs schedule, and the disabled flags. Provider credential
provisioning and provider smoke tests remain separate activation gates. This
task does not authorize them, a database migration, an enabled deployment,
background product traffic, or a canary.

## Rollback ownership

The production infrastructure operator owns rollback while this task is
active. The safe immediate rollback for a newly deployed event Worker is to
restore its preceding reviewed disabled version or detach its producer and
consumer bindings. A resource may be deleted only after proving that it is
empty, unused, and unattached, and only under separately recorded destructive
authority. Never delete or alter a staging resource, the production
Hyperdrive, an active Worker deployment, or a bucket or queue that has acquired
data.

# api-next secrets contract

Status: Infisical is audited and organized. The canonical Cloudflare staging
Workers were synchronized and deployed on 2026-08-23. Production HTTP runtime
activation was authorized on 2026-08-25 and now has a dedicated Hyperdrive,
an enabled completeness policy, and the canonical `api-next.pirate.sc` origin;
the production jobs Worker remains absent. All misplaced-account
staging secrets, Workers, and Hyperdrive resources have been retired. A
secret-free zone bridge remains temporarily for resolvers that cache the old
delegation. The `pirate.sc` zone moved to the canonical account on 2026-08-23,
and both staging custom domains are attached there. Infisical confidential
values were not rendered in tool output. The current contract also permits a
reviewed, staging-only media-provider provisioning set at the api-next runtime
path. Those names are not completeness-required or synchronized to a Worker
until their disabled runtime compositions land. The disposable R2 seal proof
and its operator credential contract are retired.

Date of inventory: 2026-08-25.

## Production HTTP activation — 2026-08-25

The production HTTP Worker is `pirate-http-worker-production` in canonical
account `08a4c22cf52e2ecae883e36f80a33f4a`. Its public origin is exclusively
`https://api-next.pirate.sc`; the legacy `api.pirate.sc` origin is not part of
the target topology. Hyperdrive `884b68c5a7904982a86620ed90032b77` uses a
dedicated runtime role whose connection selects the fresh `api_next` schema in
the retained production Postgres cluster. Repository migrations `0001` through
`0048` were applied there without importing or modifying legacy application
tables.

Production `/services/api-next` contains the JWT private key, Privy secret, and
`COMMUNITY_PURCHASE_FUNDING_RPC_URL`. The funding URL is deliberately the
unusable `https://rpc.invalid/` sentinel: non-money HTTP paths can launch while
community-purchase funding remains fail-closed. The two database URLs remain
operator-only at `/services/api-next/operator` and are never synchronized to a
Worker. HNS ownership stays disabled and unbound.

## Sources of truth

| Source | Identifier | Access from this workspace |
| --- | --- | --- |
| Infisical, api-next project | project `fac45f92-9450-42fb-8c2f-f20d043fdfab`, organization `d9615445-c0d4-445a-ad58-1d55d365635a` | Reachable. `api-next/.infisical.json` now pins this project, so commands run anywhere in the api-next tree resolve it without `--projectId`. See "Local project selection" below. |
| Infisical, historical project | workspace `5acea78e-7813-4d8a-b29c-9b862a0b1c71` | Reachable. Historical reference only. Its `/services/api` folder deliberately mixes API runtime, HNS, Spaces, media, Story, and operator credentials; that mixing is the boundary defect this contract corrects. Do not copy it wholesale. |
| Cloudflare Worker secrets, canonical | account `08a4c22cf52e2ecae883e36f80a33f4a` | Reachable through the `api-next-canonical` Wrangler profile. Staging HTTP and jobs are active. Production HTTP is enabled with exactly three declared confidential names; production jobs remains absent. |
| Cloudflare zone bridge, temporary | account `ff375d61cdc0c5dc946837f3e37725e0` | Reachable through the retained default Wrangler profile. The three misplaced staging Workers, their nine installed secrets, and the misplaced staging Hyperdrive were retired on 2026-08-23. The managed, secret-free `api-next-staging-zone-bridge` remains only for resolvers caching the old delegation after the zone moved to the canonical account. An unrelated production Hyperdrive was not changed. |
| Declared Wrangler contract | `api-next/apps/http-worker/wrangler.jsonc` and `api-next/apps/jobs-worker/wrangler.jsonc` | In repository. Both Workers are in scope; earlier revisions of this document covered only the http Worker. `secrets.required` is a real Wrangler property — it drives type generation and local-dev warnings, but does not gate a deploy. See D9. |

Environments are Infisical environments. Never encode an environment into a
secret name.

## Cloudflare account correction — 2026-08-22

The canonical Cloudflare account is `08a4c22cf52e2ecae883e36f80a33f4a`.
Commit `5251933` pinned `ff375d61cdc0c5dc946837f3e37725e0` after treating
the ambient Wrangler OAuth identity as authority. That inference was wrong.
All three Wrangler account pins now target the canonical account.

The same error inverted the staging Hyperdrive inventory. Canonical account
`08a4…` already has `api-next-staging`
(`8cb7658a0f7143359c1becfec6a15c23`). The later
`pirate-control-plane-staging` configuration
(`11c1ad1806004f3b87fa771833093132`) was created in the misplaced account.
Both staging Worker bindings now point back to the canonical Hyperdrive.

Pre-cutover name-only remote inventory found this split:

| Account | HTTP staging | Jobs staging | Staging Hyperdrive |
| --- | --- | --- | --- |
| canonical `08a4…` | present; last deployment 2026-08-16; ten legacy secret names | present; last deployment 2026-08-16; zero secrets | `api-next-staging` (`8cb7658a…`) |
| misplaced `ff375…` | present; later 2026-08-22 deployment; six confidential names plus the misclassified public key ID | present; later 2026-08-22 deployment; one intended secret name | `pirate-control-plane-staging` (`11c1ad18…`) |

Before cutover, the canonical HTTP account contained the three junk
`AUTH_UPSTREAM_JWT_*` names plus seven stale JWT/Privy classifications. The
repository audit correctly failed rather than allowlisting that drift.

On 2026-08-23, the six reviewed staging runtime secrets were synchronized from
Infisical `/services/api-next` to the canonical HTTP Worker and the funding RPC
was synchronized to the canonical jobs Worker. Published, CI-green commit
`306db31` was then deployed with canonical Hyperdrive `8cb7658a…`. The jobs
version is `a45e9420-4311-4008-b82a-a79f59c8997c`; the HTTP version is
`0f4bbb36-567c-4456-9b85-b0d160bf7451`. Wrangler replaced the five public-name
collisions with vars during deployment. The three `AUTH_UPSTREAM_JWT_*` names
were then deleted in one reviewed bulk request.

The resulting Cloudflare audit reports zero violations. The canonical health
endpoint returns `{"status":"ok"}`, the live JWKS contains one RS256 signing
key, and an in-memory derivation from the Infisical private key matches that
live JWK. The verifier health endpoint also returns healthy.

Retirement inventory found three misplaced staging Workers, not two: HTTP,
jobs, and HNS owner verifier. Their nine installed secret names were deleted
before the Workers were deleted. Misplaced staging Hyperdrive `11c1ad18…` was
then deleted. Exact re-inventory confirmed all four staging resources absent.
The unrelated `pirate-control-plane-production` Hyperdrive (`7e457bc3…`) was
outside scope and remains untouched.

A follow-up name-only inventory of all 36 Workers in the old account found four
additional unreachable legacy Workers: `community-provision-operator`,
`community-provision-operator-staging`, the duplicate
`community-provision-operator-staging-staging`, and
`pirate-api-core-staging`. None had a custom domain, route, cron trigger,
workers.dev endpoint, or inbound service binding. Their 46 installed secret
bindings were deleted before the four Workers were deleted. A complete
post-delete name scan covered the 32 surviving Workers and found zero
`TURSO_*` bindings. DNS-bound legacy Workers remain only through the former
delegation TTL and must not be retired before the cache-drain verification.

Deleting the misplaced HTTP Worker also removed the public custom-domain DNS,
which proved that the misplaced account still owned `pirate.sc` at that time.
The canonical HTTP Worker deliberately exposed its `workers.dev` origin, and
managed Worker `api-next-staging-zone-bridge` contained no bindings or secrets
while forwarding the custom domain to that origin. Public health and JWKS both
returned 200 through the bridge.

On 2026-08-23 the registrar delegation moved from `adrian`/`dakota` to the
canonical zone's `nelci`/`yahir` nameservers. Cloudflare reports canonical zone
`b027d7e2ef3fc3a089713fe118eafbca` active. Custom domains
`api-next-staging.pirate.sc` and `web-next-staging.pirate.sc` are attached to
canonical Workers `pirate-http-worker-staging` and
`pirate-web-solid-staging`. Forced-SNI probes against the canonical edge
returned 200 for API health, the Solid page, and the Solid public verification
configuration before recursive caches expired. Keep the old bridge and old
Solid Worker only through the former 86,400-second delegation TTL; retire them
after public NS convergence and a final endpoint check.

The retirement exposed one value-integrity defect: the canonical
`PIRATE_APP_JWT_PRIVATE_KEY` copied from Infisical had one trailing newline.
The value was normalized without rendering it, updated in Infisical, and
resynchronized to the canonical Worker. Structural metadata confirmed the
expected PKCS8 boundaries and trim-stable form. Health and JWKS passed after
the update.

Two un-routed Workers were created while the synchronization command's target
selection was being made explicit: `pirate-http-worker-staging-staging` from
combining an environment-suffixed name with `--env`, and `api-next-staging`
from root-config discovery. Each contained only the six synchronized copies,
was deleted immediately, and was subsequently confirmed absent. No existing
Worker was deleted during that earlier target-selection cleanup; the deliberate
misplaced-account retirement described above happened later.

Every Cloudflare deployment, probe, collision cleanup, and seven-secret claim
recorded later in this document before this correction refers to the misplaced
account unless a paragraph explicitly says canonical account.

## Observed state

Metadata only for the initial inventory. During the cleanup, public
configuration values were read to populate Wrangler vars and confidential
values were compared by SHA-256 without rendering them. The approved path
copies used Infisical's server-side duplicate operation, so no confidential
value passed through this workspace.

Values were nevertheless written to disk. The CLI maintains an offline cache at
`~/.infisical/secrets-backup/`, and
`project_secrets_fac45f92-…_staging_-.json` and
`project_secrets_fac45f92-…_prod_-.json` were both written during this session.
Each holds a single `CipherText` field and is mode `0600`, so the values are
encrypted at rest under the local credential, not plaintext. This is not a
disclosure, but "values were not locally stored" is not accurate and the cache
should be cleared as part of the session hygiene below.

The project defines exactly three environment slugs: `dev`, `staging`, and
`prod`. Note that the slug is `prod`, not `production`; `--env=production`
returns a 404.

| Environment | Current folder tree and root inventory |
| --- | --- |
| `dev` | no folders and no secrets |
| `staging` | `/services/api-next` has 6 runtime entries; `/services/api-next/operator` has 2 operator entries; root is empty |
| `prod` | `/services/api-next` has 3 runtime entries; `/services/api-next/operator` has 2 operator entries; root is empty |

No HNS path was created because no approved HNS entry exists. The approved
Very sealing key is stored under `/services/api-next`; no separate Very path
was created. The service and operator copies remain the canonical Infisical
locations.
Cloudflare synchronization must use those paths explicitly on the next
authorized deployment; Infisical does not infer path changes.

The final inventory was confirmed across all three environments. Every root is
empty. Production has no alert placeholders or self-callback token. Staging and
production both carry the fail-closed `https://rpc.invalid/` funding sentinel,
so neither environment can currently serve a money flow.

## Classification of api-next project entries

The initial staging root held seventeen entries and the initial production root
held nineteen, including four alert placeholders not present in staging. The
classification below drove the migration. Both roots are now empty.

### Runtime secrets — belong on the Worker

| Name | Referenced in source | Current path copies |
| --- | --- | --- |
| `PIRATE_APP_JWT_PRIVATE_KEY` | yes | staging and prod |
| `PRIVY_APP_SECRET` | yes | staging and prod |
| `COMMUNITY_PURCHASE_FUNDING_RPC_URL` | yes | staging and prod; fail-closed sentinel in both |
| `VERY_WEB_SEALING_KEY` | yes | staging only; disabled in prod |
| `ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET` | yes | staging only; disabled in prod |
| `ZKPASSPORT_VERIFIER_SHARED_SECRET` | yes | staging only; disabled in prod |

### Operator and migration only — never synchronized to a Worker

| Name |
| --- |
| `CONTROL_PLANE_POSTGRES_ADMIN_URL` |
| `CONTROL_PLANE_POSTGRES_RUNTIME_URL` |

Neither name is referenced by api-next Worker source. The Worker reaches
Postgres through the `CONTROL_PLANE` Hyperdrive binding, so database URLs stay
in the operator path and are used by migrations and by human operators only.

### Public configuration — should leave Infisical

| Name | Referenced in source | Current disposition |
| --- | --- | --- |
| `PIRATE_APP_JWT_AUDIENCE` | yes | already a Wrangler var in all three environments |
| `PIRATE_APP_JWT_ISSUER` | yes | already a Wrangler var in all three environments |
| `PIRATE_APP_JWT_TTL_SECONDS` | yes | already a Wrangler var in staging |
| `PIRATE_APP_JWT_PUBLIC_KEY` | yes | Wrangler var in staging and prod; development value unavailable |
| `PRIVY_APP_ID` | yes | Wrangler var in staging and prod; development value unavailable |
| `PRIVY_JWKS_URL` | yes | Wrangler var in staging and prod; development value unavailable |
| `PRIVY_JWT_AUDIENCE` | yes | Wrangler var in staging and prod; development value unavailable |
| `PRIVY_JWT_ISSUER` | yes | Wrangler var in all three environments |

These values are public or derived. A public key, an app identifier, an
audience, an issuer, and a JWKS URL are all disclosed to clients or discoverable
from the upstream provider. Treating them as secrets hides real configuration
behind an access boundary without adding protection.

### Legacy entries — deleted

| Name | Referenced in source |
| --- | --- |
| `SELF_CALLBACK_CAPTURE_ACCESS_TOKEN` | no |
| `AUTH_UPSTREAM_JWT_AUDIENCE` | no |
| `AUTH_UPSTREAM_JWT_ISSUER` | no |
| `AUTH_UPSTREAM_JWT_JWKS_URL` | no |

The Self callback capture seam was parked and its Durable Object class was
retired by Wrangler migration `v3`. Its token had no current consumer. The
`AUTH_UPSTREAM_*` names were legacy JWT audience, issuer, and JWKS
configuration from the prior auth-upstream integration; they had no current
consumer and `pirate-app-staging` had no current workspace reference. All four
were deleted from staging and prod and are absent from the post-cleanup
inventory. If the auth-upstream integration is ever revived, its public
configuration must be reintroduced deliberately.

## Target path layout

| Purpose | Infisical path | Cloudflare synchronization |
| --- | --- | --- |
| api-next runtime secrets | `/services/api-next` | explicit runtime allowlist only |
| api-next migrations and operators | `/services/api-next/operator` | never |
| HNS verifier runtime | `/services/hns-verifier` | verifier Worker only |
| Public configuration | Wrangler `vars` or repository configuration | not a secret |
| Deleted legacy names | absent | never |

```
/services/api-next
  PIRATE_APP_JWT_PRIVATE_KEY
  PRIVY_APP_SECRET
  COMMUNITY_PURCHASE_FUNDING_RPC_URL

/services/api-next/operator
  CONTROL_PLANE_POSTGRES_ADMIN_URL
  CONTROL_PLANE_POSTGRES_RUNTIME_URL
```

### Staging media-provider provisioning boundary — 2026-08-26

The following names are allowed only in Infisical environment `staging` at
`/services/api-next`. They are not completeness-required while the reviewed
adapters remain disabled and runtime composition is absent.

| Name | Credential role |
| --- | --- |
| `TRANSLOADIT_AUTH_KEY` | Transloadit assembly authentication key |
| `TRANSLOADIT_AUTH_SECRET` | Transloadit assembly signing secret |
| `ACRCLOUD_ACCESS_KEY` | ACRCloud identification access key |
| `ACRCLOUD_ACCESS_SECRET` | ACRCloud identification signing secret |
| `ELEVENLABS_API_KEY` | Shared platform-funded ASR and forced-alignment key |
| `FILEBASE_IPFS_TOKEN` | Filebase bucket-scoped IPFS bearer token |
| `MEDIA_CLASSIFIER_API_KEY` | Provider-neutral media-classifier credential |

Initial provisioning uses the deliberately invalid `PENDING` sentinel for
each name. A stored name therefore records only the reviewed custody handoff;
it is not evidence of a usable provider credential or enabled integration.
Replacing a sentinel, validating provider-specific shape, and enabling an
adapter remain separate reviewed actions.

No current Worker receives these names. Future synchronization must select
only the names consumed by the exact Worker whose reviewed composition enables
that adapter; blanket synchronization of `/services/api-next` is forbidden.
The HTTP and jobs Workers must not receive any of the seven names. The shared
ElevenLabs name may be synchronized to each exact ASR or alignment consumer
only when that consumer is enabled. The Filebase and classifier names likewise
follow their owning role rather than a provider-named Worker. Any such change
must update the destination Worker's binding contract and Wrangler declaration
in the same reviewed tranche.

`MEDIA_CLASSIFIER_API_KEY` is deliberately provider-neutral. The current
OpenRouter scaffold does not own the credential name, and changing the selected
classifier provider must not require renaming its role-based secret.

### R2 seal-probe retirement — 2026-08-26

The disposable proof Worker, bucket, and operator credential pair were torn
down. The current staging operator allowlist no longer accepts the retired
proof names. Dated proof evidence remains historical evidence and does not
re-establish an active Infisical contract.

## Known drift

1. Production has no `API_NEXT_ALERT_*` entries and no production jobs Worker.
   The four names are active source bindings when production is enabled. The
   two URLs need real HTTPS endpoints and the two tokens need real credentials
   before a production deployment; the invalid root placeholders were deleted
   rather than normalized into the service path.
2. The verifier provisioning evidence records the active key ID as
   `staging-2026-08-18-01`. It is now a staging Wrangler var and has been
   removed from `secrets.required`. The canonical Worker now receives it as a
   var. The historical misplaced-account copy was deleted during retirement.
   The previous-key rotation fields remain optional:
   the two public fields are explicitly empty until a rotation is active, and
   the previous secret is not required until then.
   `VERY_WEB_SEALING_KEY` is now declared in staging `secrets.required`.
3. Staging and production Privy app IDs, JWKS URLs, and audiences are now
   declared as Wrangler vars from verified app-specific values. The api-next
   Infisical project has no development Privy app ID or public key, so the
   development vars remain unresolved rather than receiving placeholders.
4. Staging and production `PIRATE_APP_JWT_PUBLIC_KEY` and `PRIVY_APP_ID` are
   now Wrangler vars; their Infisical root duplicates were deleted. The
   development declarations remain a known classification gap until a real
   development configuration is sourced.
5. **Infisical is now a complete source for the staging Worker's confidential
   runtime contract.**
   The initial live name-only audit found five entries at `/services/api-next`:
   the three previously copied runtime secrets, `VERY_WEB_SEALING_KEY`, and
   the unexpected public-config name `VERY_APP_ID`. After its deletion, the
   path held four intended entries. On 2026-08-22 the two missing confidential
   values were streamed directly from the verifier's root-only environment
   file into Infisical with `--file /dev/stdin`; neither value appeared in an
   argument, terminal output, or local plaintext file. Infisical acknowledged
   both names as created. The CLI's encrypted cache was then deleted again.

   The path now has the six intended confidential names. The public key ID is
   a Wrangler var, not an Infisical secret. A fresh name-only REST audit on
   2026-08-23 confirmed the exact six-name runtime set and two-name operator
   set without reading values.

   The two ZKPassport secret names were recorded as Cloudflare-only in the
   very first inventory and initially had no Infisical home. They are now stored
   at the runtime path and synchronized to the canonical Worker.

6. Infisical staging and production contain
   `COMMUNITY_PURCHASE_FUNDING_RPC_URL`. Both Workers use the fail-closed
   sentinel `https://rpc.invalid/`. An authorized real environment-specific
   RPC is required before any money-flow verification.

## Naming and classification rules

These are the rules the audit below applies. A name that breaks one of them is
a defect, not a preference.

1. **One name, one meaning, one owner.** Every configuration name is owned by
   exactly one Worker boundary. `HNS_LEGACY_VERIFIER_BEARER` belongs to the
   verifier Worker; api-next must never declare it.
2. **Secret means confidential.** A value is a secret only if disclosure harms.
   Public keys, app identifiers, audiences, issuers, JWKS URLs, endpoint URLs,
   and key identifiers are configuration, and belong in Wrangler `vars`.
3. **Declared where consumed.** Every name a Worker reads at runtime must
   appear in that Worker's Wrangler config for every environment where its
   feature is enabled — as a `var` if public, in `secrets.required` if
   confidential. Deployment-time injection that is recorded nowhere is not a
   contract.
4. **No environment in a name.** Environments are Infisical environments and
   Wrangler env overlays. `staging` and `prod` never appear inside a name.
5. **Namespace prefix matches the integration, consistently.** All names for
   one integration share one prefix, and sibling flows within an integration
   share an infix. `VERY_OAUTH_*` and `VERY_WEB_*` are two flows; a name
   belonging to the web flow must carry the `WEB` infix.
6. **Database URLs never reach a Worker.** They live only in the operator path.
   Workers reach Postgres through the `CONTROL_PLANE` Hyperdrive binding.
7. **Zero orphans in both directions.** No name is consumed without being
   declared, and no name is declared or stored without a consumer.

## Audit, 2026-08-22

Scope: `HttpWorkerBindings` (`apps/http-worker/src/composition.ts`),
`JobsWorkerEnv` (`apps/jobs-worker/src/index.ts`),
`AlertSinkBindings` and `RegistrationRateLimiterEnvironment`
(`packages/platform-cf/src/`), reconciled against both Wrangler configs and the
Infisical inventory. Fifty-five distinct names are consumed by source.

Note: `apps/http-worker/src/composition.ts` and `wrangler.jsonc` changed during
this session — the Very browser verification flow was ported in. Earlier
statements in this document that `VERY_APP_ID` and `VERY_WEB_SEALING_KEY` had
no consumer were true when written and are now obsolete. Both are consumed.
Rule 5 still applies to them; see D7.

### Confirmed source names

- The four `API_NEXT_ALERT_*` production names are consumed by
  `packages/platform-cf/src/alert-config.ts`, which requires them whenever
  `API_NEXT_ENV` is `production`. The names are not junk, but the deleted root
  placeholder entries were not valid configuration.
- The four `REGISTRATION_*` vars looked undeclared-and-unused against the
  Worker bindings, but are consumed by `RegistrationRateLimiterEnvironment`
  inside the Durable Object. They are correct as declared.

### Confirmed junk — deleted

| Name | Environments | Rule |
| --- | --- | --- |
| `AUTH_UPSTREAM_JWT_AUDIENCE` | staging, prod | 7 |
| `AUTH_UPSTREAM_JWT_ISSUER` | staging, prod | 7 |
| `AUTH_UPSTREAM_JWT_JWKS_URL` | staging, prod | 7 |
| `SELF_CALLBACK_CAPTURE_ACCESS_TOKEN` | staging | 7 |

Zero consumers in the workspace. The Self capture seam's Durable Object class
was retired by http-worker migration `v3`. All four entries were deleted from
staging and prod, then re-inventoried.

### Open defects

**D1 — production alert configuration is absent.** `pirate-jobs-worker`
consumes all four `API_NEXT_ALERT_*` names in production. D1a is complete: the
two token names are declared in its production `secrets.required` list. D1b and
D1c remain open because no authorized URLs or token values exist; no production
jobs Worker is deployed. The invalid root placeholders were deleted. This
document previously described only the http Worker, which was the omission
that let D1 hide.

**D2 — the alert four are not one class.** `API_NEXT_ALERT_EMAIL_URL` and
`API_NEXT_ALERT_WEBHOOK_URL` are endpoint URLs and belong in `vars`;
`API_NEXT_ALERT_EMAIL_TOKEN` and `API_NEXT_ALERT_WEBHOOK_TOKEN` are bearer
credentials and belong in `secrets.required`. They are currently stored
nowhere while the production jobs runtime is disabled. A future production
jobs configuration must preserve this classification. The deleted root
placeholders broke rule 2.

**D3 — the ZKPassport rotation secret is intentionally inactive but not
predeclared.**
`ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_SECRET`,
`…_PREVIOUS_RESPONSE_SIGNING_KEY_ID`, and
`…_PREVIOUS_RESPONSE_SIGNING_VALID_UNTIL` are consumed by the http Worker and
the staging declaration records the two optional public fields as explicit
empty vars until a previous key is active. The optional previous secret is
absent from `secrets.required` while rotation is inactive, so the current
invariant cannot warn about a future half-declared rotation. Before rotating a
key, add the secret name to `secrets.required` and provide the complete triple
in one reviewed change. The `KEY_ID` and `VALID_UNTIL` members are public;
only the `SECRET` is confidential.

**D4 — development Privy public configuration is unavailable.** Staging and
production now declare verified app-specific JWKS URLs and audiences as vars.
The api-next Infisical project has no development app ID or public key, so the
development values were not invented. The invariant test remains red for the
two missing development Privy names.

**D5 — public configuration still has unresolved declarations.**
`PIRATE_APP_JWT_PUBLIC_KEY` and `PRIVY_APP_ID` are vars in staging and
production. Development still has them in `secrets.required` because no real
development values are available. The staging
`ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID` is now a Wrangler var with the
identifier recorded by the verifier provisioning evidence. It is intentionally
not an Infisical runtime secret.

**D6 — the HNS ownership configuration pair is undeclared.**
`HNS_OWNERSHIP_CONFIGURATION_REFERENCE` and
`HNS_OWNERSHIP_CONFIGURATION_VERSION` are consumed and declared nowhere.
Latent only because `HNS_OWNERSHIP_ENABLED` is `false` in every environment.
Breaks rule 3 the moment the flag flips.

**D7 — the Very namespace was inconsistent.** The browser-flow names are now
`VERY_WEB_APP_ID`, `VERY_WEB_API_URL`, `VERY_WEB_VERIFY_URL`, and
`VERY_WEB_BRIDGE_API_URL` in source, tests, the binding manifest, and staging
Wrangler vars. The empty `VERY_APP_ID` declaration was removed. The invariant
namespace check passes. No Very public configuration is stored in Infisical;
the confidential `VERY_WEB_SEALING_KEY` is the sole Very runtime entry there.

**D8 — environment vocabulary is inconsistent across systems.** Infisical uses
the slug `prod`; Wrangler uses the env key `production`; `alert-config.ts`
gates on `API_NEXT_ENV === "production"`. These are three namespaces and the
mismatch is legal, but it is a standing trap: `--env=production` against
Infisical returns 404.

Corrected 2026-08-22: an `API_NEXT_ENV` of `prod` does **not** silently bypass
alerting. `makeConfiguredAlertSink` rejects any value outside
`development | staging | production` and throws
`AlertSinkConfigurationError` (`alert-config.ts:70-77`). That path fails closed.

The residual hazard is narrower and still real. The guard is written
`API_NEXT_ENV !== undefined && …`, so an **absent** binding passes it, falls
through to the `!== "production"` branch, and silently returns the local sink.
A wrong value fails loudly; a missing value degrades quietly. Both Workers
declare `API_NEXT_ENV` in `vars` for every environment, so this is currently
latent — but it is the reason the name must never be left to deployment-time
injection. Pin `API_NEXT_ENV` to the Wrangler vocabulary and never let the
Infisical slug reach it.

**D9 — enforcement is weaker than the contract implies.**

Corrected 2026-08-22: `secrets` **is** a real Wrangler configuration property.
The installed schema (`wrangler` 4.123.0,
`node_modules/wrangler/config-schema.json`) defines `secrets.required` as an
array of strings that "replaces `.dev.vars`/`.env`/`process.env` inference for
type generation" and "enables local dev validation with warnings for missing
secrets". An earlier revision of this document called it a documentation
convention that no tooling reads. That was wrong.

What it does and does not do matters for the rule set:

| Effect | Present |
| --- | --- |
| Feeds `wrangler types` generation | yes |
| Warns on missing secrets in local dev | yes, a warning |
| Fails a deploy when a required secret is absent | no |
| Detects a name consumed in source but listed nowhere | no |
| Detects a public value misdeclared as a secret | no |

So rule 3 is partially enforced for secrets in local dev, and not at all for
`vars`, for deploys, or in the source-to-config direction. The new
`scripts/binding-contract-invariant.test.ts` covers both Wrangler configs and
is compile-checked by `check:binding-contract`; it currently fails only on the
known development Privy gaps, the staging ZK key-ID classification, and the
missing production alert URLs.

The schema also notes that `secrets` is **not** inherited from the top-level
environment and must be repeated in every named environment. Both configs do
repeat it, so no defect there — but it means the jobs Worker's omission of the
alert names is an omission in each of its three environments independently.

A test reconciling the binding interfaces against both Wrangler configs now
exists. It uses `satisfies BindingManifest<T>` so newly added source bindings
fail the typecheck until classified. The money-path invariant test named in
the root `wrangler.jsonc` is the existing precedent for that pattern.

### Junk count

Zero junk entries remain in Infisical or the Wrangler configs. Zero
declared-but-unconsumed names remain in source. The remaining defects are
missing real values or classification/configuration gaps, not junk.

## Sequence for the migration

1. Done, 2026-08-22. Select the Infisical profile that can read the api-next
   project, and confirm the environment slugs and folder tree. See
   "Observed state" above.
2. Done, 2026-08-22. Take a metadata-only inventory across all three
   environments: environment, path, name, and type. Confidential values were
   not rendered; the CLI did create encrypted local cache files, recorded in
   "Observed state".
3. Done, 2026-08-22. Create the target paths and copy only the approved runtime
   and operator entries into them with Infisical's server-side duplicate
   operation. Hash verification confirmed the copies before root cleanup.
4. Done for staging and production in the repository. Public configuration is
   now declared as Wrangler `vars`; the development values remain unsourced.
   The installed staging Worker secret for the ZK key ID still needs an
   operator-sourced value before its store can be changed.
5. Partially done. The ZKPassport rotation names are declared; values remain
   unset until an actual previous-key rotation is authorized.
6. Repository verification done. Source and worker typechecks, the binding
   typecheck, Biome, and 25 focused tests pass. The invariant test remains red
   only for the explicit blockers recorded above. Staging was then deployed
   explicitly from `apps/http-worker/wrangler.jsonc`; `/health` and the public
   JWKS endpoint both returned 200.
7. Done, 2026-08-22. Delete the zero-consumer legacy entries and root
   duplicates, then re-inventory all environments. Production alert
   placeholders remain isolated at root until real values are sourced.
8. Session hygiene, open. See below.

## Staging collision cleanup — completed 2026-08-22

The four public names were declared as staging `vars` in `wrangler.jsonc` and
the same-named secrets were removed from `pirate-http-worker-staging` before
the explicit staging deployment:

| Name | declared as | still installed as |
| --- | --- | --- |
| `PIRATE_APP_JWT_PUBLIC_KEY` | var | secret |
| `PRIVY_APP_ID` | var | secret |
| `PRIVY_JWKS_URL` | var | secret |
| `PRIVY_JWT_AUDIENCE` | var | secret |

After the misplaced-account deployment,
`wrangler secret list --name pirate-http-worker-staging` returned seven names
and no public-name collisions. Six were confidential runtime values; the
signing key ID remained misclassified as a secret. The staging `/health` and
`/.well-known/jwks.json` endpoints both returned HTTP 200.

`VERY_WEB_SEALING_KEY` was also added to staging `secrets.required`; it remains
installed because it is a genuine source-consumed secret, not junk.

### Independently verified 2026-08-22

| Check | Result |
| --- | --- |
| installed staging secrets | 7; six confidential values plus the misclassified key ID; none of the four collided names present |
| `api-next-staging`, the accidental root-config Worker | no longer resolves |
| `GET /health` | 200, `{"status":"ok"}` |
| `GET /.well-known/jwks.json` | 200, one 2048-bit RS256 key, `use: sig`, `key_ops: ["verify"]`, `kid` present |

The seven are `COMMUNITY_PURCHASE_FUNDING_RPC_URL`,
`PIRATE_APP_JWT_PRIVATE_KEY`, `PRIVY_APP_SECRET`, `VERY_WEB_SEALING_KEY`,
`ZKPASSPORT_VERIFIER_SHARED_SECRET`,
`ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET`, and
`ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID`. The last is still a secret and
should be a var in that historical deployment. The current repository has
corrected it to a var for the canonical-account cutover.

The current canonical-account config declares six staging secrets and carries
the key ID as a var. The optional previous-response signing secret is
intentionally absent until a rotation is active; the Wrangler comment and D3
rule above make adding it part of the rotation change rather than an undeclared
deployment-time dependency.

A live JWKS proves `PIRATE_APP_JWT_PUBLIC_KEY` is now served from the var,
since the same-named secret is gone. That is the verification the collision
would have rendered meaningless.

### Key-pair check — cryptographic pairing proven

`session-crypto.ts:318` builds the JWKS from `PIRATE_APP_JWT_PUBLIC_KEY`
alone. Signing uses `PIRATE_APP_JWT_PRIVATE_KEY`, a separate binding. The two
are never compared anywhere in the code.

If the public key that moved into `vars` is not the mate of the private key
still installed as a secret, then `/health` returns 200, the JWKS returns 200
and a well-formed 2048-bit key, every check above passes — and every session
token this Worker issues fails verification by every client. No check performed
so far can distinguish that case.

A staging session token issued before the cutover was verified against the
live `/.well-known/jwks.json`: its RS256 signature validated with the live
JWKS key selected by `kid`, and its `iat`/`exp` claims were structurally valid.
This proves that the public key now served from the Wrangler var is the mate of
the private signing key used by the staging Worker.

A pre-cutover token is sufficient evidence for the post-cutover state because
`PIRATE_APP_JWT_PRIVATE_KEY` was never touched by the cutover: it was not among
the four deleted collisions and remains an installed Worker secret. The signing
key is therefore the same key before and after, so a signature it produced
verifying against the new var-sourced JWKS establishes present pairing, not
merely historical pairing. The token had expired by
the time of the check, so the protected endpoint correctly returned 401. A
fresh post-cutover login was not re-run because the disposable test identity's
email/OTP was not available; that is a session-flow freshness follow-up, not a
key-pair defect.

The temporary local token artifact was deleted after the check. No token
value belongs in this contract.

## Tier C gate — service path exercised

The staging and production roots are empty. On 2026-08-23, all six staging
runtime names were exported from
`/services/api-next` through a validated in-memory pipeline and installed on
the canonical HTTP Worker; the funding RPC alone was selected for the jobs
Worker. The post-deploy audit proves exact source-to-Worker name parity. The
CLI encrypted cache created by the export was deleted afterward.

The production operator path was used on 2026-08-25 to create the isolated
`api_next` schema and apply the exact repository ledger through migration
`0048`. The runtime URL was then exercised only for name-safe schema, ledger,
and privilege checks. Neither database URL was installed on a Worker.

## Cloudflare remote drift audit

`bun run audit:secrets` is deliberately outside `bun run check`: it requires
Cloudflare authentication and performs remote reads. It invokes
`wrangler secret list --format json` for the named staging and production
Workers, consumes names only, and never reads secret values. Its fixture-backed
logic reports four Cloudflare-side classes: a declared var installed as a
secret, an installed secret with no declaration, a declared secret absent from
the Worker, and an internally colliding var/secret declaration. It exits
non-zero only for unallowlisted drift.

The current allowlist records only the intentional absence of the production
jobs Worker. Production HTTP is required to exist with exact three-name secret
parity. The accepted development Privy gap and the production alert
placeholders are not Cloudflare-side observations; they belong to the
Infisical-side policy below. The first live run on 2026-08-22
found zero unallowlisted Cloudflare violations only because it queried the
misplaced account. After correcting the account pins and binding the canonical
Wrangler profile to this repository, the same name-only audit found fourteen
violations in the canonical account: three undeclared junk names, five
var/secret collisions, five missing HTTP secrets, and one missing jobs secret.
After moving the ZKPassport key ID to a var, the audit reports thirteen: the
same three junk names and five collisions, four missing HTTP secrets, and one
missing jobs secret. No entry was allowlisted. After synchronization,
deployment, and deletion of the three junk names, the 2026-08-23 audit reported
zero violations. That historical run accepted both absent production Workers;
the 2026-08-25 activation narrows the exception to production jobs only.

The Cloudflare-side audit runs from the dedicated `.github/workflows/secret-
drift.yml` workflow on pushes to `main` and by manual dispatch, alongside the
trusted mainline CI event. It never runs for pull requests: passing the token
to arbitrary PR code would expose it to untrusted changes. The repository
`CLOUDFLARE_API_TOKEN` should be scoped to Cloudflare `Workers Scripts:Read`;
the audit only lists script secret names and does not need write permission.

## Infisical remote drift audit

`bun run audit:infisical` is deliberately separate from `bun run check`. It
scans the `dev`, `staging`, and `prod`
environments in the api-next project, checks the expected service and operator
folders, and reports root entries, misplaced entries, missing required names,
and unexpected folders. It exits non-zero for unallowlisted drift.

The audit uses the Infisical REST API directly. Secret-name requests set
`viewSecretValue=false`, `expandSecretReferences=false`, and `recursive=false`;
the script reads only `secretKey` metadata and never invokes the CLI or writes
the CLI's local value cache. Folder requests are metadata-only and read only
`relativePath`. Local operators may provide an explicit
`INFISICAL_AUDIT_TOKEN`; CI instead uses project machine identity
`a4c9780d-f83b-42cb-8c5e-e493439d374d` and exchanges GitHub's short-lived OIDC
token directly for an Infisical token capped at 900 seconds. No Infisical
credential is stored in GitHub. The Free plan does not support a metadata-only
custom role, so the project-scoped identity uses the built-in `Viewer` role.
That role can read values even though this script never requests them; the
exact main-branch OIDC subject, the absence of a pull-request trigger, and the
hard-coded `viewSecretValue=false` request are therefore security boundaries.

The dedicated `.github/workflows/secret-drift.yml` workflow runs both remote
axes on pushes to `main` and by manual dispatch. Its OIDC trust is bound to the
immutable repository subject for `main` and audience
`https://github.com/pirate-social-club`. It never runs for pull requests. The
audit may use `INFISICAL_API_URL` for the regional API base URL and never reads
the local Infisical profile, project pin, or cached credential.

No current Infisical drift is allowlisted. Runtime completeness is enabled for
staging and production. Production requires exactly the reviewed JWT, Privy,
and funding names. Root cleanliness, folder layout, operator-path completeness,
and rejection of every other stored name remain enforced. The first live run on 2026-08-22
found nine violations, including `VERY_APP_ID`; after deleting that entry and
removing the public key ID from the Infisical runtime policy, the follow-up run
found seven violations and zero accepted entries. The two staging ZKPassport
secrets were then sourced. The four invalid production root placeholders were
deleted on 2026-08-23. That day's final live read-back reported exactly one
finding: the then-missing production funding RPC. The 2026-08-25 activation
installed the reviewed fail-closed sentinel and enabled production
completeness; all three roots stay empty.

The first GitHub OIDC run, Actions run `32630163470` at commit `293783a`,
authenticated successfully and reproduced that exact name-only result. The
Cloudflare step reported zero violations; the Infisical step exited non-zero
only for the then-missing production `COMMUNITY_PURCHASE_FUNDING_RPC_URL`. No
secret value appeared in the log. The red workflow was active drift signal,
not an authentication or response-parser failure. No drift entry was
allowlisted to make the workflow green.

The first run under the former disabled policy, Actions run `32630721486` at
commit `1e35662`, completed successfully on 2026-08-23. The Cloudflare axis
reported zero violations and the two then-documented absent-production Worker
entries; the Infisical axis reported zero violations and zero accepted drift.
The 2026-08-25 policy supersedes that historical topology.

## Pull request secret boundary

`.github/workflows/secret-boundary.yml` is the trusted check that makes the
credential boundary survive a no-human merge flow. It runs under
`pull_request_target`, so GitHub executes the version of the workflow that is
already on `main`, not the version proposed by the pull request. The job checks
out `github.event.pull_request.base.sha` with `persist-credentials: false`,
installs no dependencies, and never executes pull request code. It holds no
credential other than the read-only `GITHUB_TOKEN`.

`scripts/secret-boundary-check.ts` reads the pull request's changed files and
their head-side contents through the GitHub REST API and fails the check on:

- any change to the check itself — the workflow, the script, or its test;
- removing or renaming `.github/workflows/secret-drift.yml` or
  `scripts/infisical-secret-drift-audit.ts`;
- dropping or inverting the `viewSecretValue: "false"` and
  `expandSecretReferences: "false"` literals in any script that talks to the
  Infisical secrets endpoint;
- reading the `secretValue` field returned by Infisical;
- any workflow that both triggers on a pull request and references a repository
  secret other than `GITHUB_TOKEN`, or requests `id-token: write`;
- any workflow other than this one that uses `pull_request_target`;
- `id-token: write` granted workflow wide instead of job scoped;
- any trigger on the credential-bearing workflow other than `push`, `schedule`,
  or `workflow_dispatch`;
- any action reference that is not pinned to a full 40-character commit SHA;
- an unreadable file or a change list too large to inspect, which fail closed.

Unchanged files are trusted by induction: they are already on `main`, which
means they passed this check when they merged.

The check is a boundary control, not a general secret scanner. It cannot stop
audit code that legitimately holds a token from printing something into the
GitHub log, and it does not inspect dependency behaviour. Those are separate
concerns: the runtime blast radius is bounded instead by the 900-second token
TTL, the exact main-branch OIDC subject, and the name-only request.

Because the check refuses changes to its own files, editing it is deliberately
a break-glass operation. The reviewed recovery payload is committed at
`docs/api-next/main-ruleset.json`. Before opening the bypass window, require
zero other open pull requests. An administrator then adds only a temporary
`OrganizationAdmin` bypass with `bypass_mode: pull_request`; direct pushes stay
forbidden. The ordinary CI jobs must still succeed procedurally, the boundary
failure must be limited to the expected guarded-file change, and the bypass
list must return to empty immediately after the one reviewed squash merge.
Compare the complete live ruleset with the committed payload, then run and
close a negative-control pull request proving the boundary still rejects a
secret-value audit change. With zero required approvals, this guarded process
is the only path for changing the control itself.

Ordering constraint: `pull_request_target` workflows only run once the workflow
file exists on the default branch. The pull request that introduces this check
therefore cannot run it, and `secret-boundary` may only be added to the required
status checks for `main` after that pull request has merged.

## Local project selection — corrected 2026-08-22

Both the repository pin at `api-next/.infisical.json` and the home-directory
pin at `/home/t42/.infisical.json` now point to
`fac45f92-9450-42fb-8c2f-f20d043fdfab`. The home pin previously targeted the
historical workspace `5acea78e-7813-4d8a-b29c-9b862a0b1c71`; that active trap
was corrected after the credential reset. The old project identifier remains
only in historical/reference material and is not an active project
selection. `~/.infisical/secrets-backup/` is confirmed absent.

Verified from outside the repository with no `--projectId`:
`infisical secrets folders get --env=staging --path=/services` resolves the
new `/services/api-next` folder. A project ID is not a secret. The repository
pin is committed in `0893585`; the home pin is local machine configuration.

This removes the reliance on remembering `--projectId` or on which profile
happens to be selected for commands in the repository or its parent tree.

The operator path was rehearsed in non-mutating mode after the pin was
committed: `infisical run --env=staging
--path=/services/api-next/operator -- bun run db:migrate --dry-run` injected
the two operator entries, loaded the repository migration plan, and opened no
database connection. A real migration remains intentionally unrun.

## Session hygiene — complete

During the migration session an earlier diagnostic printed an active Infisical
email-session token into tool output. A later REST-audit attempt on 2026-08-22
repeated the class of error by using formatted `infisical user get token`
output where the script required the `--plain` form. That formatted output
included the then-current session token. No Infisical secret value was
rendered, and neither token was written into the repository, command text, or
shell history.

The disclosed current session was first revoked server-side through Infisical's
authenticated `DELETE /api/v2/users/me/sessions/:sessionId` endpoint. A later
login reused an older server session, so all six sessions that predated the
correction were enumerated by ID and revoked, with HTTP 200 returned for every
deletion. `infisical reset` then removed the local keyring credential and the
encrypted CLI cache was deleted.

The final interactive login created one new session on 2026-08-22 at
19:57:53Z. Server metadata confirmed that it was the sole remaining session and
matched the CLI token's session ID. The final name-only audit completed through
that session. The export cache created during synchronization was deleted again
and remains absent. No rotation of stored application secrets is indicated
because no application secret value was exposed.

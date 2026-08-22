# api-next secrets contract

Status: audited and organized. Infisical confidential values were not rendered
in tool output. The approved confidential entries were copied server-side
within Infisical into their target paths, and the old root duplicates were
removed after hash verification. Public configuration was moved to repository
vars. An already-expired staging session token was briefly rendered by the
key-pair diagnostic; its local artifact was removed immediately and it was not
an Infisical value.

Date of inventory: 2026-08-22.

## Sources of truth

| Source | Identifier | Access from this workspace |
| --- | --- | --- |
| Infisical, api-next project | project `fac45f92-9450-42fb-8c2f-f20d043fdfab`, organization `d9615445-c0d4-445a-ad58-1d55d365635a` | Reachable. `api-next/.infisical.json` now pins this project, so commands run anywhere in the api-next tree resolve it without `--projectId`. See "Local project selection" below. |
| Infisical, historical project | workspace `5acea78e-7813-4d8a-b29c-9b862a0b1c71` | Reachable. Historical reference only. Its `/services/api` folder deliberately mixes API runtime, HNS, Spaces, media, Story, and operator credentials; that mixing is the boundary defect this contract corrects. Do not copy it wholesale. |
| Cloudflare Worker secrets | account `ff375d61cdc0c5dc946837f3e37725e0` | Reachable. `pirate-http-worker-staging` holds seven intended secrets after the public-config cleanup. `pirate-http-worker-production` does not exist remotely, consistent with production remaining disabled. |
| Declared Wrangler contract | `api-next/apps/http-worker/wrangler.jsonc` and `api-next/apps/jobs-worker/wrangler.jsonc` | In repository. Both Workers are in scope; earlier revisions of this document covered only the http Worker. `secrets.required` is a real Wrangler property — it drives type generation and local-dev warnings, but does not gate a deploy. See D9. |

Environments are Infisical environments. Never encode an environment into a
secret name.

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
| `staging` | `/services/api-next` has 3 runtime entries; `/services/api-next/operator` has 2 operator entries; root is empty |
| `prod` | `/services/api-next` has 2 runtime entries; `/services/api-next/operator` has 2 operator entries; root retains only four alert placeholders |

No HNS or Very path was created, because no approved HNS or Very entry exists.
The service and operator copies remain the canonical Infisical locations.
Cloudflare synchronization must use those paths explicitly on the next
authorized deployment; Infisical does not infer path changes.

The post-cleanup inventory was confirmed across all three environments.
`dev` is empty. `staging` has no root entries. `prod` has only the four
`API_NEXT_ALERT_*` placeholders; it has no funding RPC or self-callback token.

Prod therefore has two runtime entries where staging has three. The missing
one is `COMMUNITY_PURCHASE_FUNDING_RPC_URL`, which does not exist in prod. This
is expected rather than a partial copy, but it means prod cannot satisfy the
runtime contract until an authorized production funding RPC is sourced.
Staging has the name but its value is the fail-closed sentinel
`https://rpc.invalid/`, so neither environment can currently serve a money
flow.

## Classification of api-next project entries

The staging root currently holds seventeen entries. Production holds nineteen,
including four alerting entries not present in staging. They are not all
runtime secrets.

### Runtime secrets — belong on the Worker

| Name | Referenced in source | Current path copies |
| --- | --- | --- |
| `PIRATE_APP_JWT_PRIVATE_KEY` | yes | staging and prod |
| `PRIVY_APP_SECRET` | yes | staging and prod |
| `COMMUNITY_PURCHASE_FUNDING_RPC_URL` | yes | staging only; absent in prod |

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

## Known drift

1. Production retains four `API_NEXT_ALERT_*` root entries. They are active
   source bindings, but all four values are placeholders and no production jobs
   Worker is deployed. The two URLs need real HTTPS endpoints and the two
   tokens need real credentials before production can be enabled; the entries
   remain isolated from the api-next runtime path until then.
2. The staging Worker has the current
   `ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID` as a Cloudflare secret, while
   the repository classifies it as public configuration. Its value is not
   available from Infisical or the repository, and the verifier's public
   `/health` endpoint exposes only service metadata, not the active key ID. The
   store change therefore waits for an operator to source the real identifier.
   The previous-key rotation fields remain optional: the two public fields are
   explicitly empty until a rotation is active, and the previous secret is not
   required until then.
   `VERY_WEB_SEALING_KEY` is now declared in staging `secrets.required`.
3. Staging and production Privy app IDs, JWKS URLs, and audiences are now
   declared as Wrangler vars from verified app-specific values. The api-next
   Infisical project has no development Privy app ID or public key, so the
   development vars remain unresolved rather than receiving placeholders.
4. Staging and production `PIRATE_APP_JWT_PUBLIC_KEY` and `PRIVY_APP_ID` are
   now Wrangler vars; their Infisical root duplicates were deleted. The
   development declarations remain a known classification gap until a real
   development configuration is sourced.
5. **Infisical is not a complete source for the staging Worker.**
   `/services/api-next` holds three runtime secrets; the deployed staging
   Worker has seven. The four absent from Infisical are
   `ZKPASSPORT_VERIFIER_SHARED_SECRET`,
   `ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET`,
   `ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID`, and
   `VERY_WEB_SEALING_KEY`. They exist only as installed Cloudflare secrets.

   Consequence: a Worker rebuilt from `/services/api-next` today would be
   missing all four. `ZKPASSPORT_ENABLED` is `true` in staging, so ZKPassport
   verification would fail closed, and the Very web flow would lose its sealing
   key. The service-path sync cannot be rehearsed end to end until these four
   are stored.

   This is the oldest unresolved item in the lane. The three ZKPassport names
   were recorded as Cloudflare-only in the very first inventory and were never
   given an Infisical home; `VERY_WEB_SEALING_KEY` was installed later and
   never stored at all. Sourcing them is not a value-discovery problem — the
   values exist on the Worker — it is a copy that has not been done, with the
   exception of the key ID, which additionally needs its public form resolved
   under item 2.

6. Infisical staging carries no funding RPC. The staging Worker uses the
   fail-closed sentinel `https://rpc.invalid/`. An authorized real staging RPC
   is required before any money-flow verification.

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

### Confirmed not junk

- The four `API_NEXT_ALERT_*` production entries are consumed by
  `packages/platform-cf/src/alert-config.ts`, which requires them whenever
  `API_NEXT_ENV` is `production`.
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

**D1 — production alert configuration is incomplete.** `pirate-jobs-worker`
consumes all four `API_NEXT_ALERT_*` names in production. D1a is complete: the
two token names are declared in its production `secrets.required` list. D1b and
D1c remain open because the two URLs are placeholders and the two tokens have
no authorized real values; no production jobs Worker is deployed. This
document previously described only the http Worker, which was the omission
that let D1 hide.

**D2 — the alert four are not one class.** `API_NEXT_ALERT_EMAIL_URL` and
`API_NEXT_ALERT_WEBHOOK_URL` are endpoint URLs and belong in `vars`;
`API_NEXT_ALERT_EMAIL_TOKEN` and `API_NEXT_ALERT_WEBHOOK_TOKEN` are bearer
credentials and belong in `secrets.required`. They are currently stored
undifferentiated. Breaks rule 2.

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

**D5 — public configuration still has two unresolved declarations.**
`PIRATE_APP_JWT_PUBLIC_KEY` and `PRIVY_APP_ID` are vars in staging and
production. Development still has them in `secrets.required` because no real
development values are available. The staging
`ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID` also remains in the secret store
until its real Cloudflare value is sourced.

**D6 — the HNS ownership configuration pair is undeclared.**
`HNS_OWNERSHIP_CONFIGURATION_REFERENCE` and
`HNS_OWNERSHIP_CONFIGURATION_VERSION` are consumed and declared nowhere.
Latent only because `HNS_OWNERSHIP_ENABLED` is `false` in every environment.
Breaks rule 3 the moment the flag flips.

**D7 — the Very namespace was inconsistent.** The browser-flow names are now
`VERY_WEB_APP_ID`, `VERY_WEB_API_URL`, `VERY_WEB_VERIFY_URL`, and
`VERY_WEB_BRIDGE_API_URL` in source, tests, the binding manifest, and staging
Wrangler vars. The empty `VERY_APP_ID` declaration was removed. The invariant
namespace check passes, and no Very value was added to Infisical.

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

After deployment, `wrangler secret list --name pirate-http-worker-staging`
returns seven intended secrets and no public-name collisions. The staging
`/health` and `/.well-known/jwks.json` endpoints both returned HTTP 200.

`VERY_WEB_SEALING_KEY` was also added to staging `secrets.required`; it remains
installed because it is a genuine source-consumed secret, not junk.

### Independently verified 2026-08-22

| Check | Result |
| --- | --- |
| installed staging secrets | 7, exactly the intended set; none of the four collided names present |
| `api-next-staging`, the accidental root-config Worker | no longer resolves |
| `GET /health` | 200, `{"status":"ok"}` |
| `GET /.well-known/jwks.json` | 200, one 2048-bit RS256 key, `use: sig`, `key_ops: ["verify"]`, `kid` present |

The seven are `COMMUNITY_PURCHASE_FUNDING_RPC_URL`,
`PIRATE_APP_JWT_PRIVATE_KEY`, `PRIVY_APP_SECRET`, `VERY_WEB_SEALING_KEY`,
`ZKPASSPORT_VERIFIER_SHARED_SECRET`,
`ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET`, and
`ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID`. The last is still a secret and
should be a var — the one open D5 instance.

Declared staging secrets number seven. The optional previous-response signing
secret is intentionally absent until a rotation is active; the Wrangler
comment and D3 rule above make adding it part of the rotation change rather
than an undeclared deployment-time dependency.

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

## Tier C gate — partially exercised

The staging root is now empty and the prod root holds only the four alert
placeholders. That means the Tier C root copies — the runtime secrets and the
two database URLs — were deleted before the gate this document set for them:
one Worker deploy sourced from `/services/api-next` and one migration sourced
from `/services/api-next/operator`. Neither has happened.

The staging Worker was deployed successfully, but the deployment used the
explicit Wrangler configuration and existing Cloudflare runtime secrets; it
did not exercise an Infisical-to-Cloudflare synchronization from
`/services/api-next`. No migration has been run from
`/services/api-next/operator`. The folders are confirmed present and their
contents were hash-verified before root cleanup. This remains accepted risk:
the first service-path synchronization and first operator migration are still
unrehearsed and should happen before relying on those paths operationally.

## Cloudflare remote drift audit

`bun run audit:secrets` is deliberately outside `bun run check`: it requires
Cloudflare authentication and performs remote reads. It invokes
`wrangler secret list --format json` for the named staging and production
Workers, consumes names only, and never reads secret values. Its fixture-backed
logic reports four Cloudflare-side classes: a declared var installed as a
secret, an installed secret with no declaration, a declared secret absent from
the Worker, and an internally colliding var/secret declaration. It exits
non-zero only for unallowlisted drift.

The current allowlist records the intentional absence of both production
Workers while production is disabled. The accepted development Privy gap and
the production alert placeholders are not Cloudflare-side observations; they
belong to the Infisical-side policy below. The live run on 2026-08-22 found
zero unallowlisted Cloudflare violations: both staging Workers matched their
declared secret sets.

## Infisical remote drift audit

`bun run audit:infisical` is deliberately separate from both `bun run check`
and the Cloudflare audit. It scans the `dev`, `staging`, and `prod`
environments in the api-next project, checks the expected service and operator
folders, and reports root entries, misplaced entries, missing required names,
and unexpected folders. It exits non-zero for unallowlisted drift.

The audit uses the Infisical REST API directly. Secret-name requests set
`viewSecretValue=false`, `expandSecretReferences=false`, and `recursive=false`;
the script reads only `secretKey` metadata and never invokes the CLI or writes
the CLI's local value cache. Folder requests are metadata-only and read only
`relativePath`. The audit requires an explicit `INFISICAL_AUDIT_TOKEN` and may
use `INFISICAL_API_URL` for the regional API base URL. It never reads the
local Infisical profile, project pin, or cached credential.

Known accepted drift is narrow and explicit: the four disabled-production
alert placeholders at root, and the missing production funding RPC until an
authorized endpoint exists. A live Infisical run is intentionally still
pending fresh session hygiene and a fresh name-only audit credential. The
fixture-backed logic is committed and ready; no Infisical values have been
rendered or changed by this audit.

## Local project selection — corrected 2026-08-22

`/home/t42/.infisical.json` **still exists** and still pins the historical
workspace `5acea78e-7813-4d8a-b29c-9b862a0b1c71`. A scan after the credential
reset reported it as absent; that was incorrect. The credential reset cleared
the login and the offline cache — `~/.infisical/secrets-backup/` is confirmed
gone — but it did not touch the home-directory project pin, which is
configuration rather than credential.

That pin is an active trap. Any `infisical` command run outside a directory
with its own `.infisical.json` silently targets the legacy project, whose
`/services/api` folder holds a similarly named but unrelated set of database
URLs on the same PlanetScale instance.

Fix applied: `api-next/.infisical.json` now pins
`fac45f92-9450-42fb-8c2f-f20d043fdfab`. Verified — `infisical secrets folders
get --env=staging --path=/services` with no `--projectId` resolves
`/services/api-next` correctly. A project ID is not a secret, so this file
is committed in `0893585` rather than ignored.

This makes the correct project the default for anyone working in the tree and
removes the reliance on remembering `--projectId` or on which profile happens
to be selected.

The operator path was rehearsed in non-mutating mode after the pin was
committed: `infisical run --env=staging
--path=/services/api-next/operator -- bun run db:migrate --dry-run` injected
the two operator entries, loaded the repository migration plan, and opened no
database connection. A real migration remains intentionally unrun.

## Session hygiene — open

During the migration session a diagnostic printed the active Infisical
email-session token into tool output. The token was not written to a file and
not repeated; a scan of this repository's docs, the agent memory directory, the
session scratchpad, and the shell histories found no token-shaped string
matching it. Infisical could not renew the session, because renewal supports
identity tokens only.

Local hygiene is complete: `infisical reset` cleared the local credential, the
encrypted offline cache was removed, and a fresh interactive login selected
the api-next organization profile. The previously disclosed server session
has not been confirmed revoked; that remains the only open hygiene step.

Remaining server-side action:

1. Revoke the session server-side, in the Infisical web console under personal
   settings. `infisical logout` clears the local credential from the OS
   keyring; on its own it does not invalidate a token that has already been
   disclosed. Revoke first, then log out and back in.
For completeness, the exposure remains scoped to the session token, not to
the secrets. No secret value was rendered. No rotation of the seventeen
entries is indicated by this event alone.

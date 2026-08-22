# api-next secrets contract

Status: inventory and target layout. Secret values were not printed or locally
copied. The approved confidential entries were copied server-side within
Infisical into their target paths; no root entry was changed or deleted.

Date of inventory: 2026-08-22.

## Sources of truth

| Source | Identifier | Access from this workspace |
| --- | --- | --- |
| Infisical, api-next project | project `fac45f92-9450-42fb-8c2f-f20d043fdfab`, organization `d9615445-c0d4-445a-ad58-1d55d365635a` | Reachable, but only under the api-next organization profile. The repository default `/home/t42/.infisical.json` pins the historical workspace `5acea78e-7813-4d8a-b29c-9b862a0b1c71`; under that profile this project returns "This project does not belong to your selected organization." Switch profiles before any api-next secret work, and switch back afterwards. |
| Infisical, historical project | workspace `5acea78e-7813-4d8a-b29c-9b862a0b1c71` | Reachable. Historical reference only. Its `/services/api` folder deliberately mixes API runtime, HNS, Spaces, media, Story, and operator credentials; that mixing is the boundary defect this contract corrects. Do not copy it wholesale. |
| Cloudflare Worker secrets | account `ff375d61cdc0c5dc946837f3e37725e0` | Reachable. `pirate-http-worker-staging` holds ten secrets. `pirate-http-worker-production` does not exist remotely, consistent with production remaining disabled. |
| Declared Wrangler contract | `api-next/apps/http-worker/wrangler.jsonc` and `api-next/apps/jobs-worker/wrangler.jsonc` | In repository. Both Workers are in scope; earlier revisions of this document covered only the http Worker. `secrets.required` is a real Wrangler property — it drives type generation and local-dev warnings, but does not gate a deploy. See D9. |

Environments are Infisical environments. Never encode an environment into a
secret name.

## Observed state

Metadata only for inventory. Verified 2026-08-22 with the folder endpoint and
the Infisical secrets list API using `viewSecretValue=false`. No command
returned secret values to a terminal, and the approved path copies used
Infisical's server-side duplicate operation, so no value passed through this
workspace.

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

| Environment | Current folder tree and name-only inventory |
| --- | --- |
| `dev` | no folders and no secrets |
| `staging` | `/services/api-next` has 3 copied runtime entries; `/services/api-next/operator` has 2 copied operator entries; 17 root entries remain |
| `prod` | `/services/api-next` has 2 copied runtime entries; `/services/api-next/operator` has 2 copied operator entries; 19 root entries remain |

The root entries remain pending the session-hygiene step and the later cutover.
The copies are the migration staging point; the four zero-consumer legacy
entries are approved for deletion once the fresh Infisical session is ready.
No HNS or Very path was created, because no approved HNS or Very entry exists.

The complete name-only inventory was confirmed across all three environments.
`dev` is empty. `staging` has the seventeen names previously reported. `prod`
has those applicable names plus four `API_NEXT_ALERT_*` entries; it has no
funding RPC or self-callback token.

Prod therefore received two runtime entries where staging received three. The
missing one is `COMMUNITY_PURCHASE_FUNDING_RPC_URL`, which does not exist in
prod. This is expected rather than a partial copy, but it means prod cannot
satisfy the runtime contract until an authorized production funding RPC is
sourced. Staging has the name but its value is the fail-closed sentinel
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
| `PIRATE_APP_JWT_PUBLIC_KEY` | yes | still declared as a Worker secret |
| `PRIVY_APP_ID` | yes | still declared as a Worker secret |
| `PRIVY_JWKS_URL` | yes | undeclared; see drift below |
| `PRIVY_JWT_AUDIENCE` | yes | undeclared; see drift below |
| `PRIVY_JWT_ISSUER` | yes | already a Wrangler var in staging |

These values are public or derived. A public key, an app identifier, an
audience, an issuer, and a JWKS URL are all disclosed to clients or discoverable
from the upstream provider. Treating them as secrets hides real configuration
behind an access boundary without adding protection.

### Legacy entries — approved cleanup candidates

| Name | Referenced in source |
| --- | --- |
| `SELF_CALLBACK_CAPTURE_ACCESS_TOKEN` | no |
| `AUTH_UPSTREAM_JWT_AUDIENCE` | no |
| `AUTH_UPSTREAM_JWT_ISSUER` | no |
| `AUTH_UPSTREAM_JWT_JWKS_URL` | no |

The Self callback capture seam was parked and its Durable Object class was
retired by Wrangler migration `v3`. Its token has no current consumer. The
`AUTH_UPSTREAM_*` names are legacy JWT audience, issuer, and JWKS configuration
from the prior auth-upstream integration; they have no current consumer and
`pirate-app-staging` has no current workspace reference. None of these four
names enters a target path. Delete them from the api-next project after the
session-hygiene step is complete. If the auth-upstream integration is ever
revived, its public configuration must be reintroduced deliberately.

## Target path layout

| Purpose | Infisical path | Cloudflare synchronization |
| --- | --- | --- |
| api-next runtime secrets | `/services/api-next` | explicit runtime allowlist only |
| api-next migrations and operators | `/services/api-next/operator` | never |
| HNS verifier runtime | `/services/hns-verifier` | verifier Worker only |
| Public configuration | Wrangler `vars` or repository configuration | not a secret |
| Legacy candidates | left where they are, pending review | never |

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

1. Production has four additional root entries —
   `API_NEXT_ALERT_EMAIL_TOKEN`, `API_NEXT_ALERT_EMAIL_URL`,
   `API_NEXT_ALERT_WEBHOOK_TOKEN`, and `API_NEXT_ALERT_WEBHOOK_URL` — that are
   not present in staging. They are active bindings in
   `packages/platform-cf/src/alert-config.ts`: the two tokens are runtime
   secrets and the two endpoint URLs are configuration. They are not junk;
   keep them at root while production is disabled, then place them under the
   production runtime/configuration contract before enabling production.
2. Staging Cloudflare holds three ZKPassport verifier secrets —
   `ZKPASSPORT_VERIFIER_SHARED_SECRET`,
   `ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET`, and
   `ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID` — that appear nowhere in the
   staging Infisical inventory. They must either be added to an approved
   Infisical runtime path or explicitly documented as separately sourced. They
   must not remain Cloudflare-only. `ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID`
   is an identifier, not a secret, and belongs with public configuration.
3. `PRIVY_JWKS_URL` and `PRIVY_JWT_AUDIENCE` are installed on the staging Worker
   and referenced by source, but are declared in neither the Wrangler `secrets`
   contract nor the staging `vars` block. The staging `vars` comment records
   that they are injected at deployment time. Undeclared deployment-time
   injection is not a contract; both should become declared per-environment
   `vars`.
4. `PIRATE_APP_JWT_PUBLIC_KEY` and `PRIVY_APP_ID` are declared as required
   Worker secrets in all three environments while being public values.
5. Infisical staging carries no funding RPC. The staging Worker uses the
   fail-closed sentinel `https://rpc.invalid/`. An authorized real staging RPC
   is required before any money-flow verification.

Drift items 2 and 3 are deliberately not yet applied to
`api-next/apps/http-worker/wrangler.jsonc`. Moving a name from `secrets` to
`vars` requires deleting the installed Worker secret in the same change;
changing the declaration alone would desynchronize the declared contract from
the deployed staging Worker. Both land with the Infisical path migration.

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

### Confirmed junk — delete

| Name | Environments | Rule |
| --- | --- | --- |
| `AUTH_UPSTREAM_JWT_AUDIENCE` | staging, prod | 7 |
| `AUTH_UPSTREAM_JWT_ISSUER` | staging, prod | 7 |
| `AUTH_UPSTREAM_JWT_JWKS_URL` | staging, prod | 7 |
| `SELF_CALLBACK_CAPTURE_ACCESS_TOKEN` | staging | 7 |

Zero consumers in the workspace. The Self capture seam's Durable Object class
was retired by http-worker migration `v3`. Delete after the Infisical session
is rotated, then re-inventory.

### Open defects

**D1 — the jobs Worker is missing from every contract.** `pirate-jobs-worker`
consumes all four `API_NEXT_ALERT_*` names in production, and its
`wrangler.jsonc` declares none of them in any environment. The four exist in
the Infisical prod root but were not copied into `/services/api-next`, so the
approved runtime path cannot satisfy production. Breaks rules 3 and 7. This
document previously described only the http Worker; that was the omission that
let D1 hide.

**D2 — the alert four are not one class.** `API_NEXT_ALERT_EMAIL_URL` and
`API_NEXT_ALERT_WEBHOOK_URL` are endpoint URLs and belong in `vars`;
`API_NEXT_ALERT_EMAIL_TOKEN` and `API_NEXT_ALERT_WEBHOOK_TOKEN` are bearer
credentials and belong in `secrets.required`. They are currently stored
undifferentiated. Breaks rule 2.

**D3 — the ZKPassport rotation triple is unreachable.**
`ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_SECRET`,
`…_PREVIOUS_RESPONSE_SIGNING_KEY_ID`, and
`…_PREVIOUS_RESPONSE_SIGNING_VALID_UNTIL` are consumed by the http Worker and
declared in no environment and stored in no Infisical path. Signing-key
rotation cannot currently be performed without an unrecorded manual injection.
Breaks rule 3. The `KEY_ID` and `VALID_UNTIL` members are public; only the
`SECRET` is confidential.

**D4 — `PRIVY_JWKS_URL` and `PRIVY_JWT_AUDIENCE` remain undeclared** in staging
while installed on the staging Worker and consumed by source. Breaks rule 3.
Previously recorded as drift item 2; still open.

**D5 — `PIRATE_APP_JWT_PUBLIC_KEY` and `PRIVY_APP_ID` are still declared as
secrets** in all three http-worker environments. Both are public. Breaks
rule 2. Previously drift item 3; still open.

**D6 — the HNS ownership configuration pair is undeclared.**
`HNS_OWNERSHIP_CONFIGURATION_REFERENCE` and
`HNS_OWNERSHIP_CONFIGURATION_VERSION` are consumed and declared nowhere.
Latent only because `HNS_OWNERSHIP_ENABLED` is `false` in every environment.
Breaks rule 3 the moment the flag flips.

**D7 — the Very names violate the namespace rule.** Thirteen `VERY_*` names are
consumed across two flows. The OAuth flow is consistently `VERY_OAUTH_*`. The
browser flow is not: `VERY_WEB_ENABLED` and `VERY_WEB_SEALING_KEY` carry the
infix, but `VERY_APP_ID`, `VERY_API_URL`, `VERY_VERIFY_URL`, and
`VERY_BRIDGE_API_URL` do not, so they read as integration-wide when they are
web-flow-specific. Rename to `VERY_WEB_APP_ID`, `VERY_WEB_API_URL`,
`VERY_WEB_VERIFY_URL`, and `VERY_WEB_BRIDGE_API_URL`. Breaks rule 5. Do this
before any Very value is stored in Infisical, so the rename never has to touch
a secret store. Eleven of the thirteen are also undeclared in staging, and
`VERY_APP_ID` is declared as an empty-string var, which is a third state
distinct from present and absent — remove it rather than declaring it empty.

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
`vars`, for deploys, or for the source-to-config direction. D1, D3, D4, and D6
would all pass every check that exists today.

The schema also notes that `secrets` is **not** inherited from the top-level
environment and must be repeated in every named environment. Both configs do
repeat it, so no defect there — but it means the jobs Worker's omission of the
alert names is an omission in each of its three environments independently.

A test reconciling the binding interfaces against both Wrangler configs would
convert D1, D3, D4, and D6 into build failures. The money-path invariant test
named in the root `wrangler.jsonc` is the existing precedent for that pattern.

### Junk count

Four junk entries, all in Infisical, all listed above. Zero junk in the Wrangler
configs. Zero declared-but-unconsumed names in source. The remaining defects are
misclassification, non-declaration, and naming — not junk.

## Sequence for the migration

1. Done, 2026-08-22. Select the Infisical profile that can read the api-next
   project, and confirm the environment slugs and folder tree. See
   "Observed state" above.
2. Done, 2026-08-22. Take a metadata-only inventory across all three
   environments: environment, path, name, and type. No values were printed or
   locally stored.
3. Done, 2026-08-22. Create the target paths and copy only the approved runtime
   and operator entries into them with Infisical's server-side duplicate
   operation. Root entries remain intact.
4. Move public configuration into per-environment Wrangler `vars`, deleting the
   corresponding installed Worker secrets in the same change.
5. Resolve the ZKPassport drift.
6. Verify staging.
7. Delete the approved zero-consumer legacy entries after session hygiene, then
   re-inventory all environments. Do not delete public configuration or the
   unclassified production alert entries under this approval.
8. Session hygiene, open. See below.

## Session hygiene — open

During the migration session a diagnostic printed the active Infisical
email-session token into tool output. The token was not written to a file and
not repeated; a scan of this repository's docs, the agent memory directory, the
session scratchpad, and the shell histories found no token-shaped string
matching it. Infisical could not renew the session, because renewal supports
identity tokens only.

Required, in order:

1. Revoke the session server-side, in the Infisical web console under personal
   settings. `infisical logout` clears the local credential from the OS
   keyring; on its own it does not invalidate a token that has already been
   disclosed. Revoke first, then log out and back in.
2. Clear the offline cache: `rm -rf ~/.infisical/secrets-backup/`. Its entries
   are encrypted under the local credential, so rotating that credential
   without clearing the cache leaves stale encrypted copies of both the staging
   and prod roots on disk for no operational benefit.
3. Treat the exposure as scoped to the session token, not to the secrets. No
   secret value was rendered. No rotation of the seventeen entries is indicated
   by this event alone.

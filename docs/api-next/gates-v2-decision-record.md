# Gates v2 decision record

Status: accepted foundation decisions (2026-08-17)

This is the durable coordination point for the greenfield gates-v2 workstream.
Communities are created fresh and users complete new verification ceremonies.
There are no data importers, compatibility compilers, dual reads, shadow
evaluation paths, or inherited identity records in this design.

## Runtime architecture

Gates v2 separates four responsibilities:

1. Provider adapters turn presentations into evidence receipts and canonical
   assertions. Provider names and SDK details stay outside the policy language.
2. Resolvers turn wallet, inventory, and other runtime facts into versioned
   observations with explicit trust, aggregation, and snapshot data.
3. A pure policy engine consumes claims and observations. Its intended shape is
   `plan -> resolve -> evaluate -> commit`, with outcomes `pass`, `fail`,
   `needs_evidence`, and `indeterminate`. Provider downtime is indeterminate.
4. Anti-abuse uses a separate action-grant path. It is explicit configuration,
   not an access-policy atom or a property inferred from the policy AST.

The stack of record is Cloudflare Workers, Hyperdrive, and PlanetScale
Postgres. api-next has one runtime relational database per environment; posts,
comments, votes, evidence, and action-grant consumption are not split across a
control plane and community shards.

The foundation includes domain schemas, the stable application adapter
boundary and registry, the completion use case and transactional Postgres
repository, adversarial and provider-transport conformance fixtures, dependency
guards, and the Postgres ledger. The next provider-neutral slice adds
transactional session start, exact configuration provenance, generic launch
presentations, authenticated client completion, and raw signed-callback HTTP
transport. The evaluator and real provider implementations remain separate
slices.

## Claims, assurance, and scope

The canonical catalog distinguishes:

- `human.live`: holder liveness;
- `human.personhood`: personhood without implied liveness;
- `human.unique`: issuer-scoped uniqueness;
- `credential.subject_unique`: a stable credential subject without implied
  liveness;
- `document.valid`, `document.holder_bound`, `age.minimum`,
  `nationality.allowed`, and `gender.marker`;
- `asset.ownership`; and
- `disclosed.predicate` for provider-neutral selective disclosures.

`human.unique` and `credential.subject_unique` are deliberately different.
Selectors decide whether `document_zk` assurance suffices for a policy; the
adapter cannot upgrade a stable document subject into holder liveness.
`document.holder_bound` is also distinct from `human.live`: liveness establishes
that a participant was live, while holder binding establishes that participant
was the document subject. It does not mean that the document is bound to a
Pirate account; account ownership is represented only by a subject-key binding
epoch.

ZKPassport can emit `document.valid`, `nationality.allowed`, other disclosed
document predicates, and `credential.subject_unique` with `document_zk`
assurance. Nationality allowlists may be proven without disclosing the country;
optional disclosure is represented separately in the typed assertion value.
The subject key is scoped to its issuer and relying party. Very liveness
remains a separate claim; a policy needing both claims must require a shared
binding witness.

Every uniqueness key contains its full namespace: `issuer`, `method`,
`rp_scope`, and `subject_digest`, with an optional action scope when the method
defines action-level uniqueness. There is no global or missing-scope form.

### Provider-neutral requests and document coverage

A proof request is an immutable canonical requirement set, not a bag of claim
names. `age.minimum` carries its threshold; `nationality.allowed` carries the
sorted country allowlist; other parameterized claims carry their typed values.
The adapter boundary recomputes a versioned SHA-256 request hash over the actor,
intent, provider, method, scope, request mode, canonical requirements, the
exact managed-flow or dynamic-generator reference and version,
subject-binding intent, protocol, and environment before any provider starts.
Claim IDs are excluded because they are an exact checked projection of the
requirements. HTTP routes use the same helper and never accept a
client-selected hash or client-authored requirement set. Proof sessions persist
both the requirements and their checked claim-ID projection, and neither can
change after session creation.

Provider manifests declare whether claims are available through a `curated`
configuration or a `dynamic` runtime request. The adapter's planning operation
returns `supported`, `unsupported`, or `unknown`; a supported result also names
the request mode and exact provider configuration used by the session. Managed
references cover immutable hosted flows or policies; dynamic references name a
versioned query generator. Planning answers only whether the current provider
configuration can express the request. It does not promise that the user's
passport or national ID is covered. Unsupported documents are a typed
completion rejection, while provider/config lookup failures remain unknown or
indeterminate rather than becoming policy failures.

Self and ZKPassport are parallel implementations of the same requirements.
Self Enterprise maps exact matches to reviewed immutable dashboard flows;
ZKPassport compiles dynamic community requirements into self-served queries.
The product may offer every provider whose plan is supported, and a user whose
document is not covered by one provider can start a fresh ceremony with
another. A nationality is never considered unsupported merely because one
provider cannot verify that user's document.

For privacy-preserving membership proofs, `nationality.allowed` may assert only
`{ allowed: true }`, with disclosure of the actual country optional. That
assertion is meaningful only with the same session's canonical country set; it
is not a reusable global nationality fact. Every ZKPassport ceremony that
produces `credential.subject_unique`, including rewards, uses the single pinned
platform RP scope. Dashboard policy-version scopes are reserved for
disclosure-only/template use because rotating them would fragment stable
subject identity. Additional providers use the same manifest, plan, start,
completion, and evidence seams without entering the policy language.

## Reward uniqueness

A reward campaign chooses one uniqueness authority and one named issuer scope,
or names an equivalent campaign authority. Cross-provider `OR` does not mean
global uniqueness. Published reward policies carry a machine-readable
`uniqueness_model`; publication fails when their uniqueness claims are not
linked to one authority and scope. The database records policy purpose
explicitly and requires every reward policy version's authority ID and
`single_authority` model to reference the same campaign authority row.

Because this is a fresh platform, an identity used elsewhere is not treated as
already consumed here. Any campaign that spans platforms must scope its reward
authority to this platform rather than relying on consumption state from
another platform.

## Evidence and co-reference

The evidence ledger records:

- proof sessions with actor, intent, canonical requirements, request mode,
  exact provider-configuration reference and version, request hash, issuer
  scope, protocol, environment, an optional opaque provider-session correlation
  reference, and explicit subject-binding intent (`establish`, `recover`, or
  `none`);
- append-only receipts with explicit scope, evidence hash, observation time,
  the same trigger-checked provider-configuration provenance, protocol
  metadata, source session, and optional subject-key linkage;
- immutable issuer-scoped subject identities, append-only account-binding
  epochs, and a trigger-maintained active-binding projection; and
- assertions with canonical claim ID, assurance, receipt, subject key, and a
  binding-group ID.

Binding groups are the co-reference boundary. A policy requiring personhood and
age must select assertions sharing a subject or receipt binding group; unrelated
provider responses cannot be combined merely because both predicates pass.

Provider manifests declare claims, request modes, assurance levels,
presentation kinds, and subject-key scope semantics. Provider IDs, protocols,
and methods are data, not closed unions in the engine or contract.

Assertion values are claim-specific runtime schemas rather than arbitrary
JSON. Completion accepts an explicit `client_result`, `provider_callback`, or
`poll_result` channel whose payload remains provider-local. Signed callbacks
receive the exact raw body plus a bounded lowercase header map; callback
authentication runs before local session lookup, and actor/provider identity is
then derived from the stored session. The application returns an existing
terminal result only for the same idempotency key and delegates one transaction
that persists the winning evidence bundle and terminal session event together.
The database clock is authoritative for the final expiry check and terminal
timestamp; a slow provider cannot commit after expiry using a time captured
before the upstream call. Concurrent callbacks may verify upstream more than
once, but only one database transaction can commit evidence. A deferred
constraint prevents any terminal proof-session row from committing without its
matching append-only completion event.

Subject identity and account ownership are separate. A normal `establish`
ceremony may create a first binding or reuse the evaluating user's active
binding, but cannot take an identity bound to another account. Only a session
created with `recover` intent may advance the binding epoch. Reward consumption
is keyed to the stable subject identity, so recovery cannot reset campaign
eligibility. The application chooses the intent before provider start:
subject-bearing manifests accept `establish` or `recover`, while `none` is
reserved for providers that produce no subject key.

Provider unavailability and malformed callback submissions are retryable and
do not terminalize a session. Successful completion is owned by the completion
use case. A later expiry/administration service will own `expired` and `failed`
terminal transitions and must write the same completion-event invariant in one
transaction.

The first adapter contract is issuance-only. Provider-side refresh and
revocation are deliberately deferred as separate optional revalidation
capabilities rather than mandatory adapter methods. No adapter that needs
upstream refresh or revocation may ship until that optional capability and its
application service are defined; assertion expiry remains available for
issuance-only providers.

## Inventory resolvers and Courtyard

Courtyard is an inventory resolver, not a proof provider. Its runtime manifest
supports Polygon (`eip155:137`) only.

Authoring catalogs and runtime inventory resolution are separate. Published
descriptors contain normalized values, a schema version, and explicit match
semantics. Runtime observations carry CAIP chain/account/asset identifiers,
explicit aggregation, completeness, a typed snapshot reference, a
source-response hash, and trust mode (`onchain_pinned` or
`provider_asserted`). Mutable provider metadata cannot redefine a published
policy.

## Action grants and atomic consumption

Proof-of-work is an action grant, not a side-effecting policy atom. The flow is
intent -> intent-bound challenge -> verify without consume -> signed grant ->
consume the nonce in `used_action_grants` in the same transaction as the action
write.

The current api-next topology makes that transaction local: content tables and
`used_action_grants` are in the same PlanetScale Postgres database. The
repository use-case that performs the protected action must insert both rows
through one `ControlPlaneDb.withTransaction` scope. `action_kind`,
`action_scope`, and `action_payload_hash` are the authorization binding;
`action_result_ref` is only the resulting resource audit reference.

The target pure engine returns a winning witness, and future protected-action
use cases must consume only the grants referenced by that witness. The current
foundation proves at the Postgres level that a grant-consumption insert rolls
back when its paired content write fails. Burn safety is not automatic merely
because both tables share a database: every protected-action repository must
keep both writes inside the same transaction, and the engine/application wiring
is still a later slice.

## Schema and extension guardrails

`db/postgres/schema.sql` is the fresh-database cumulative baseline. The reviewed
forward-only PlanetScale Postgres ledger contains
`0009_gates_v2_foundation.sql`, followed by
`0010_proof_session_provenance.sql` for exact provider configuration and
append-only client presentations. The earlier review-only two-delta foundation
sequence was never applied to a durable environment and was explicitly reset
before the first deployment so the greenfield ledger contains no transitional
subject-binding shape. This reset is documented in `db/postgres/README.md`;
0010 also refuses a non-empty evidence ledger rather than deriving or inventing
configuration provenance. After first durable application, the normal immutable
forward-only rule applies. Fresh databases produced by the cumulative baseline
and by ordered deltas must have identical catalogs.

Provider additions must be adapter-local. The repository walker cross-checks
workspace packages against its dependency matrix, enforces the provider
location, rejects forbidden imports and runtime module-loader escapes, and
freezes the exact verification subpath exports. A compile-only provider fixture
proves the real path is walked. The registry adversarial corpus tests malformed
sessions and evidence once; each real adapter must additionally pass the shared
transport harness with its injected upstream fake. If adding Self, ZKPassport,
Very, World ID, Humanity, or another provider requires an engine, evidence
schema, route, or contract-enum edit, the abstraction has failed and must be
reviewed rather than expanded with another provider case.

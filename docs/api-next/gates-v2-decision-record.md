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

The implemented foundation includes domain schemas, the stable application
adapter boundary and registry, transactional start and completion use cases,
exact configuration provenance, generic launch presentations, callback trust
modes, adversarial and provider-transport conformance fixtures, dependency
guards, and the Postgres ledger. Self Pass is the first real adapter. The pure
evaluator, ZKPassport, inventory resolvers, and protected-action application
wiring remain separate slices.

## Claims, assurance, and scope

The canonical catalog distinguishes:

- `human.live`: holder liveness;
- `human.personhood`: personhood without implied liveness;
- `human.unique`: issuer-scoped person-level deduplication from a method whose
  contract actually provides it;
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

Self and ZKPassport both emit credential-derived
`credential.subject_unique`, not `human.unique`. A person may hold multiple
documents, and document attributes may change, so a document nullifier is not
silently upgraded into person-level uniqueness. `human.unique` is reserved for
methods whose contract provides person-level deduplication, such as a reviewed
biometric-class method. Provider name alone is never sufficient: the manifest
must name the contractual method and assurance supporting the claim.

ZKPassport can emit `document.valid`, `nationality.allowed`, other disclosed
document predicates, and `credential.subject_unique` with `document_zk`
assurance. Nationality allowlists may be proven without disclosing the country;
optional disclosure is represented separately in the typed assertion value.
The pinned SDK's identifier type `0` is `NON_SALTED`: its raw identifier is
stable but identical across relying parties and therefore cross-RP linkable.
api-next never persists or logs that raw value; it SHA-256 hashes it and places
the digest in a subject-key namespace carrying `pirate-social`. That namespace
prevents internal key collisions but does not make the vendor identifier
unlinkable. This is an explicit trust/privacy tradeoff, not a scope-derived
privacy guarantee.
Self Pass emits the same canonical claim class and currently uses
`document_zk`; a stronger Self-specific assurance must not be introduced until
the live method contract justifies it. The subject key is scoped to its issuer
and relying party. Very liveness remains a separate claim; a policy needing
both claims must require a shared binding witness.

`document.valid` means that the provider accepted the cryptographic
attestation and, for an expiring document, that its authenticated expiry date
has not passed at the evidence observation time. Self Pass enforces the
passport/ID expiry locally. Aadhaar's vendor output explicitly reports no
expiry, so that credential is accepted without inventing one.

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
Self Pass compiles dynamic age, nationality, and gender requirements and runs
the pinned `@selfxyz/core@1.2.0-beta.1` `SelfBackendVerifier` inside the
Cloudflare Worker, as the previous production Worker did. Nationality and
gender are disclosed by Self and checked against the immutable canonical
requirements after cryptographic verification. ZKPassport compiles dynamic
community requirements into self-served queries and uses its separate Node
verifier service; the ZKPassport serverless constraint does not apply to Self.
Self Enterprise remains an optional later method, not the launch path.

The product may offer every provider whose plan is supported, and a user whose
document is not covered by one provider can start a fresh ceremony with
another. A nationality is never considered unsupported merely because one
provider cannot verify that user's document. The initial static intent resolver
contains only platform age-18 and age-21 intents; it is a trusted bootstrap
bridge, not the community policy-authoring surface.

For privacy-preserving membership proofs, `nationality.allowed` may assert only
`{ allowed: true }`, with disclosure of the actual country optional. That
assertion is meaningful only with the same session's canonical country set; it
is not a reusable global nationality fact. Every ZKPassport ceremony that
produces `credential.subject_unique`, including rewards, uses the single pinned
platform RP scope. Dashboard policy-version scopes are reserved for
disclosure-only/template use because rotating them would fragment stable
subject identity. Additional providers use the same manifest, plan, start,
completion, and evidence seams without entering the policy language.

Every Self Pass ceremony uses the pinned `pirate-social` RP scope. The
per-intent scope and `unique_human` minting from the previous implementation
are intentionally not carried over. Attestation type is receipt metadata under
one `self.pass` method rather than a separate method namespace per document.
The exact beta SDK pin is deliberate production parity; prerelease churn and
the newer package's deprecation signal are accepted compatibility risks to be
reviewed through an explicit upgrade, never a floating dependency range.

### Canonical policy identity and hash

Every curated policy's `policy_hash` is the SHA-256 commitment to one
authoritative preimage. The gates-v2 public `policyCanonicalPreimage` helper
is the implementation of this contract. It constructs compact JSON with the
following exact top-level key order:

1. `co_reference`
2. `freshness`
3. `minimum_age`
4. `policy_key`
5. `policy_version_id`
6. `required_assurance`
7. `requirements`
8. `revision`

The `requirements` value is normalized to exactly three objects, in the policy
order: `{ claim_id, minimum_age }` for `age.minimum`, followed by
`{ claim_id }` for `credential.subject_unique`, followed by `{ claim_id }` for
`document.valid`. No other requirement fields or object keys participate. The
`revision` JSON key is the wire representation of the policy's
`policy_revision` field. The preimage is the UTF-8 encoding of this compact
JSON (no insignificant whitespace); its SHA-256 digest is encoded as
lowercase hexadecimal.

Changing any policy value, requirement ordering/content, normalized
representation, or hash algorithm requires a new policy revision, a newly
computed hash, and a new `policy_version_id` where the versioning policy calls
for one. A stored revision must never be reused with a different preimage or
hash. The exported helper is the only supported way for callers to construct
or audit this preimage.

## Session start and replay

Session start is a reservation state machine keyed by actor and intent and
bound to the canonical request hash. Acquisition commits before calling a
provider, the provider call runs without a database lock, and finalization uses
a monotonically increasing fencing token checked inside the transaction. The
lease is derived from the manifest's enforced start deadline plus a margin.
A matching finalized reservation replays the stored presentation; a matching
active lease returns a typed retryable response with `Retry-After`; request
drift is a terminal conflict. Provider failure releases the reservation, lease
expiry permits a fresh fenced acquisition, and a stale finalizer cannot attach
rows after a later generation acquires the intent.

Completed starts return a distinct already-completed response without minting
a new ceremony. Failed or expired terminal sessions require a new intent rather
than silently replacing their history.

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
  metadata, source session, bounded provider receipt metadata, and optional
  subject-key linkage;
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
`poll_result` channel whose payload remains provider-local. Callback adapters
declare either `cryptographically_authenticated` or `session_bound_proof`
trust. The former authenticates the raw callback before local session lookup.
The latter may parse only an opaque high-entropy session identifier before
lookup; cryptographic verification remains in completion against the stored
session. Self Pass uses the session-bound mode: the generic callback route
extracts the UUID, completion reconstructs `DefaultConfigStore` and
`SelfBackendVerifier` from immutable session requirements and configuration,
and the verified user-defined data must bind both proof-session ID and request
hash. Platform authorization, cookies, Cloudflare Access credentials, and
configured internal-auth headers are stripped at the HTTP handler boundary
before application callback handling, even if a manifest requests them. The
guarded registry repeats the filter before the adapter as defense in depth.
The checked-in development, staging, and production Wrangler environments
explicitly record that no additional internal credential-header names are
currently deployed; adding one requires updating that reviewed inventory.

The application returns an existing terminal result only for the same
idempotency key and delegates one transaction that persists the winning
evidence bundle and terminal session event together.
The database clock is authoritative for the final expiry check and terminal
timestamp; a slow provider cannot commit after expiry using a time captured
before the upstream call. Reservation admission reads `clock_timestamp()`
after acquiring its row locks rather than using PostgreSQL's transaction-start
timestamp, so lock waits cannot make expired sessions or leases appear active.
If a terminal completion wins between the application's initial read and
attempt reservation, the loser reloads and returns the same-key persisted
replay. Before expensive provider completion, a short
transaction reserves a fenced attempt keyed by proof session and idempotency
key. The rows enforce two distinct limits. Cryptographically bound policy
rejections consume the durable user-attempt budget. A submission rejected
before proof-to-session binding is established consumes no durable slot but
keeps its short lease until expiry, which temporarily throttles anonymous
verifier work. If active leases fill the remaining capacity, admission is
retryable; only durable bound rejections can permanently exhaust the session.
Same-key concurrency is deduplicated, expired leases free capacity, and stale
finalizers cannot write evidence. Positively identified provider unavailability,
provider defects, and internal hashing failures release the attempt for retry.
Only one database transaction can commit evidence. A deferred constraint
prevents any terminal proof-session row from committing without its matching
append-only completion event.

Session-bound public callbacks retain a deliberate residual availability
tradeoff: a party holding a victim's launch payload can occupy all three short
admission leases and delay the genuine callback until the earliest lease
expires. They cannot permanently spend the victim's bound-attempt budget. The
response is retryable, and a fresh intent remains the recovery path if the
provider client does not retry. Authenticated callback envelopes should be
preferred whenever a provider offers them; session-bound proof mode exists for
providers such as Self Pass whose proof is the first cryptographic trust point.

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
append-only client presentations, and
`0011_verification_start_reservations.sql` for fenced start idempotency, then
`0012_verification_completion_attempts.sql` for bounded, fenced completion
attempts. The earlier review-only two-delta foundation sequence was never
applied to a durable environment and was explicitly reset
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

## Self Pass runtime evidence

The Worker uses `nodejs_compat`, an exact SDK version, a literal lazy import,
and the same verifier construction pattern proven in the previous production
Worker. No Self VPS and no `CompiledWasm` Wrangler rule are required; the old
repository's WASM rule belonged to unrelated code. The hermetic workerd suite
constructs the pinned verifier and invokes its real verification path with a
malformed proof to prove bundling and runtime compatibility. A successful
cryptographic proof cannot be honestly fabricated as a timeless repository
fixture, so positive-path acceptance requires a fresh external Self ceremony in
staging after deployment is separately authorized. The current M3 configuration
enables Self only in staging's developer/mock-document mode; production remains
disabled and real-document physical evidence still requires a separate
authorization and redeploy. The Self adapter also runs its provider-shaped
translations and hostile cases through the shared transport harness. The SDK's
named registry and verifier contract errors map to provider unavailability;
unknown throws remain proof rejection rather than being silently upgraded to
an outage.

## ZKPassport backend checkpoint

The backend vertical was implemented and independently audited on 2026-08-18,
after the pure age-18 evaluator checkpoint. It adds a deterministic dynamic
query compiler, client-result adapter, authenticated verifier transport, and a
separate Bun-only verifier runtime pinned exactly to `@zkpassport/sdk@0.14.2`.
The SDK is not imported by the Cloudflare Worker. Domain, development mode,
validity, query compiler, SDK, and verifier-contract versions are persisted in
the provider configuration; completion regenerates the query from the stored
session and ignores client-authored query material.

The first adapter surface is limited to `age.minimum`,
`credential.subject_unique`, `document.valid`, and `nationality.allowed` with
`document_zk` assurance and the pinned `pirate-social` relying-party scope. It
does not emit `human.unique`, liveness, personhood, holder binding, gender,
facematch, sanctions, or arbitrary disclosed predicates. Nationality uses the
exact canonical allowlist through a sorted alpha-2 to alpha-3 conversion.

This checkpoint is code-complete but not deployed. ZKPassport remains disabled
in every checked-in Worker environment. Staging requires a frontend consumer
for the embedded-SDK presentation, a separately provisioned verifier runtime
and secret, and a representative real-proof payload measurement. The public
completion route currently caps request bodies at 1 MiB while the internal
verifier accepts at most 10 MiB, so staging must prove the real payload fits or
make and review a deliberate ingress-limit change before enablement.

## Curated community-join lifecycle amendment — 2026-08-19

For the first curated-age community-join vertical, expired evidence is
actionable rather than terminal: the evaluator returns `needs_evidence` with
`evidence_expired`, so a member can obtain fresh evidence and retry. This
amendment makes explicit the behavior pinned by the evaluator and the
PostgreSQL join suite and supersedes any earlier provisional wording that
treated expiry itself as a terminal `fail`.

Terminal `fail` remains reserved for evidence that cannot satisfy the active
policy for the request, including an underage result or conflicting evidence;
provider/store unavailability remains `indeterminate`. Wrong assurance,
missing claims, future observations, and expired evidence remain actionable
`needs_evidence`. The preview path remains read-only, while an enforce-mode
join records the decision and inserts membership in one transaction only when
the outcome is `pass`.

The PostgreSQL acceptance tranche is now closed in `e09b732`: the seven-case
gates suite covers the five core cases plus policy-pointer mismatch, both
transaction rollback directions, explicit gated replay, witness JSON read-back,
and the no-membership-without-enforce/pass invariant. The full disposable
PostgreSQL inventory passes 95/95 across 16 files. This is local acceptance
evidence only; it does not authorize staging, deployment, or migration
application.

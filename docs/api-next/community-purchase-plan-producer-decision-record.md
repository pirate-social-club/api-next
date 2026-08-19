# Community-purchase plan-producer decision record

Status: **fully ratified for Option A; coordinator-owned producer implementation
checkpointed; staging and production admission remain separately unauthorized**
(2026-08-19).

Authority: [M3 completion charter](../../../docs/specs/api-next/005-m3-completion-charter.md),
especially sections 2, 4, and 7, and the accepted [money-flow
specification](../../../docs/specs/api-next/004-money-flows-karaoke-rewards-megapot.md).

## Decision to make

Choose the authoritative product owner that derives a community-purchase quote
and calls api-next's narrow immutable-plan creation port. The producer must be
authenticated and authorized for the actor and community, derive all economic
terms from target-owned policy, and persist one immutable plan before `begin`
is exposed. Browser input may identify the purchase intent, but it may not
author or override the quote.

The owner selection is recorded below. It does not authorize legacy-quote import,
staging seed, migration application, deployment, or admission exposure.

## Ratified owner selection — 2026-08-19

The workspace human ratifies **Option A**: the commerce authority moves into
`api-next` as one coherent product-owned slice. The accountable owner is
`api-next` itself, with its own PostgreSQL commerce storage and immutable,
versioned policy snapshots. The slice writes the existing
`community_purchase_funding_plans` boundary after deriving the complete quote.

This selection stays inside the two-system clean-break boundary and does not
amend the M3 charter. The field-level source/table contract and five product
parameters below are ratified as well. The producer implementation is
checkpointed locally in api-next `a02c74a`; migration application, staging
seed, deployment, and production admission remain separately unauthorized.

## Non-negotiable boundary

The authoritative source must own, or expose through one ratified product-owned
slice, the complete commerce decision:

1. active listing eligibility and purchase identity;
2. community membership and any purchase-specific eligibility;
3. regional pricing and verification snapshots;
4. community money/route policy, including chain, token, treasury, and finality;
5. allocation snapshots and any quantity/availability reservation;
6. Story settlement mode;
7. donation policy; and
8. per-community commerce storage and policy-version history.

The source may be a moved commerce slice or a newly ratified product service,
but it must have one accountable owner, one versioned read contract, and an
auditable snapshot identity. Copying only a legacy quote result, importing
derived values from the legacy API, or duplicating these authorities in
api-next is rejected: each would create a cross-service commerce bridge or
invent economic authority.

## Options

### A — Move the coherent commerce slice (selected)

Move the eight authorities above together into the target commerce owner. The
owner supplies an authenticated quote use case that resolves the listing,
membership/eligibility, regional policy, money route, allocations, settlement,
donation, and storage snapshots in one product-owned transaction or immutable
source revision. It then calls the existing api-next plan port with only the
already-derived terms.

This preserves the strangler boundary and keeps api-next responsible for plan
admission, journal truth, chain evidence, reconciliation, and retention. The
cost is a larger coordinated migration and a new target-owned storage/read
surface before M3 admission can ship.

### B — Ratify a replacement product source

Name a replacement commerce product and owner, its storage, authorization
model, immutable quote/snapshot contract, and retention/audit policy. The
replacement must provide the same eight authorities as one coherent source;
it may not be a thin proxy around legacy quote output. The owner then exposes
the exact server-to-api-next plan contract and accepts responsibility for
quote correctness, expiry, policy revisions, and replay/conflict semantics.

This can reduce migration scope if the replacement is already a real product
authority, but it requires explicit product ratification and a new source
contract before implementation.

### Rejected — import or selectively copy legacy quote output

Rejected under the M3 charter. A quote result is derived data, not ownership of
listing, eligibility, regional pricing, route, allocation, settlement,
donation, and commerce records. Importing it would make legacy API behavior a
hidden production dependency and would make api-next accountable for values it
cannot authorize or reconstruct.

## Target-owned source/table proposal (Option A answer set)

This is the ratified PostgreSQL design and its local implementation; it is not
an applied staging or production schema. The authoritative runtime store is
`api-next/db/postgres`; the similarly named
`db/community-shard` commerce migrations are compatibility fixtures from the
old template and are not a source of runtime authority. Existing target tables
that remain in scope are `communities`, `community_memberships`, `users`, and
`community_purchase_funding_plans`. The local implementation is migration
`0021_m3_community_purchase_commerce.sql`, with an atomic checksum entry; it
remains unapplied outside local test schemas pending separate staging
authorization and preflight.

### Shared revision and quote identities

- `community_commerce_policy_revisions` is the immutable aggregate revision
  for one community. Its key is `(community_id, policy_version)` and it stores
  the source revision, creator, effective time, and supersession metadata.
  Every authority snapshot below references this revision; the existing plan's
  `policy_version` binds the resulting funding operation to it.
- `community_purchase_intents` owns the server-generated `purchase_id`, the
  actor/community/listing identity, and the availability lifecycle. It is not
  a browser-supplied economic value.
- `community_purchase_quotes` is the immutable quote snapshot keyed by
  `quote_id`. It records `purchase_id`, `policy_version`, every authority
  snapshot ID, the already-derived plan terms, `quoted_at`, `expires_at`, and
  append-only lifecycle/correction references. The producer creates the quote,
  reservation, and funding plan in one target-owned transaction or equivalent
  revision-safe unit.

### Authority-to-table mapping

| Authority | Target-owned source/snapshot tables | Snapshot identity and invariant |
| --- | --- | --- |
| Active listing eligibility and purchase identity | `community_commerce_listings`, `community_purchase_intents`, `community_purchase_quotes` | `listing_id`, `purchase_id`, and `quote_id` are server identities. A quote may reference only an active listing in its captured revision; the subject is exactly one asset/live-room/replay target. |
| Membership and purchase eligibility | Existing `community_memberships`; new `community_commerce_eligibility_policy_versions` and `community_purchase_eligibility_snapshots` | The quote stores `eligibility_snapshot_id` and the aggregate `policy_version`. The snapshot records the membership/gate decision and input revision; missing, foreign, or ineligible resources use the same public not-found boundary. |
| Regional pricing and verification | `community_commerce_pricing_policy_versions`, `community_purchase_pricing_snapshots`, `community_purchase_verification_snapshots` | Each quote stores the pricing and verification snapshot IDs, tier, final integer amount, and policy version. Verification evidence is immutable and references its provider/policy revision. |
| Community money/route policy | `community_commerce_money_route_policy_versions`, `community_purchase_route_snapshots` | The snapshot fixes funding mode, source chain/asset, destination chain/token/decimals, treasury, route provider/status policy, and finality requirements. The browser cannot supply or override any of these fields. |
| Allocation and availability | `community_commerce_allocation_policy_versions`, `community_purchase_allocation_snapshots`, `community_purchase_availability_reservations` | Allocation rows are immutable per quote. A reservation is unique for the purchase/listing, has an explicit expiry, and transitions atomically through `held`, `consumed`, `released`, or `expired`; an expired/released reservation cannot be reused by the old quote. |
| Story settlement mode | `community_commerce_settlement_policy_versions`, `community_purchase_settlement_snapshots` | The quote stores the settlement snapshot and mode (`delivery_only_story_settlement` or `royalty_native_story_payment`) with its policy revision; changing policy creates a new revision and never edits an issued quote. |
| Donation policy | `community_commerce_donation_policy_versions`, `community_commerce_donation_partners`, `community_purchase_donation_snapshots` | Partner, share, destination, and policy mode are snapshotted into the quote. Partner changes create a new policy revision; prior quote/settlement records remain readable. |
| Per-community commerce storage and policy history | `community_commerce_policy_revisions`, all authority snapshot tables, `community_purchase_quotes`, and append-only `community_purchase_correction_events` | The aggregate revision plus per-authority IDs is the auditable source lineage. Quote, reservation, correction, and plan records are retained indefinitely; no legacy table or derived quote import is a runtime dependency. |

### Time, reservation, and correction rules

- The product must choose one quote TTL in the existing plan-port bound of
  **1–3,600 seconds**. The exact value is still a product parameter; widening
  the bound requires a reviewed code/spec amendment. `quoted_at` and
  `expires_at` come from PostgreSQL time, never browser time.
- Quote creation locks the listing/availability row, evaluates the captured
  policy revision, writes the reservation and quote, and then writes the plan
  with the same `quote_id`, `purchase_id`, and `policy_version`. A bind or
  replay checks the quote and reservation against database time in one
  transaction.
- A policy correction never mutates a revision, quote, reservation, or funding
  plan. It appends a correction event, releases/cancels an unbound reservation
  where allowed, and issues a new revision and quote. A bound plan remains
  immutable and follows the M3 journal rules.
- Exact replay of the same actor/purchase/quote returns the original durable
  result. A different payload or actor for an existing identity is a conflict
  or enumeration-safe not-found outcome; it never overwrites a quote.

### Authorization and ratified answer-set fields

The producer uses the authenticated Privy-session actor and normalized wallet,
checks `community_memberships.status = 'member'` plus the captured eligibility
policy, and returns the same public failure for missing, foreign, or ineligible
listing/quote identities. The plan port remains the only writer of the funding
plan terms after the commerce slice derives them.

## Ratified source/table answer set — 2026-08-19

The workspace human ratifies the following five parameters without changing the
M3 charter, spec 004, or the existing plan-port bound:

1. **Quote TTL:** `600` seconds. `quoted_at` and `expires_at` use PostgreSQL
   time, and the reservation expires at the same `expires_at`. The value is
   inside the existing `[1, 3_600]` plan-port validation bound.
2. **Availability:** every listing declares `availability_mode` as
   `unbounded` or `finite`. A finite listing owns a server-side count. Each
   quote reserves exactly one unit; admission marks it `consumed`, correction
   cancellation or failed admission marks it `released`, and expiry is a lazy
   database-time state. Unbounded listings still write a reservation row for a
   uniform audit trail. Partial holds are not supported.
3. **Policy revisions:** revisions are append-only and issued only through an
   operator-authorized coordinator path (a future community-admin surface is a
   separate decision). A revision is effective immediately at database time;
   M3 does not schedule future-effective revisions. Issued quotes retain their
   captured revision; supersession is metadata only; every issuance writes the
   operator ledger.
4. **Verification:** the existing ratified zkPath, the integrated zkPassport
   `0.14.2` verifier, is the provider. Immutable snapshots record provider and
   policy revision and are owned by the quoting actor. A snapshot is valid for
   at most 24 hours; required-but-missing or invalid verification rejects the
   quote through the same enumeration-safe boundary, and pricing never trusts
   a client-declared region.
5. **Corrections:** only the operator/coordinator role may append a correction
   event. It may cancel an unbound quote, release its unbound reservation, and
   issue a superseding revision. It may not mutate an issued quote, bound plan,
   consumed reservation, or M3 journal truth. Each append records operator ID,
   kind, reason, PostgreSQL time, and affected IDs, is idempotent by
   `(target_identity, kind)`, and is retained indefinitely.

The following implementation invariants are part of this ratification:

- quote, reservation, and funding-plan writes are all-or-nothing; a plan-port
  failure rolls back the quote and reservation together;
- bind and quote paths evaluate expiry as a PostgreSQL-time predicate, with
  stored `expired` transitions only for audit and no new sweeper requirement;
- reservations are never renewed or extended. A new quote is the only path
  after expiry or release.

## Read-only legacy evidence (context only; not an authority decision)

The legacy repository is useful for locating the questions a ratified owner
must answer, but these references do not authorize an import or runtime bridge:

- [`STORY_CDR_PATHS.md`](../../../api/STORY_CDR_PATHS.md) maps the live listing,
  purchase-quote, and purchase-settlement routes to their service entry points.
- [`services/contracts/src/index.ts`](../../../api/services/contracts/src/index.ts)
  defines the observed listing, quote, settlement, allocation, pricing, route,
  donation, and expiry fields; in particular, the quote shape includes
  `final_price_cents`, `allocation_snapshot`, settlement chain/token,
  `funding_destination_address`, `pricing_policy_version`, `quoted_at`, and
  `expires_at`.
- [`services/api/tests/community-db-factory.test.ts`](../../../api/services/api/tests/community-db-factory.test.ts)
  records legacy table surfaces including `purchase_quotes`, `purchases`,
  `purchase_allocation_legs`, settlement effects/transactions/attempts,
  donation-partner data, and a community-membership lookup index.
- [`services/api/src/routes/communities-commerce.ts`](../../../api/services/api/src/routes/communities-commerce.ts)
  confirms that the quote and settlement routes are authenticated community
  routes, but route reachability is not proof that the legacy service is the
  future owner.

The target-table proposal above replaces these observations. The legacy
references remain only to explain why each target-owned authority is required;
they do not authorize an import, copy, or runtime bridge.

## Required ratification answers

The ratified record contains:

- selected option and accountable product repository/owner (**Option A / api-next
  is fully ratified**);
- authoritative source tables or service revision for each of the eight
  authorities, including the snapshot/version identity (**ratified by the
  source/table proposal above**);
- authenticated actor/community authorization and enumeration-safe failure
  behavior;
- the exact server-to-api-next plan payload, including `quoteId`, community,
  actor, purchase, policy version, buyer wallet/chain, token/decimals,
  treasury, atomic amount, required confirmations, and quote TTL;
- quote expiry, replay/conflict, availability/reservation, and correction
  rules, all using target-owned time and policy (**ratified above**);
- storage migration and retention/audit obligations; and
- the evidence and staging tranche required before production admission.

No spec amendment is triggered. The existing plan port remains product-internal
until the producer tranche supplies it with target-owned terms; `begin` remains
unexposed in production until the producer's implementation evidence passes.

## Post-ratification implementation gate

The implementation gate is now open for a coordinator-owned api-next tranche to
implement the producer and wire admission. Its minimum evidence is authenticated and
authorized plan derivation, no browser-authored economics, missing/foreign
enumeration safety, exact replay and conflict behavior, expiry, policy/source
revision binding, and real-Postgres coverage through the existing narrow plan
creation port. Client or Solid changes are separate intake decisions and do
not substitute for the product-authority decision.

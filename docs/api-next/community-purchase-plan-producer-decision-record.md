# Community-purchase plan-producer decision record

Status: proposed; human product ratification required before implementation
or production admission (2026-08-19).

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

This record does not ratify either option below. No plan-producer code,
legacy-quote import, staging seed, migration, deployment, or admission exposure
is authorized by this proposal.

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

### A — Move the coherent commerce slice

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

## Read-only evidence inventory (not an authority decision)

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
  `community_memberships`, and donation-partner data.
- [`services/api/src/routes/communities-commerce.ts`](../../../api/services/api/src/routes/communities-commerce.ts)
  confirms that the quote and settlement routes are authenticated community
  routes, but route reachability is not proof that the legacy service is the
  future owner.

The ratification must therefore replace these observations with named target
tables or a target service revision for every authority above, plus the
snapshot/version and retention contract.

## Required ratification answers

The human decision must name:

- selected option and accountable product repository/owner;
- authoritative source tables or service revision for each of the eight
  authorities, including the snapshot/version identity;
- authenticated actor/community authorization and enumeration-safe failure
  behavior;
- the exact server-to-api-next plan payload, including `quoteId`, community,
  actor, purchase, policy version, buyer wallet/chain, token/decimals,
  treasury, atomic amount, required confirmations, and quote TTL;
- quote expiry, replay/conflict, availability/reservation, and correction
  rules, all using target-owned time and policy;
- storage migration and retention/audit obligations; and
- the evidence and staging tranche required before production admission.

If the chosen shape changes the M3 charter or money-flow specification, amend
those documents before implementation. Until the answers are recorded and
ratified, the existing plan port remains product-internal and `begin` remains
unexposed in production.

## Post-ratification implementation gate

Only after ratification may a coordinator-owned api-next tranche implement the
producer and wire admission. Its minimum evidence is authenticated and
authorized plan derivation, no browser-authored economics, missing/foreign
enumeration safety, exact replay and conflict behavior, expiry, policy/source
revision binding, and real-Postgres coverage through the existing narrow plan
creation port. Client or Solid changes are separate intake decisions and do
not substitute for the product-authority decision.

import type { ControlPlaneTransaction, HandleSalesStore } from "@pirate/application";
import type {
  CreateHandleSpacesQuoteResultV1,
  HandleSpacesClaimV1,
  HandleSpacesGrantPrivateV1,
  HandleSpacesQuoteV1,
  HandleSpacesRecipientV1,
  HandleSpacesReservationV1,
} from "@pirate/contracts";
import {
  classifyEffectiveHandleOfferingV2,
  type HandleEligibilitySnapshotV1,
  type HandleFreePricingV1,
  handleIssuanceOperationIdV1,
  handlePersonaPublicIdentityHash,
  handleSpacesGrantFinalizeV3Hash,
  handleSpacesQuoteV3Hash,
  handleSpacesReservationV3Hash,
  isCanonicalSpacesSubspaceLabelV1,
  isP2trOutputScriptHexV1,
  type SpacesNetworkV1,
  type SpacesRecipientBindingV1,
  spacesClaimDelayedV1,
  submitSpacesClaimV1,
} from "@pirate/domain";
import { Effect } from "effect";
import {
  advisoryLock,
  instant,
  integer,
  nullableInteger,
  nullableText,
  one,
  type Row,
  reject,
  stringArray,
  text,
} from "./handle-sales-internals.ts";
import { spacesTaprootOutputScriptFromAddress } from "./spaces-taproot-recipient.ts";

/**
 * Native Spaces quote, reservation, and atomic claim (spec 012 §5.3.13.6-
 * §5.3.13.8 and §5.3.13.12). The HNS repository routes a `spaces_native_v1`
 * offering, quote, or reservation here inside its own transaction and keeps
 * its HNS SQL unchanged. Every step reads Pirate's own records: membership is
 * the Spec 016 row, the recipient is the persona's Taproot assignment, and no
 * provider, wallet, or operator is called. A refusal that precedes the first
 * write leaves no row behind.
 */

type QuoteInput = Parameters<HandleSalesStore["createQuote"]>[0];
type ReservationInput = Parameters<HandleSalesStore["createReservation"]>[0];
type ClaimInput = Parameters<HandleSalesStore["submitFreeClaim"]>[0];

/** The same key and account-cap lock namespaces as the HNS paths. */
const KEY_LOCK_NAMESPACE = 53_004;
const CAP_LOCK_NAMESPACE = 53_005;

const network = (row: Row, key: string): SpacesNetworkV1 => {
  const value = text(row, key);
  if (value !== "mainnet" && value !== "testnet4" && value !== "regtest") {
    throw new Error(`invalid ${key}`);
  }
  return value;
};

const requireSpacesRow = (row: Row, label: string): void => {
  if (row.family !== "spaces" || row.fulfillment_kind !== "spaces_native_v1") {
    throw new Error(`invalid Spaces ${label} family`);
  }
};

/** The private binding, including the Spec 014 §12 assignment id the hashes pin. */
const spacesRecipientBindingFromRow = (row: Row): SpacesRecipientBindingV1 => {
  const script = text(row, "recipient_script_pubkey_hex");
  if (row.recipient_kind !== "persona_taproot_v1" || !isP2trOutputScriptHexV1(script)) {
    throw new Error("invalid Spaces recipient");
  }
  return {
    kind: "persona_taproot_v1",
    network: network(row, "recipient_network"),
    taproot_assignment_id: text(row, "recipient_taproot_assignment_id"),
    script_pubkey_hex: script,
  };
};

/** The owner-only projection never carries the private assignment id. */
const recipientProjection = (binding: SpacesRecipientBindingV1): HandleSpacesRecipientV1 => ({
  kind: binding.kind,
  network: binding.network,
  script_pubkey_hex: binding.script_pubkey_hex,
});

const spacesKey = (row: Row, prefix = "") =>
  ({
    family: "spaces",
    namespace_root: text(row, `${prefix}namespace_root`),
    handle_label: text(row, `${prefix}handle_label`),
  }) as const;

export const spacesQuoteFromRow = (row: Row): HandleSpacesQuoteV1 => {
  requireSpacesRow(row, "quote");
  if (row.nationality_qualification_pin != null) throw new Error("invalid Spaces quote pin");
  return {
    quote_id: text(row, "quote_id"),
    quote_hash: text(row, "quote_hash"),
    offering_id: text(row, "offering_id"),
    offering_revision: integer(row, "offering_revision"),
    offering_hash: text(row, "offering_hash"),
    sale_namespace_activation_id: text(row, "sale_namespace_activation_id"),
    sale_namespace_activation_generation: integer(row, "sale_namespace_activation_generation"),
    fulfillment: { kind: "spaces_native_v1" },
    owner_persona_id: text(row, "owner_persona_id"),
    recipient: recipientProjection(spacesRecipientBindingFromRow(row)),
    handle: spacesKey(row),
    display_identifier: text(row, "display_identifier"),
    pricing: {
      kind: "free_v1",
      pricing_id: text(row, "pricing_id"),
      pricing_revision: integer(row, "pricing_revision"),
      pricing_hash: text(row, "pricing_hash"),
      atomic_amount: "0",
    },
    eligibility: {
      policy_revision: integer(row, "eligibility_policy_revision"),
      policy_hash: text(row, "eligibility_policy_hash"),
      decision: "passed",
      evidence_use_ids: [...stringArray(row.evidence_use_ids)],
      evaluated_at: instant(row.evaluated_at),
    },
    status: text(row, "status") as HandleSpacesQuoteV1["status"],
    quoted_at: instant(row.quoted_at),
    expires_at: instant(row.expires_at),
  };
};

export const spacesReservationFromRow = (row: Row): HandleSpacesReservationV1 => {
  requireSpacesRow(row, "reservation");
  return {
    reservation_id: text(row, "reservation_id"),
    reservation_hash: text(row, "reservation_hash"),
    quote_id: text(row, "quote_id"),
    quote_hash: text(row, "quote_hash"),
    offering_id: text(row, "offering_id"),
    offering_hash: text(row, "offering_hash"),
    sale_namespace_activation_id: text(row, "sale_namespace_activation_id"),
    sale_namespace_activation_generation: integer(row, "sale_namespace_activation_generation"),
    fulfillment: { kind: "spaces_native_v1" },
    owner_persona_id: text(row, "owner_persona_id"),
    recipient: recipientProjection(spacesRecipientBindingFromRow(row)),
    handle: spacesKey(row),
    status: text(row, "status") as HandleSpacesReservationV1["status"],
    reserved_at: instant(row.reserved_at),
    expires_at: instant(row.expires_at),
  };
};

const spacesGrantFromRow = (row: Row): HandleSpacesGrantPrivateV1 => ({
  grant_id: text(row, "grant_grant_id"),
  grant_generation: integer(row, "grant_grant_generation"),
  community_id: text(row, "grant_community_id"),
  offering_id: text(row, "grant_offering_id"),
  offering_hash: text(row, "grant_offering_hash"),
  claim_id: text(row, "grant_claim_id"),
  owner_persona_id: text(row, "grant_owner_persona_id"),
  sale_namespace_activation_id: text(row, "grant_sale_namespace_activation_id"),
  sale_namespace_activation_generation: integer(row, "grant_sale_namespace_activation_generation"),
  fulfillment: { kind: "spaces_native_v1" },
  handle: spacesKey(row, "grant_"),
  display_identifier: text(row, "grant_display_identifier"),
  status: text(row, "grant_status") as HandleSpacesGrantPrivateV1["status"],
  issued_at: instant(row.grant_issued_at),
});

/**
 * `delayed` is derived, never stored: commits of the claim's space are paused
 * by the latest funding observation of its current operator assignment, or the
 * reconciler has marked the claim overdue. With no observation the pause is
 * unknown and not reported (ruling Q6). The member never sees the reason.
 */
export const spacesClaimFromRow = (row: Row): HandleSpacesClaimV1 => {
  requireSpacesRow(row, "claim");
  const state = text(row, "state");
  if (state !== "issuance_pending" && state !== "issued" && state !== "issuance_failed") {
    throw new Error("invalid Spaces claim state");
  }
  const commitsPaused = row.commits_paused;
  if (commitsPaused !== null && typeof commitsPaused !== "boolean") {
    throw new Error("invalid Spaces commit pause");
  }
  if (typeof row.past_overdue_alert !== "boolean") throw new Error("invalid Spaces overdue mark");
  return {
    claim_id: text(row, "claim_id"),
    owner_persona_id: text(row, "owner_persona_id"),
    offering_id: text(row, "offering_id"),
    offering_hash: text(row, "offering_hash"),
    quote_id: text(row, "quote_id"),
    reservation_id: text(row, "reservation_id"),
    reservation_hash: text(row, "reservation_hash"),
    sale_namespace_activation_id: text(row, "sale_namespace_activation_id"),
    sale_namespace_activation_generation: integer(row, "sale_namespace_activation_generation"),
    fulfillment: { kind: "spaces_native_v1" },
    recipient: recipientProjection(spacesRecipientBindingFromRow(row)),
    handle: spacesKey(row),
    display_identifier: text(row, "display_identifier"),
    payment: {
      kind: "not_required_v1",
      pricing_revision: integer(row, "pricing_revision"),
      pricing_hash: text(row, "pricing_hash"),
      atomic_amount: "0",
      status: "not_applicable",
    },
    state,
    delayed: spacesClaimDelayedV1({
      claim: state,
      commits_paused: commitsPaused,
      past_overdue_alert: row.past_overdue_alert,
    }),
    safe_reason: nullableText(row, "safe_reason") as HandleSpacesClaimV1["safe_reason"],
    grant: row.grant_grant_id === null ? null : spacesGrantFromRow(row),
    created_at: instant(row.created_at),
    updated_at: instant(row.updated_at),
  };
};

const SPACES_CLAIM_SELECT = `
  SELECT claim.*,
         handle_grant.grant_id AS grant_grant_id,
         handle_grant.grant_generation AS grant_grant_generation,
         handle_grant.community_id AS grant_community_id,
         handle_grant.offering_id AS grant_offering_id,
         handle_grant.offering_hash AS grant_offering_hash,
         handle_grant.claim_id AS grant_claim_id,
         handle_grant.owner_persona_id AS grant_owner_persona_id,
         handle_grant.sale_namespace_activation_id AS grant_sale_namespace_activation_id,
         handle_grant.sale_namespace_activation_generation AS grant_sale_namespace_activation_generation,
         handle_grant.namespace_root AS grant_namespace_root,
         handle_grant.handle_label AS grant_handle_label,
         handle_grant.display_identifier AS grant_display_identifier,
         handle_grant.status AS grant_status,
         handle_grant.issued_at AS grant_issued_at,
         (SELECT funding.funding_status = 'commits_paused_insufficient_funds_v1'
            FROM spaces_operator_assignment_current AS assignment
            JOIN spaces_operator_funding_observations AS funding
              ON funding.operator_assignment_id = assignment.operator_assignment_id
             AND funding.operator_assignment_generation = assignment.current_generation
           WHERE assignment.network = claim.recipient_network
             AND assignment.canonical_root = claim.namespace_root
             AND assignment.status = 'active'
           ORDER BY funding.observation_generation DESC
           LIMIT 1) AS commits_paused,
         verification.overdue_marked_at IS NOT NULL AS past_overdue_alert
    FROM handle_claims AS claim
    LEFT JOIN handle_grants AS handle_grant ON handle_grant.grant_id=claim.grant_id
    LEFT JOIN spaces_issuance_verifications AS verification
      ON verification.claim_id=claim.claim_id
   WHERE claim.family='spaces'`;

/** The owner's private claim read; another account's claim is absent. */
export const readSpacesClaim = Effect.fn("readSpacesClaim")(function* (
  executor: ControlPlaneTransaction,
  input: Readonly<{ claimId: string; accountId: string; readonly?: boolean }>,
) {
  const result = yield* executor.execute<Row>({
    label: "spaces-handle-claims.claim.read-owner",
    text: `${SPACES_CLAIM_SELECT}
              AND claim.claim_id=$1 AND claim.actor_account_id=$2`,
    values: [input.claimId, input.accountId],
    readonly: input.readonly ?? false,
  });
  const row = result.rows[0];
  return row === undefined ? null : spacesClaimFromRow(row);
});

const databaseNow = Effect.fn("spacesHandleClaimsDatabaseNow")(function* (
  transaction: ControlPlaneTransaction,
) {
  const clock = yield* transaction.execute<Row>({
    label: "spaces-handle-claims.database-clock.read",
    text: "SELECT clock_timestamp() AS database_now",
    values: [],
    readonly: false,
  });
  return instant(one(clock.rows, "Spaces database clock").database_now);
});

/**
 * Spec 016 active membership for `(community_id, account_id)`: the members-only
 * requirement of §5.3.13.12, with the same predicate as the database guard
 * `handle_spaces_membership_satisfied_v1`. The row is share-locked, so a
 * concurrent leave waits for the transaction that froze its decision.
 */
const activeMembership = Effect.fn("spacesActiveMembership")(function* (
  transaction: ControlPlaneTransaction,
  input: Readonly<{ communityId: string; accountId: string }>,
) {
  const membership = yield* transaction.execute<Row>({
    label: "spaces-handle-claims.membership.lock",
    text: `SELECT membership.membership_id
             FROM community_memberships AS membership
            WHERE membership.community_id=$1
              AND membership.user_id=$2
              AND membership.status='member'
            FOR SHARE`,
    values: [input.communityId, input.accountId],
    readonly: false,
  });
  return membership.rows.length === 1;
});

/** The persona's live Taproot recipient on the activation's network (§5.3.13.6). */
const liveRecipient = Effect.fn("spacesLiveRecipient")(function* (
  transaction: ControlPlaneTransaction,
  input: Readonly<{ accountId: string; personaId: string; network: SpacesNetworkV1 }>,
) {
  const assignment = yield* transaction.execute<Row>({
    label: "spaces-handle-claims.recipient.resolve",
    text: `SELECT assignment.assignment_id,assignment.bitcoin_network,assignment.address,
                 assignment.output_script_hex
             FROM persona_wallet_assignments AS assignment
            WHERE assignment.account_id=$1
              AND assignment.persona_id=$2
              AND assignment.chain_account_kind='bitcoin-taproot'
              AND assignment.status='active'
              AND assignment.bitcoin_network=$3
              AND assignment.output_script_hex IS NOT NULL
            FOR SHARE`,
    values: [input.accountId, input.personaId, input.network],
    readonly: false,
  });
  const row = assignment.rows[0];
  if (row === undefined) return null;
  const script = text(row, "output_script_hex");
  const assignmentNetwork = network(row, "bitcoin_network");
  if (
    !isP2trOutputScriptHexV1(script) ||
    spacesTaprootOutputScriptFromAddress(text(row, "address"), assignmentNetwork) !== script
  ) {
    throw new Error("invalid Taproot recipient script");
  }
  return {
    kind: "persona_taproot_v1",
    network: assignmentNetwork,
    taproot_assignment_id: text(row, "assignment_id"),
    script_pubkey_hex: script,
  } satisfies SpacesRecipientBindingV1;
});

/** Reservation and claim recheck that the bound assignment is still live and unchanged. */
const recipientStillLive = Effect.fn("spacesRecipientStillLive")(function* (
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    accountId: string;
    personaId: string;
    network: SpacesNetworkV1;
    recipient: SpacesRecipientBindingV1;
  }>,
) {
  const assignment = yield* transaction.execute<Row>({
    label: "spaces-handle-claims.recipient.recheck",
    text: `SELECT assignment.assignment_id
             FROM persona_wallet_assignments AS assignment
            WHERE assignment.assignment_id=$1
              AND assignment.account_id=$2
              AND assignment.persona_id=$3
              AND assignment.chain_account_kind='bitcoin-taproot'
              AND assignment.status='active'
              AND assignment.bitcoin_network=$4
              AND assignment.output_script_hex=$5
            FOR SHARE`,
    values: [
      input.recipient.taproot_assignment_id,
      input.accountId,
      input.personaId,
      input.network,
      input.recipient.script_pubkey_hex,
    ],
    readonly: false,
  });
  return input.recipient.network === input.network && assignment.rows.length === 1;
});

/** Active grants plus pending Spaces claims of the account, across sibling personas. */
const accountCapCounter = Effect.fn("spacesAccountCapCounter")(function* (
  transaction: ControlPlaneTransaction,
  input: Readonly<{ accountId: string; offeringId: string }>,
) {
  const counter = yield* transaction.execute<Row>({
    label: "spaces-handle-claims.account-cap.read",
    text: `SELECT counter.active_grant_count,counter.pending_issuance_count
             FROM handle_account_offering_grant_counters AS counter
            WHERE counter.account_id=$1 AND counter.offering_id=$2`,
    values: [input.accountId, input.offeringId],
    readonly: false,
  });
  const row = counter.rows[0];
  return row === undefined
    ? { active_grant_count: 0, pending_issuance_count: 0 }
    : {
        active_grant_count: integer(row, "active_grant_count"),
        pending_issuance_count: integer(row, "pending_issuance_count"),
      };
});

const capAdmits = (
  cap: number | null,
  counter: Readonly<{ active_grant_count: number; pending_issuance_count: number }>,
): boolean =>
  submitSpacesClaimV1({ max_active_grants_per_account: cap, counter }).kind === "accepted";

/** Pending issuance, an external conflict, or a permanent grant blocks the key. */
const keyOccupied = (fence: Row): boolean =>
  fence.permanent_grant_id !== null ||
  fence.pending_claim_id !== null ||
  fence.external_conflict_observation_id !== null;

const addSeconds = (at: string, seconds: number): string =>
  new Date(Date.parse(at) + seconds * 1_000).toISOString();

/**
 * Quote for a `spaces_native_v1` offering. The members-only requirement is
 * evaluated before the recipient is resolved, and both happen before any
 * write: a nonmember receives `qualification_unsatisfied`, and a member whose
 * persona has no confirmed Taproot recipient receives `recipient_wallet_required`.
 */
export const createSpacesQuote = Effect.fn("createSpacesQuote")(function* (
  transaction: ControlPlaneTransaction,
  context: Readonly<{
    input: QuoteInput;
    offering: Row;
    endpoint: "/handle-quotes";
    requestHash: string;
  }>,
) {
  const { input, offering } = context;
  if (!isCanonicalSpacesSubspaceLabelV1(input.desiredLabel)) {
    return yield* reject("invalid_handle");
  }
  if (
    offering.family !== "spaces" ||
    offering.fulfillment_kind !== "spaces_native_v1" ||
    offering.policy_kind !== "spaces_membership_v1" ||
    offering.label_scope_kind !== "label_rule_v2"
  ) {
    return yield* reject("offering_unavailable");
  }
  const activationId = text(offering, "sale_namespace_activation_id");
  const effective = yield* transaction.execute<Row>({
    label: "spaces-handle-claims.quote.activation-effective.read",
    text: `SELECT effective.spaces_network
             FROM effective_community_handle_sale_namespace_v1($1,clock_timestamp()) AS effective
            WHERE effective.family='spaces'`,
    values: [activationId],
    readonly: false,
  });
  if (effective.rows[0] === undefined) return yield* reject("sale_namespace_inactive", true);
  const activationNetwork = network(effective.rows[0], "spaces_network");
  const candidates = yield* transaction.execute<Row>({
    label: "spaces-handle-claims.quote.classifier.read",
    text: `SELECT revision.offering_id,revision.min_label_length,revision.max_label_length,
                  revision.reserved_labels_id,revision.reserved_labels_revision,
                  revision.reserved_labels_hash
             FROM community_handle_offering_revisions AS revision
             JOIN community_handle_offering_current AS current_offering
               ON current_offering.offering_id=revision.offering_id
              AND current_offering.current_revision=revision.offering_revision
            WHERE revision.sale_namespace_activation_id=$1
              AND revision.status='active'
              AND revision.family='spaces'
              AND revision.label_scope_kind='label_rule_v2'`,
    values: [activationId],
    readonly: false,
  });
  const reserved = yield* transaction.execute<Row>({
    label: "spaces-handle-claims.quote.reserved-labels.read",
    text: `SELECT platform_labels,namespace_labels
             FROM handle_reserved_label_revisions
            WHERE reserved_labels_id=$1 AND reserved_labels_revision=$2 AND family='spaces'`,
    values: [text(offering, "reserved_labels_id"), integer(offering, "reserved_labels_revision")],
    readonly: false,
  });
  const reservedRow = one(reserved.rows, "Spaces quote reserved labels");
  const classification = classifyEffectiveHandleOfferingV2({
    label: input.desiredLabel,
    platform_reserved_labels: new Set(stringArray(reservedRow.platform_labels)),
    namespace_reserved_labels: new Set(stringArray(reservedRow.namespace_labels)),
    active_offerings: candidates.rows.map((row) => ({
      offering_id: text(row, "offering_id"),
      label_scope: {
        kind: "label_rule_v2",
        label_grammar_id: "spaces_subspace_label_v1",
        reserved_labels_id: text(row, "reserved_labels_id"),
        reserved_labels_revision: integer(row, "reserved_labels_revision"),
        reserved_labels_hash: text(row, "reserved_labels_hash"),
        availability: {
          kind: "length_band_v1",
          min_label_length: integer(row, "min_label_length"),
          max_label_length: integer(row, "max_label_length"),
        },
      },
    })),
  });
  if (classification.kind === "handle_unavailable") return yield* reject("handle_unavailable");
  if (classification.kind === "not_offered") return yield* reject("not_offered");
  if (classification.offering.offering_id !== input.offeringId) {
    return yield* reject("offering_not_applicable", true, classification.offering.offering_id);
  }

  // §5.3.13.12 before §5.3.13.6: membership first, then the recipient. Both
  // refusals return before any write.
  const communityId = text(offering, "community_id");
  if (!(yield* activeMembership(transaction, { communityId, accountId: input.accountId }))) {
    return {
      kind: "eligibility_required",
      offering_id: input.offeringId,
      owner_persona_id: input.personaId,
      reason: "qualification_unsatisfied",
    } satisfies CreateHandleSpacesQuoteResultV1;
  }
  const recipient = yield* liveRecipient(transaction, {
    accountId: input.accountId,
    personaId: input.personaId,
    network: activationNetwork,
  });
  if (recipient === null) {
    return {
      kind: "recipient_wallet_required",
      offering_id: input.offeringId,
      owner_persona_id: input.personaId,
      reason: "recipient_wallet_required",
    } satisfies CreateHandleSpacesQuoteResultV1;
  }

  const counter = yield* accountCapCounter(transaction, {
    accountId: input.accountId,
    offeringId: input.offeringId,
  });
  if (!capAdmits(nullableInteger(offering, "max_active_grants_per_account"), counter)) {
    return yield* reject("account_grant_limit_reached");
  }
  const fence = yield* transaction.execute<Row>({
    label: "spaces-handle-claims.quote.key-fence.read",
    text: `SELECT fence.permanent_grant_id,fence.pending_claim_id,
                  fence.external_conflict_observation_id
             FROM handle_key_fences AS fence
            WHERE fence.family='spaces' AND fence.namespace_root=$1 AND fence.handle_label=$2`,
    values: [text(offering, "namespace_root"), input.desiredLabel],
    readonly: false,
  });
  if (fence.rows[0] !== undefined && keyOccupied(fence.rows[0])) {
    return yield* reject("handle_unavailable");
  }

  const now = yield* databaseNow(transaction);
  const linkageGeneration = integer(offering, "public_linkage_generation");
  const identityDigest = handlePersonaPublicIdentityHash({
    persona_id: input.personaId,
    public_linkage_generation: linkageGeneration,
  }).sha256;
  let confirmationId: string | null = null;
  let confirmationHash: string | null = null;
  if (linkageGeneration > 0) {
    const confirmation = yield* transaction.execute<Row>({
      label: "spaces-handle-claims.quote.link-confirmation.lock",
      text: `SELECT * FROM handle_persona_link_confirmations
              WHERE actor_account_id=$1 AND persona_id=$2 AND offering_id=$3
                AND target_community_id=$4 AND family='spaces' AND namespace_root=$5
                AND public_linkage_generation=$6
                AND persona_public_identity_digest=$7
                AND status='available' AND expires_at > $8::timestamptz
              ORDER BY confirmed_at DESC,confirmation_id DESC
              LIMIT 1 FOR UPDATE`,
      values: [
        input.accountId,
        input.personaId,
        input.offeringId,
        communityId,
        text(offering, "namespace_root"),
        linkageGeneration,
        identityDigest,
        now,
      ],
      readonly: false,
    });
    if (confirmation.rows[0] === undefined) {
      return yield* reject("public_linking_confirmation_required");
    }
    confirmationId = text(confirmation.rows[0], "confirmation_id");
    confirmationHash = text(confirmation.rows[0], "confirmation_hash");
  }

  const displayRoot = text(offering, "display_root");
  const quoteTtlSeconds = integer(offering, "quote_ttl_seconds");
  const pricing: HandleFreePricingV1 = {
    kind: "free_v1",
    pricing_id: text(offering, "pricing_id"),
    pricing_revision: integer(offering, "pricing_revision"),
    pricing_hash: text(offering, "pricing_hash"),
    atomic_amount: "0",
  };
  // The members-only decision reads Pirate's membership record only and
  // consumes no evidence (§5.3.13.12).
  const eligibility: HandleEligibilitySnapshotV1 = {
    decision: "passed",
    policy_revision: integer(offering, "qualification_policy_revision"),
    policy_hash: text(offering, "qualification_policy_hash"),
    evidence_use_ids: [],
    evaluated_at: now,
  };
  const quoteHash = handleSpacesQuoteV3Hash({
    quote_id: input.quoteId,
    offering_id: text(offering, "offering_id"),
    offering_revision: integer(offering, "offering_revision"),
    offering_hash: text(offering, "offering_hash"),
    sale_namespace_activation_id: activationId,
    sale_namespace_activation_generation: integer(offering, "sale_namespace_activation_generation"),
    fulfillment_kind: "spaces_native_v1",
    owner_persona_id: input.personaId,
    recipient,
    family: "spaces",
    namespace_root: text(offering, "namespace_root"),
    handle_label: input.desiredLabel,
    pricing,
    eligibility,
    quoted_at: now,
    expires_at: addSeconds(now, quoteTtlSeconds),
  }).sha256;
  yield* transaction.execute({
    label: "spaces-handle-claims.quote.insert",
    text: `INSERT INTO handle_quotes (
             quote_id,quote_hash,request_hash,actor_account_id,owner_persona_id,
             offering_id,offering_revision,offering_hash,sale_namespace_activation_id,
             sale_namespace_activation_generation,fulfillment_kind,family,namespace_root,
             display_root,handle_label,display_identifier,pricing_id,pricing_revision,
             pricing_hash,atomic_amount,eligibility_policy_revision,eligibility_policy_hash,
             evidence_use_ids,evaluated_at,public_link_confirmation_id,
             public_link_confirmation_hash,status,quoted_at,expires_at,
             recipient_kind,recipient_network,recipient_taproot_assignment_id,
             recipient_script_pubkey_hex
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'spaces_native_v1','spaces',$11,$12,$13,
             $14,$15,$16,$17,0,$18,$19,'{}'::text[],$20::timestamptz,$21,$22,'quoted',
             $20::timestamptz,$20::timestamptz + make_interval(secs=>$23),
             'persona_taproot_v1',$24,$25,$26
           )`,
    values: [
      input.quoteId,
      quoteHash,
      context.requestHash,
      input.accountId,
      input.personaId,
      text(offering, "offering_id"),
      integer(offering, "offering_revision"),
      text(offering, "offering_hash"),
      activationId,
      integer(offering, "sale_namespace_activation_generation"),
      text(offering, "namespace_root"),
      displayRoot,
      input.desiredLabel,
      // Ruling Q9: the protocol identity keeps the canonical root; display
      // uses the Unicode display root, as HNS does.
      `${input.desiredLabel}@${displayRoot}`,
      pricing.pricing_id,
      pricing.pricing_revision,
      pricing.pricing_hash,
      eligibility.policy_revision,
      eligibility.policy_hash,
      now,
      confirmationId,
      confirmationHash,
      quoteTtlSeconds,
      recipient.network,
      recipient.taproot_assignment_id,
      recipient.script_pubkey_hex,
    ],
    readonly: false,
  });
  if (confirmationId !== null) {
    yield* transaction.execute({
      label: "spaces-handle-claims.quote.link-confirmation.consume",
      text: `UPDATE handle_persona_link_confirmations
                SET status='consumed',consumed_at=$2::timestamptz,consumed_by_quote_id=$3
              WHERE confirmation_id=$1 AND status='available'`,
      values: [confirmationId, now, input.quoteId],
      readonly: false,
    });
  }
  yield* transaction.execute({
    label: "spaces-handle-claims.quote.action.insert",
    text: `INSERT INTO handle_quote_actions (
             action_id,actor_account_id,endpoint_template,idempotency_key,request_hash,
             result_kind,quote_id,offering_id,owner_persona_id,eligibility_reason,committed_at
           ) VALUES ($1,$2,$3,$4,$5,'quoted',$6,$7,$8,NULL,$9::timestamptz)`,
    values: [
      input.actionId,
      input.accountId,
      context.endpoint,
      input.idempotencyKey,
      context.requestHash,
      input.quoteId,
      input.offeringId,
      input.personaId,
      now,
    ],
    readonly: false,
  });
  const created = yield* transaction.execute<Row>({
    label: "spaces-handle-claims.quote.read-created",
    text: "SELECT * FROM handle_quotes WHERE quote_id=$1 AND family='spaces'",
    values: [input.quoteId],
    readonly: false,
  });
  return {
    kind: "quoted",
    quote: spacesQuoteFromRow(one(created.rows, "created Spaces quote")),
    replayed: false,
  } satisfies CreateHandleSpacesQuoteResultV1;
});

/** The offering's community and the activation network for a Spaces quote or reservation. */
const spacesOfferingContext = Effect.fn("spacesOfferingContext")(function* (
  transaction: ControlPlaneTransaction,
  input: Readonly<{ offeringId: string; offeringRevision: number }>,
) {
  const result = yield* transaction.execute<Row>({
    label: "spaces-handle-claims.offering-context.read",
    text: `SELECT revision.community_id,activation.spaces_network
             FROM community_handle_offering_revisions AS revision
             JOIN community_handle_sale_namespace_activation_revisions AS activation
               ON activation.sale_namespace_activation_id=revision.sale_namespace_activation_id
              AND activation.sale_namespace_activation_generation
                    =revision.sale_namespace_activation_generation
            WHERE revision.offering_id=$1 AND revision.offering_revision=$2
              AND revision.family='spaces' AND activation.family='spaces'`,
    values: [input.offeringId, input.offeringRevision],
    readonly: false,
  });
  const row = one(result.rows, "Spaces offering context");
  return { communityId: text(row, "community_id"), network: network(row, "spaces_network") };
});

/**
 * Reservation for a Spaces quote. The caller has checked the quote owner,
 * hash, expiry, current effective offering, and active persona. This rechecks
 * the account-scoped membership (§5.1.3) and the quote's exact recipient, then
 * fences the key.
 */
export const createSpacesReservation = Effect.fn("createSpacesReservation")(function* (
  transaction: ControlPlaneTransaction,
  context: Readonly<{
    input: ReservationInput;
    quote: Row;
    now: string;
    endpoint: "/handle-reservations";
    requestHash: string;
  }>,
) {
  const { input, quote, now } = context;
  requireSpacesRow(quote, "quote");
  const offeringId = text(quote, "offering_id");
  const offeringContext = yield* spacesOfferingContext(transaction, {
    offeringId,
    offeringRevision: integer(quote, "offering_revision"),
  });
  if (
    !(yield* activeMembership(transaction, {
      communityId: offeringContext.communityId,
      accountId: input.accountId,
    }))
  ) {
    return yield* reject("qualification_unsatisfied");
  }
  const recipient = spacesRecipientBindingFromRow(quote);
  if (
    !(yield* recipientStillLive(transaction, {
      accountId: input.accountId,
      personaId: input.personaId,
      network: offeringContext.network,
      recipient,
    }))
  ) {
    return yield* reject("persona_unavailable");
  }
  const counter = yield* accountCapCounter(transaction, {
    accountId: input.accountId,
    offeringId,
  });
  if (!capAdmits(nullableInteger(quote, "max_active_grants_per_account"), counter)) {
    return yield* reject("account_grant_limit_reached");
  }
  const namespaceRoot = text(quote, "namespace_root");
  const handleLabel = text(quote, "handle_label");
  yield* advisoryLock(
    transaction,
    KEY_LOCK_NAMESPACE,
    ["spaces", namespaceRoot, handleLabel],
    "spaces-handle-claims.reservation.key.lock",
  );
  const fence = yield* transaction.execute<Row>({
    label: "spaces-handle-claims.reservation.key-fence.read",
    text: `SELECT fence.*,reservation.status AS reservation_status,
                  reservation.expires_at AS reservation_expires_at
             FROM handle_key_fences AS fence
             LEFT JOIN handle_reservations AS reservation
               ON reservation.reservation_id=fence.live_reservation_id
            WHERE fence.family='spaces' AND fence.namespace_root=$1 AND fence.handle_label=$2
            FOR UPDATE OF fence`,
    values: [namespaceRoot, handleLabel],
    readonly: false,
  });
  const fenceRow = fence.rows[0];
  if (fenceRow !== undefined) {
    if (keyOccupied(fenceRow)) return yield* reject("handle_unavailable");
    if (
      fenceRow.live_reservation_id !== null &&
      text(fenceRow, "reservation_status") === "reserved" &&
      Date.parse(instant(fenceRow.reservation_expires_at)) > Date.parse(now)
    ) {
      return yield* reject("handle_unavailable");
    }
    if (fenceRow.live_reservation_id !== null) {
      yield* transaction.execute({
        label: "spaces-handle-claims.reservation.prior-expire",
        text: `UPDATE handle_reservations
                  SET status='expired',transitioned_at=$2::timestamptz
                WHERE reservation_id=$1 AND status='reserved'`,
        values: [text(fenceRow, "live_reservation_id"), now],
        readonly: false,
      });
    }
  }
  const reservationTtlSeconds = integer(quote, "reservation_ttl_seconds");
  const reservationHash = handleSpacesReservationV3Hash({
    reservation_id: input.reservationId,
    quote_id: input.quoteId,
    quote_hash: text(quote, "quote_hash"),
    offering_id: offeringId,
    offering_hash: text(quote, "offering_hash"),
    sale_namespace_activation_id: text(quote, "sale_namespace_activation_id"),
    sale_namespace_activation_generation: integer(quote, "sale_namespace_activation_generation"),
    fulfillment_kind: "spaces_native_v1",
    owner_persona_id: input.personaId,
    recipient,
    family: "spaces",
    namespace_root: namespaceRoot,
    handle_label: handleLabel,
    reserved_at: now,
    expires_at: addSeconds(now, reservationTtlSeconds),
  }).sha256;
  yield* transaction.execute({
    label: "spaces-handle-claims.reservation.insert",
    text: `INSERT INTO handle_reservations (
             reservation_id,reservation_hash,request_hash,actor_account_id,owner_persona_id,
             quote_id,quote_hash,offering_id,offering_hash,sale_namespace_activation_id,
             sale_namespace_activation_generation,fulfillment_kind,family,namespace_root,
             handle_label,status,reserved_at,expires_at,transitioned_at,nationality_decision_id,
             recipient_kind,recipient_network,recipient_taproot_assignment_id,
             recipient_script_pubkey_hex
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'spaces_native_v1','spaces',
                     $12,$13,'reserved',$14::timestamptz,
                     $14::timestamptz + make_interval(secs=>$15),NULL,NULL,
                     'persona_taproot_v1',$16,$17,$18)`,
    values: [
      input.reservationId,
      reservationHash,
      context.requestHash,
      input.accountId,
      input.personaId,
      input.quoteId,
      text(quote, "quote_hash"),
      offeringId,
      text(quote, "offering_hash"),
      text(quote, "sale_namespace_activation_id"),
      integer(quote, "sale_namespace_activation_generation"),
      namespaceRoot,
      handleLabel,
      now,
      reservationTtlSeconds,
      recipient.network,
      recipient.taproot_assignment_id,
      recipient.script_pubkey_hex,
    ],
    readonly: false,
  });
  yield* transaction.execute({
    label: "spaces-handle-claims.reservation.key-fence.write",
    text: `INSERT INTO handle_key_fences (
             family,namespace_root,handle_label,live_reservation_id,permanent_grant_id,
             pending_claim_id,external_conflict_observation_id,updated_at
           ) VALUES ('spaces',$1,$2,$3,NULL,NULL,NULL,$4::timestamptz)
           ON CONFLICT (family,namespace_root,handle_label) DO UPDATE SET
             live_reservation_id=EXCLUDED.live_reservation_id,
             updated_at=EXCLUDED.updated_at`,
    values: [namespaceRoot, handleLabel, input.reservationId, now],
    readonly: false,
  });
  yield* transaction.execute({
    label: "spaces-handle-claims.reservation.quote.consume",
    text: `UPDATE handle_quotes
              SET status='consumed',consumed_at=$2::timestamptz
            WHERE quote_id=$1 AND status='quoted'`,
    values: [input.quoteId, now],
    readonly: false,
  });
  yield* transaction.execute({
    label: "spaces-handle-claims.reservation.action.insert",
    text: `INSERT INTO handle_reservation_actions (
             action_id,actor_account_id,endpoint_template,idempotency_key,request_hash,
             reservation_id,committed_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz)`,
    values: [
      input.actionId,
      input.accountId,
      context.endpoint,
      input.idempotencyKey,
      context.requestHash,
      input.reservationId,
      now,
    ],
    readonly: false,
  });
  const created = yield* transaction.execute<Row>({
    label: "spaces-handle-claims.reservation.read-created",
    text: "SELECT * FROM handle_reservations WHERE reservation_id=$1 AND family='spaces'",
    values: [input.reservationId],
    readonly: false,
  });
  return {
    reservation: spacesReservationFromRow(one(created.rows, "created Spaces reservation")),
    replayed: false,
  };
});

/**
 * The atomic Spaces claim (§5.3.13.7). The caller has checked the reservation
 * owner, hash, and expiry. One transaction rechecks the current offering and
 * readiness, the exact community binding, current membership, and the
 * reservation's recipient; consumes the reservation; records one issuance
 * operation; writes the claim `issuance_pending` with a null grant; moves the
 * key fence to pending issuance; reserves the account-cap slot; and creates
 * the registry item and the verification schedule. It never creates a grant.
 */
export const submitSpacesClaim = Effect.fn("submitSpacesClaim")(function* (
  transaction: ControlPlaneTransaction,
  context: Readonly<{
    input: ClaimInput;
    reservation: Row;
    now: string;
    endpoint: "/handle-claims";
    requestHash: string;
  }>,
) {
  const { input, reservation, now } = context;
  requireSpacesRow(reservation, "reservation");
  const offeringId = text(reservation, "offering_id");
  const currentOffering = yield* transaction.execute<Row>({
    label: "spaces-handle-claims.claim.offering-current.read",
    text: `SELECT effective.spaces_network
             FROM community_handle_offering_current AS current_offering
             JOIN community_handle_offering_revisions AS revision
               ON revision.offering_id=current_offering.offering_id
              AND revision.offering_revision=current_offering.current_revision
             JOIN handle_issuance_driver_revisions AS driver
               ON driver.family=revision.family
              AND driver.driver_id=revision.issuance_driver_id
              AND driver.driver_version=revision.issuance_driver_version
             JOIN LATERAL effective_community_handle_sale_namespace_v1(
               revision.sale_namespace_activation_id,$3::timestamptz
             ) AS effective ON TRUE
            WHERE current_offering.offering_id=$1
              AND revision.offering_hash=$2 AND revision.status='active'
              AND revision.family='spaces'
              AND driver.fulfillment_kind='spaces_native_v1'
              AND driver.status<>'retired'
              AND effective.family='spaces'
            FOR SHARE OF current_offering`,
    values: [offeringId, text(reservation, "offering_hash"), now],
    readonly: false,
  });
  if (currentOffering.rows[0] === undefined) return yield* reject("sale_namespace_inactive", true);
  const activationNetwork = network(currentOffering.rows[0], "spaces_network");
  const communityId = text(reservation, "community_id");
  const persona = yield* transaction.execute<Row>({
    label: "spaces-handle-claims.claim.persona.read",
    text: `SELECT persona_id,
                  active_owned_community_persona($1,$2,$3) AS binding_eligible
             FROM personas
            WHERE account_id=$1 AND persona_id=$2 AND status='active' FOR SHARE`,
    values: [input.accountId, input.personaId, communityId],
    readonly: false,
  });
  if (persona.rows[0] === undefined || persona.rows[0]?.binding_eligible !== true) {
    return yield* reject("persona_unavailable");
  }
  // The decision made here is the qualification frozen for this claim; losing
  // membership afterwards never fails the claim or withdraws its registry item.
  if (!(yield* activeMembership(transaction, { communityId, accountId: input.accountId }))) {
    return yield* reject("qualification_unsatisfied");
  }
  const recipient = spacesRecipientBindingFromRow(reservation);
  if (
    !(yield* recipientStillLive(transaction, {
      accountId: input.accountId,
      personaId: input.personaId,
      network: activationNetwork,
      recipient,
    }))
  ) {
    return yield* reject("persona_unavailable");
  }
  const namespaceRoot = text(reservation, "namespace_root");
  const handleLabel = text(reservation, "handle_label");
  yield* advisoryLock(
    transaction,
    KEY_LOCK_NAMESPACE,
    ["spaces", namespaceRoot, handleLabel],
    "spaces-handle-claims.claim.key.lock",
  );
  yield* advisoryLock(
    transaction,
    CAP_LOCK_NAMESPACE,
    [input.accountId, offeringId],
    "spaces-handle-claims.claim.cap.lock",
  );
  const fence = yield* transaction.execute<Row>({
    label: "spaces-handle-claims.claim.key-fence.lock",
    text: `SELECT * FROM handle_key_fences
            WHERE family='spaces' AND namespace_root=$1 AND handle_label=$2
            FOR UPDATE`,
    values: [namespaceRoot, handleLabel],
    readonly: false,
  });
  const fenceRow = fence.rows[0];
  if (
    fenceRow === undefined ||
    keyOccupied(fenceRow) ||
    fenceRow.live_reservation_id !== input.reservationId
  ) {
    return yield* reject("handle_unavailable");
  }
  const counterRow = yield* transaction.execute<Row>({
    label: "spaces-handle-claims.claim.account-cap.lock",
    text: `INSERT INTO handle_account_offering_grant_counters (
             account_id,offering_id,active_grant_count,pending_issuance_count,updated_at
           ) VALUES ($1,$2,0,0,$3::timestamptz)
           ON CONFLICT (account_id,offering_id) DO UPDATE SET
             updated_at=handle_account_offering_grant_counters.updated_at
           RETURNING active_grant_count,pending_issuance_count`,
    values: [input.accountId, offeringId, now],
    readonly: false,
  });
  const counter = one(counterRow.rows, "Spaces grant counter");
  const submission = submitSpacesClaimV1({
    max_active_grants_per_account: nullableInteger(reservation, "max_active_grants_per_account"),
    counter: {
      active_grant_count: integer(counter, "active_grant_count"),
      pending_issuance_count: integer(counter, "pending_issuance_count"),
    },
  });
  if (submission.kind === "refused") return yield* reject("account_grant_limit_reached");

  const issuanceOperationId = handleIssuanceOperationIdV1({
    fulfillment_kind: "spaces_native_v1",
    claim_id: input.claimId,
  });
  // Grant-finalize v3 is computed at submission; the later final-evidence
  // reference is not a member of the hash (§5.3.13.6).
  const finalizeHash = handleSpacesGrantFinalizeV3Hash({
    claim_id: input.claimId,
    reservation_id: input.reservationId,
    reservation_hash: text(reservation, "reservation_hash"),
    offering_id: offeringId,
    offering_hash: text(reservation, "offering_hash"),
    sale_namespace_activation_id: text(reservation, "sale_namespace_activation_id"),
    sale_namespace_activation_generation: integer(
      reservation,
      "sale_namespace_activation_generation",
    ),
    fulfillment_kind: "spaces_native_v1",
    family: "spaces",
    namespace_root: namespaceRoot,
    handle_label: handleLabel,
    owner_persona_id: input.personaId,
    recipient,
    issuance_operation_id: issuanceOperationId,
    claim_request_hash: context.requestHash,
  }).sha256;
  yield* transaction.execute({
    label: "spaces-handle-claims.claim.insert-pending",
    text: `INSERT INTO handle_claims (
             claim_id,request_hash,actor_account_id,owner_persona_id,offering_id,
             offering_hash,quote_id,reservation_id,reservation_hash,
             sale_namespace_activation_id,sale_namespace_activation_generation,
             fulfillment_kind,family,namespace_root,handle_label,display_identifier,
             pricing_revision,pricing_hash,atomic_amount,payment_status,state,safe_reason,
             issuance_operation_id,grant_finalize_hash,grant_id,created_at,updated_at,
             nationality_decision_id,recipient_kind,recipient_network,
             recipient_taproot_assignment_id,recipient_script_pubkey_hex
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'spaces_native_v1','spaces',$12,$13,
             $14,$15,$16,0,'not_applicable',$17,'issuance_pending',$18,$19,NULL,
             $20::timestamptz,$20::timestamptz,NULL,'persona_taproot_v1',$21,$22,$23
           )`,
    values: [
      input.claimId,
      context.requestHash,
      input.accountId,
      input.personaId,
      offeringId,
      text(reservation, "offering_hash"),
      text(reservation, "quote_id"),
      input.reservationId,
      text(reservation, "reservation_hash"),
      text(reservation, "sale_namespace_activation_id"),
      integer(reservation, "sale_namespace_activation_generation"),
      namespaceRoot,
      handleLabel,
      text(reservation, "display_identifier"),
      integer(reservation, "pricing_revision"),
      text(reservation, "pricing_hash"),
      submission.state.claim,
      issuanceOperationId,
      finalizeHash,
      now,
      recipient.network,
      recipient.taproot_assignment_id,
      recipient.script_pubkey_hex,
    ],
    readonly: false,
  });
  yield* transaction.execute({
    label: "spaces-handle-claims.claim.reservation.consume",
    text: `UPDATE handle_reservations
              SET status='consumed',transitioned_at=$2::timestamptz
            WHERE reservation_id=$1 AND status='reserved'`,
    values: [input.reservationId, now],
    readonly: false,
  });
  const pendingFence = yield* transaction.execute({
    label: "spaces-handle-claims.claim.key-fence.pending",
    text: `UPDATE handle_key_fences
              SET live_reservation_id=NULL,pending_claim_id=$4,updated_at=$5::timestamptz
            WHERE family='spaces' AND namespace_root=$1 AND handle_label=$2
              AND live_reservation_id=$3`,
    values: [namespaceRoot, handleLabel, input.reservationId, input.claimId, now],
    readonly: false,
  });
  if (pendingFence.rowCount !== 1) throw new Error("Spaces key fence did not move to pending");
  const capReservation = yield* transaction.execute({
    label: "spaces-handle-claims.claim.cap.reserve",
    text: `UPDATE handle_account_offering_grant_counters
              SET pending_issuance_count=$3,updated_at=$4::timestamptz
            WHERE account_id=$1 AND offering_id=$2 AND pending_issuance_count=$5`,
    values: [
      input.accountId,
      offeringId,
      submission.counter.pending_issuance_count,
      now,
      integer(counter, "pending_issuance_count"),
    ],
    readonly: false,
  });
  if (capReservation.rowCount !== 1) throw new Error("Spaces account-cap slot was not reserved");
  yield* transaction.execute({
    label: "spaces-handle-claims.claim.registry-item.insert",
    text: `INSERT INTO spaces_registry_items (
             claim_id,issuance_operation_id,family,network,namespace_root,handle_label,
             handle,script_pubkey_hex,state,created_at,updated_at
           ) VALUES ($1,$2,'spaces',$3,$4,$5,$6,$7,$8,$9::timestamptz,$9::timestamptz)`,
    values: [
      input.claimId,
      issuanceOperationId,
      recipient.network,
      namespaceRoot,
      handleLabel,
      `${handleLabel}@${namespaceRoot}`,
      recipient.script_pubkey_hex,
      submission.state.item,
      now,
    ],
    readonly: false,
  });
  yield* transaction.execute({
    label: "spaces-handle-claims.claim.verification.insert",
    text: `INSERT INTO spaces_issuance_verifications (
             claim_id,issuance_operation_id,status,verification_due,next_verification_at,
             attempt_count,last_attempted_at,overdue_marked_at,created_at,updated_at
           ) VALUES ($1,$2,'pending',$3,$4::timestamptz,0,NULL,NULL,
                     $4::timestamptz,$4::timestamptz)`,
    values: [input.claimId, issuanceOperationId, submission.state.verification_due, now],
    readonly: false,
  });
  yield* transaction.execute({
    label: "spaces-handle-claims.claim.action.insert",
    text: `INSERT INTO handle_claim_actions (
             action_id,actor_account_id,endpoint_template,idempotency_key,request_hash,
             claim_id,committed_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz)`,
    values: [
      input.actionId,
      input.accountId,
      context.endpoint,
      input.idempotencyKey,
      context.requestHash,
      input.claimId,
      now,
    ],
    readonly: false,
  });
  const created = yield* readSpacesClaim(transaction, {
    claimId: input.claimId,
    accountId: input.accountId,
  });
  if (created === null) throw new Error("created Spaces claim is missing");
  return { claim: created, replayed: false };
});

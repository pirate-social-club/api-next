import { createHash } from "node:crypto";
import {
  ControlPlaneDb,
  HandleSalesPageRejected,
  type HandleSalesStore,
} from "@pirate/application";
import { HandleSpacesQuoteV1, SpacesMemberRequestReadbackPageV1 } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { instant, mapped, type Row, storage, text } from "./handle-sales-internals.ts";
import {
  spacesClaimFromRow,
  spacesQuoteFromRow,
  spacesReservationFromRow,
} from "./spaces-handle-claims.ts";

type Input = Parameters<HandleSalesStore["listSpacesMemberRequests"]>[0];
const BoundedIdentifier = HandleSpacesQuoteV1.fields.quote_id;
const Sha256Hex = HandleSpacesQuoteV1.fields.quote_hash;
const Micros = Schema.String.check(
  Schema.makeFilter((value) =>
    /^(?:0|[1-9][0-9]{0,18})$/u.test(value) && BigInt(value) <= 9223372036854775807n
      ? undefined
      : "Expected nonnegative int64 microseconds",
  ),
);
const Cursor = Schema.Struct({
  actor: BoundedIdentifier,
  scope: Sha256Hex,
  cutoff: Micros,
  after: Micros,
  phase: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
  id: BoundedIdentifier,
});
const decodeCursor = Schema.decodeUnknownSync(Cursor, { onExcessProperty: "error" });
const decodePage = Schema.decodeUnknownSync(SpacesMemberRequestReadbackPageV1, {
  onExcessProperty: "error",
});
const decodeRow = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

const paging = (input: Input) => {
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new HandleSalesPageRejected({ reason: "invalid_limit" });
  }
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        input.communityId ?? null,
        input.offeringId ?? null,
        input.namespaceRoot ?? null,
        input.network ?? null,
        limit,
      ]),
    )
    .digest("hex");
  if (input.cursor === undefined) return { limit, scope, cursor: null };
  if (input.cursor.length > 2048 || !/^smr1\.[A-Za-z0-9_-]+$/u.test(input.cursor)) {
    throw new HandleSalesPageRejected({ reason: "invalid_cursor" });
  }
  const encoded = input.cursor.slice(5);
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded)
    throw new HandleSalesPageRejected({ reason: "invalid_cursor" });
  const cursor = decodeCursor(JSON.parse(bytes.toString("utf8")));
  if (
    cursor.actor !== input.accountId ||
    cursor.scope !== scope ||
    BigInt(cursor.after) > BigInt(cursor.cutoff)
  ) {
    throw new HandleSalesPageRejected({ reason: "invalid_cursor" });
  }
  return { limit, scope, cursor };
};

// Each branch starts with the actor's retained action and scopes every private
// object join to the same actor. Historical activation/quote facts supply the
// context; no membership, current persona, offering head or admission is read.
const READBACK_SQL = `
WITH retained AS (
  SELECT a.action_id, a.endpoint_template, a.idempotency_key, a.request_hash, a.committed_at,
         1 AS phase, a.offering_id, a.owner_persona_id, NULL::text AS refusal_reason,
         to_jsonb(q) AS quote_data, NULL::jsonb AS progress_data
    FROM handle_quote_actions a
    JOIN handle_quotes q ON q.quote_id=a.quote_id AND q.actor_account_id=$1 AND q.family='spaces'
   WHERE a.actor_account_id=$1
  UNION ALL
  SELECT a.action_id, a.endpoint_template, a.idempotency_key, a.request_hash, a.committed_at,
         2, r.offering_id, r.owner_persona_id, NULL::text, to_jsonb(q), to_jsonb(r)
    FROM handle_reservation_actions a
    JOIN handle_reservations r ON r.reservation_id=a.reservation_id AND r.actor_account_id=$1 AND r.family='spaces'
    JOIN handle_quotes q ON q.quote_id=r.quote_id AND q.actor_account_id=$1 AND q.family='spaces'
   WHERE a.actor_account_id=$1
  UNION ALL
  SELECT a.action_id, a.endpoint_template, a.idempotency_key, a.request_hash, a.committed_at,
         3, c.offering_id, c.owner_persona_id, NULL::text, to_jsonb(q),
         to_jsonb(c) || jsonb_build_object(
           'grant_grant_id', g.grant_id, 'grant_grant_generation', g.grant_generation,
           'grant_community_id', g.community_id, 'grant_offering_id', g.offering_id,
           'grant_offering_hash', g.offering_hash, 'grant_claim_id', g.claim_id,
           'grant_owner_persona_id', g.owner_persona_id,
           'grant_sale_namespace_activation_id', g.sale_namespace_activation_id,
           'grant_sale_namespace_activation_generation', g.sale_namespace_activation_generation,
           'grant_namespace_root', g.namespace_root, 'grant_handle_label', g.handle_label,
           'grant_display_identifier', g.display_identifier, 'grant_status', g.status,
           'grant_issued_at', g.issued_at,
           'commits_paused', (SELECT f.funding_status='commits_paused_insufficient_funds_v1'
             FROM spaces_operator_assignment_current assignment
             JOIN spaces_operator_funding_observations f
               ON f.operator_assignment_id=assignment.operator_assignment_id
              AND f.operator_assignment_generation=assignment.current_generation
            WHERE assignment.network=c.recipient_network AND assignment.canonical_root=c.namespace_root
              AND assignment.status='active' ORDER BY f.observation_generation DESC LIMIT 1),
           'past_overdue_alert', verification.overdue_marked_at IS NOT NULL)
    FROM handle_claim_actions a
    JOIN handle_claims c ON c.claim_id=a.claim_id AND c.actor_account_id=$1 AND c.family='spaces'
    JOIN handle_quotes q ON q.quote_id=c.quote_id AND q.actor_account_id=$1 AND q.family='spaces'
    LEFT JOIN handle_grants g ON g.grant_id=c.grant_id AND g.claim_id=c.claim_id
      AND g.owner_persona_id=c.owner_persona_id
    LEFT JOIN spaces_issuance_verifications verification ON verification.claim_id=c.claim_id
   WHERE a.actor_account_id=$1
  UNION ALL
  SELECT a.action_id, a.endpoint_template, a.idempotency_key, a.request_hash, a.committed_at,
         4, a.offering_id, a.owner_persona_id, a.eligibility_reason, NULL::jsonb, NULL::jsonb
    FROM handle_quote_actions a
   WHERE a.actor_account_id=$1 AND a.quote_id IS NULL AND a.result_kind='eligibility_required'
     AND EXISTS (SELECT 1 FROM community_handle_offering_revisions revision
       WHERE revision.offering_id=a.offering_id AND revision.family='spaces')
), scoped AS (
  SELECT retained.*, activation.community_id,
         (extract(epoch FROM retained.committed_at)*1000000)::bigint AS committed_micros
    FROM retained
    LEFT JOIN community_handle_sale_namespace_activation_revisions activation
      ON activation.sale_namespace_activation_id=quote_data->>'sale_namespace_activation_id'
     AND activation.sale_namespace_activation_generation=(quote_data->>'sale_namespace_activation_generation')::bigint
     AND activation.family='spaces'
   WHERE ($2::text IS NULL OR activation.community_id=$2)
     AND ($3::text IS NULL OR retained.offering_id=$3)
     AND ($4::text IS NULL OR quote_data->>'namespace_root'=$4)
     AND ($5::text IS NULL OR quote_data->>'recipient_network'=$5)
), bound AS (
  SELECT COALESCE($6::bigint, (extract(epoch FROM statement_timestamp())*1000000)::bigint) AS cutoff
)
SELECT scoped.*, bound.cutoff::text AS cutoff_micros, committed_micros::text AS order_micros
  FROM scoped CROSS JOIN bound
 WHERE committed_micros <= bound.cutoff
   AND ($7::bigint IS NULL OR (committed_micros, phase, action_id COLLATE "C") > ($7::bigint, $8::integer, $9::text COLLATE "C"))
 ORDER BY committed_micros, phase, action_id COLLATE "C"
 LIMIT $10`;

const itemFromRow = (row: Row) => {
  const action = {
    action_id: row.action_id,
    endpoint_template: row.endpoint_template,
    idempotency_key: row.idempotency_key,
    request_hash: row.request_hash,
    committed_at: instant(row.committed_at),
  };
  if (row.phase === 4)
    return {
      kind: "quote_refusal",
      action,
      offering_id: row.offering_id,
      owner_persona_id: row.owner_persona_id,
      immutable_context: "not_recorded",
      result_kind: "eligibility_required",
      reason: row.refusal_reason,
    };
  const quote = spacesQuoteFromRow(decodeRow(row.quote_data));
  const context = {
    community_id: row.community_id,
    offering_id: quote.offering_id,
    offering_revision: quote.offering_revision,
    offering_hash: quote.offering_hash,
    sale_namespace_activation_id: quote.sale_namespace_activation_id,
    sale_namespace_activation_generation: quote.sale_namespace_activation_generation,
    owner_persona_id: quote.owner_persona_id,
    network: quote.recipient.network,
    namespace_root: quote.handle.namespace_root,
  };
  switch (row.phase) {
    case 1:
      return { kind: "quote", action, context, quote };
    case 2:
      return {
        kind: "reservation",
        action,
        context,
        reservation: spacesReservationFromRow(decodeRow(row.progress_data)),
      };
    case 3:
      return {
        kind: "claim",
        action,
        context,
        claim: spacesClaimFromRow(decodeRow(row.progress_data)),
      };
    default:
      throw new Error("invalid Spaces retained phase");
  }
};

export const listSpacesMemberRequests = Effect.fn("listSpacesMemberRequests")(function* (
  input: Input,
) {
  const parsed = yield* Effect.try({
    try: () => paging(input),
    catch: (error) =>
      error instanceof HandleSalesPageRejected
        ? error
        : new HandleSalesPageRejected({ reason: "invalid_cursor" }),
  });
  const db = yield* ControlPlaneDb;
  const result = yield* mapped(
    db.execute<Row>({
      label: "spaces-member-recovery.retained-requests.read-owner",
      text: READBACK_SQL,
      readonly: true,
      values: [
        input.accountId,
        input.communityId ?? null,
        input.offeringId ?? null,
        input.namespaceRoot ?? null,
        input.network ?? null,
        parsed.cursor?.cutoff ?? null,
        parsed.cursor?.after ?? null,
        parsed.cursor?.phase ?? null,
        parsed.cursor?.id ?? null,
        parsed.limit + 1,
      ],
    }),
  );
  return yield* Effect.try({
    try: () => {
      const rows = result.rows.slice(0, parsed.limit);
      const last = rows.at(-1);
      const next =
        result.rows.length > parsed.limit && last !== undefined
          ? {
              actor: input.accountId,
              scope: parsed.scope,
              cutoff: text(last, "cutoff_micros"),
              after: text(last, "order_micros"),
              phase: last.phase,
              id: last.action_id,
            }
          : null;
      return decodePage({
        object: "spaces_member_request_readback_v1",
        coverage: "retained_committed_actions_with_stored_scope",
        scope_incomplete_actions: "omitted_when_scope_unprovable",
        unlocated_request_outcome: "unknown",
        new_submission_admission: "not_established_by_readback",
        items: rows.map(itemFromRow),
        next_cursor:
          next === null
            ? null
            : `smr1.${Buffer.from(JSON.stringify(decodeCursor(next))).toString("base64url")}`,
      });
    },
    catch: () => storage("invalid-row"),
  });
});

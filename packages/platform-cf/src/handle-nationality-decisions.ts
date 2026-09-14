import type { ControlPlaneTransaction } from "@pirate/application";
import {
  type HandleNationalityQualificationRecheckInputV1,
  handleNationalityQualificationRefFromPolicy,
  nationalityProviderBindingHash,
  recheckHandleNationalityQualification,
} from "@pirate/domain";
import { Effect } from "effect";
import {
  GatesV2CommunityDataInvalid,
  loadCuratedNationalityEvaluation,
} from "./gates-v2-community.ts";
import { handleNationalityPolicyFromRow } from "./handle-qualification-policy.ts";
import { instant, integer, one, type Row, storage, text } from "./handle-sales-internals.ts";

type Pin = HandleNationalityQualificationRecheckInputV1["pin"];

/** The caller owns offering, quote/reservation and idempotency locks. This
 * decision owns no membership and never imports the community's Palm policy.
 */
export const evaluateHandleNationality = Effect.fn("evaluateHandleNationality")(function* (
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    actorId: string;
    purpose: "quote" | "reservation" | "claim";
    resourceId: string;
    offering: Row;
    pin?: Pin;
  }>,
) {
  const policy = yield* Effect.try({
    try: () => handleNationalityPolicyFromRow(input.offering),
    catch: () => storage("constraint"),
  });
  const qualification = handleNationalityQualificationRefFromPolicy(
    text(input.offering, "policy_id"),
    policy,
  );
  const evaluation = yield* loadCuratedNationalityEvaluation(transaction, {
    userId: input.actorId,
    policy,
    lockEvidence: true,
    ...(input.pin === undefined ? {} : { providerId: input.pin.eligibility.selected_provider_id }),
  }).pipe(
    Effect.mapError((error) =>
      error instanceof GatesV2CommunityDataInvalid ? storage("unavailable") : error,
    ),
  );
  const clock = yield* transaction.execute<Row>({
    label: "handle-nationality.decision.clock",
    text: "SELECT clock_timestamp() AS evaluated_at",
    values: [],
    readonly: true,
  });
  const evaluatedAt = instant(one(clock.rows, "nationality decision clock").evaluated_at);
  const decisionId = `handle-nationality-decision_${crypto.randomUUID()}`;
  const evidence =
    evaluation.outcome === "pass"
      ? yield* transaction.execute<Row>({
          label: "handle-nationality.decision.witness",
          text: `SELECT a.assertion_id,r.evidence_receipt_id,r.provider_id,r.subject_key_id,
                    r.subject_binding_event_id,r.subject_binding_epoch
               FROM assertions a JOIN evidence_receipts r ON r.evidence_receipt_id=a.evidence_receipt_id
              WHERE a.assertion_id=ANY($1::text[]) AND r.evidence_receipt_id=ANY($2::text[])
                AND a.user_id=$3 AND r.user_id=$3`,
          values: [
            evaluation.winning_witness[0].assertion_ids,
            evaluation.winning_witness[0].evidence_receipt_ids,
            input.actorId,
          ],
          readonly: true,
        })
      : null;
  const receipt = evidence === null ? null : one(evidence.rows, "nationality decision witness");
  const binding =
    receipt === null
      ? null
      : policy.provider_bindings.find((value) => value.provider_id === receipt.provider_id);
  if (receipt !== null && binding === undefined)
    throw new Error("Nationality witness binding unavailable");
  const bindingHash = binding == null ? null : nationalityProviderBindingHash(binding);
  const recheck =
    input.pin === undefined
      ? null
      : recheckHandleNationalityQualification({
          pin: input.pin,
          current: {
            offering_revision: integer(input.offering, "offering_revision"),
            offering_hash: text(input.offering, "offering_hash"),
            qualification,
          },
          evaluation,
          winning_provider_binding_hash: bindingHash,
        });
  const qualified =
    evaluation.outcome === "pass" && (recheck === null || recheck.kind === "qualified");
  const reason =
    recheck?.kind === "rejected"
      ? recheck.reason
      : evaluation.outcome === "pass"
        ? null
        : evaluation.reason;
  yield* transaction.execute({
    label: "handle-nationality.decision.insert",
    text: `INSERT INTO handle_nationality_decisions
        (decision_id,actor_account_id,purpose,resource_id,offering_id,offering_revision,offering_hash,
         qualification_policy_id,qualification_policy_revision,qualification_policy_hash,requirement_hash,
         outcome,reason,selected_provider_id,selected_provider_binding_hash,evaluated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::timestamptz)`,
    values: [
      decisionId,
      input.actorId,
      input.purpose,
      input.resourceId,
      text(input.offering, "offering_id"),
      integer(input.offering, "offering_revision"),
      text(input.offering, "offering_hash"),
      qualification.policy_id,
      qualification.policy_revision,
      qualification.policy_hash,
      qualification.requirement_hash,
      qualified ? "pass" : evaluation.outcome === "pass" ? "needs_evidence" : evaluation.outcome,
      reason,
      qualified ? binding?.provider_id : null,
      qualified ? bindingHash : null,
      evaluatedAt,
    ],
    readonly: false,
  });
  if (!qualified || receipt === null || binding == null || bindingHash === null) {
    return { kind: "unqualified" as const, decisionId, reason };
  }
  const useId = `handle-nationality-use_${crypto.randomUUID()}`;
  yield* transaction.execute({
    label: "handle-nationality.evidence-use.insert",
    text: `INSERT INTO handle_nationality_evidence_uses
        (evidence_use_id,decision_id,actor_account_id,assertion_id,evidence_receipt_id,
         subject_key_id,subject_binding_event_id,subject_binding_epoch)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    values: [
      useId,
      decisionId,
      input.actorId,
      text(receipt, "assertion_id"),
      text(receipt, "evidence_receipt_id"),
      text(receipt, "subject_key_id"),
      text(receipt, "subject_binding_event_id"),
      integer(receipt, "subject_binding_epoch"),
    ],
    readonly: false,
  });
  const pin: Pin = {
    offering_revision: integer(input.offering, "offering_revision"),
    offering_hash: text(input.offering, "offering_hash"),
    qualification,
    eligibility: {
      decision: "passed",
      policy_revision: qualification.policy_revision,
      policy_hash: qualification.policy_hash,
      requirement_hash: qualification.requirement_hash,
      selected_provider_id: binding.provider_id,
      selected_provider_binding_hash: bindingHash,
      accepted_provider_ids: ["self.pass", "zkpassport"],
      lifetime: qualification.lifetime,
      evidence_use_ids: [useId],
      evaluated_at: evaluatedAt,
    },
  };
  return { kind: "qualified" as const, decisionId, pin };
});

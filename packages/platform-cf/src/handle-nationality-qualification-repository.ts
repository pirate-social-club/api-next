import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import type { HandleNationalityQualificationStore } from "@pirate/application/use-cases/handles/sales";
import {
  type VerificationIntentResolver,
  VerificationProviderPlanInput,
  VerificationStartStorageFailed,
} from "@pirate/application/verification";
import { type NationalityPolicy, nationalityProviderBindingHash } from "@pirate/domain";
import { Effect, type Layer, Option, Schema } from "effect";
import {
  GatesV2CommunityDataInvalid,
  loadCuratedNationalityEvaluation,
} from "./gates-v2-community.ts";
import { handleNationalityPolicyFromRow } from "./handle-qualification-policy.ts";
import { integer, mapped, type Row, reject, storage, text } from "./handle-sales-internals.ts";
import {
  NationalityCeremonyDataInvalid,
  resolveOrIssueNationalityCeremony,
} from "./nationality-ceremony-store.ts";

const policyFrom = (row: Row) =>
  Effect.try({
    try: () => handleNationalityPolicyFromRow(row),
    catch: () => storage("constraint"),
  });
const loadContext = (transaction: ControlPlaneTransaction, accountId: string, intentId: string) =>
  transaction.execute<Row>({
    label: "handle-nationality.qualification.context",
    text: `SELECT intent.*,policy.policy_id,policy.policy_revision,policy.policy_hash,policy.policy_kind,policy.nationality_policy
 FROM handle_nationality_qualification_intents intent
 JOIN community_handle_offering_current current_offering ON current_offering.offering_id=intent.offering_id AND current_offering.current_revision=intent.offering_revision
 JOIN community_handle_offering_revisions offering ON offering.offering_id=intent.offering_id AND offering.offering_revision=intent.offering_revision AND offering.offering_hash=intent.offering_hash
 JOIN handle_qualification_policy_revisions policy ON policy.policy_id=offering.qualification_policy_id AND policy.policy_revision=offering.qualification_policy_revision
 JOIN personas persona ON persona.persona_id=intent.owner_persona_id AND persona.account_id=intent.actor_account_id AND persona.status='active'
 WHERE intent.qualification_intent_id=$1 AND intent.actor_account_id=$2 AND intent.expires_at>clock_timestamp() AND offering.status='active'
 AND EXISTS (SELECT 1 FROM effective_community_handle_sale_namespace_v1(offering.sale_namespace_activation_id,clock_timestamp()))
 FOR SHARE OF intent,current_offering,persona`,
    values: [intentId, accountId],
    readonly: false,
  });

const reserve = (
  transaction: ControlPlaneTransaction,
  context: Row,
  policy: NationalityPolicy,
  providerId: string,
) =>
  Effect.gen(function* () {
    const binding = policy.provider_bindings.find((value) => value.provider_id === providerId);
    if (!binding) return yield* reject("qualification_unsatisfied");
    const bindingHash = nationalityProviderBindingHash(binding);
    return yield* resolveOrIssueNationalityCeremony(transaction, {
      actionKind: "handle_claim",
      intentId: text(context, "qualification_intent_id"),
      actorId: text(context, "actor_account_id"),
      requirementHash: policy.requirement_hash,
      acceptedProviderIds: ["self.pass", "zkpassport"],
      selectedProviderId: providerId,
      selectedBinding: {
        bindingHash,
        configurationKind: binding.provider_configuration.kind,
        configurationRef: binding.provider_configuration.reference,
        configurationVersion: binding.provider_configuration.version,
      },
      reservationRequest: {
        action_kind: "handle_claim",
        intent_id: text(context, "qualification_intent_id"),
        actor_id: text(context, "actor_account_id"),
        offering_id: text(context, "offering_id"),
        offering_revision: integer(context, "offering_revision"),
        offering_hash: text(context, "offering_hash"),
        requirement_hash: policy.requirement_hash,
        provider_id: providerId,
        provider_binding_hash: bindingHash,
      },
      ttlSeconds: 3600,
    }).pipe(
      Effect.mapError((error) =>
        error instanceof NationalityCeremonyDataInvalid ? storage("constraint") : error,
      ),
    );
  });

export const issueHandleNationalityQualification = Effect.fn("issueHandleNationalityQualification")(
  function* (
    transaction: ControlPlaneTransaction,
    input: Readonly<{
      accountId: string;
      personaId: string;
      intentId: string;
      offering: Row;
      desiredLabel: string;
    }>,
  ) {
    const result = yield* transaction.execute<Row>({
      label: "handle-nationality.qualification.insert",
      text: `INSERT INTO handle_nationality_qualification_intents (qualification_intent_id,actor_account_id,owner_persona_id,offering_id,offering_revision,offering_hash,handle_label,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '1 hour') RETURNING *`,
      values: [
        input.intentId,
        input.accountId,
        input.personaId,
        text(input.offering, "offering_id"),
        integer(input.offering, "offering_revision"),
        text(input.offering, "offering_hash"),
        input.desiredLabel,
      ],
      readonly: false,
    });
    const context = result.rows[0];
    if (!context) return yield* storage("constraint");
    const policy = yield* policyFrom(input.offering);
    yield* reserve(transaction, context, policy, policy.provider_bindings[0].provider_id);
    return input.intentId;
  },
);

export function makeControlPlaneHandleNationalityQualificationStore(
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): HandleNationalityQualificationStore {
  return {
    getProgress: (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* mapped(
            db.withTransaction((transaction) =>
              Effect.gen(function* () {
                const result = yield* loadContext(transaction, input.accountId, input.intentId);
                const context = result.rows[0];
                if (!context) return yield* reject("quote_expired");
                const policy = yield* policyFrom(context);
                const evaluation = yield* loadCuratedNationalityEvaluation(transaction, {
                  userId: input.accountId,
                  policy,
                }).pipe(
                  Effect.mapError((error) =>
                    error instanceof GatesV2CommunityDataInvalid ? storage("unavailable") : error,
                  ),
                );
                const base = {
                  kind: "handle_nationality_progress_v1" as const,
                  qualification_intent_id: input.intentId,
                  offering_id: text(context, "offering_id"),
                  requirement_hash: policy.requirement_hash,
                  accepted_provider_ids: ["self.pass", "zkpassport"] as const,
                };
                if (evaluation.outcome === "pass")
                  return {
                    ...base,
                    status: "qualified" as const,
                    next_action: { kind: "request_new_quote" as const },
                  };
                const states = yield* transaction.execute<Row>({
                  label: "handle-nationality.qualification.state",
                  text: `SELECT status,current_provider_id FROM nationality_requirement_states WHERE action_kind='handle_claim' AND intent_id=$1 AND actor_id=$2 AND requirement_kind='nationality' FOR UPDATE`,
                  values: [input.intentId, input.accountId],
                  readonly: false,
                });
                const state = states.rows[0];
                if (state?.status === "satisfied") return yield* reject("evidence_required");
                const provider =
                  state?.current_provider_id ?? policy.provider_bindings[0].provider_id;
                if (provider !== "self.pass" && provider !== "zkpassport")
                  return yield* storage("constraint");
                const action = yield* reserve(transaction, context, policy, provider);
                return {
                  ...base,
                  status: "verification_required" as const,
                  next_action: {
                    kind: "start_verification" as const,
                    provider_id: provider as "self.pass" | "zkpassport",
                    intent_id: action.ceremonyIntentId,
                    generation: action.generation,
                    requirement: "nationality" as const,
                  },
                };
              }),
            ),
          );
        }),
      ).pipe(Effect.provide(layer), mapped),
  };
}

export function makeControlPlaneHandleNationalityIntentResolver(
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): VerificationIntentResolver {
  return {
    resolve: (input) => {
      if (
        !("intent_id" in input) ||
        !(["self.pass", "zkpassport"] as readonly string[]).includes(input.provider_id)
      )
        return Effect.succeed(null);
      return Effect.scoped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const attempts = yield* transaction.execute<Row>({
                label: "handle-nationality.resolve.attempt",
                text: `SELECT attempt.*,state.status AS state_status,state.generation AS current_generation,state.current_ceremony_intent_id FROM nationality_ceremony_attempts attempt JOIN nationality_requirement_states state ON state.action_kind=attempt.action_kind AND state.intent_id=attempt.intent_id AND state.requirement_kind=attempt.requirement_kind WHERE attempt.ceremony_intent_id=$1 AND attempt.actor_id=$2 AND attempt.action_kind='handle_claim' AND attempt.expires_at>clock_timestamp()`,
                values: [input.intent_id, input.actor_id],
                readonly: true,
              });
              const attempt = attempts.rows[0];
              if (
                !attempt ||
                attempt.state_status !== "pending" ||
                attempt.current_ceremony_intent_id !== input.intent_id ||
                integer(attempt, "generation") !== integer(attempt, "current_generation")
              )
                return null;
              const contextResult = yield* loadContext(
                transaction,
                input.actor_id,
                text(attempt, "intent_id"),
              );
              const context = contextResult.rows[0];
              if (!context) return null;
              const current = yield* transaction.execute<Row>({
                label: "handle-nationality.resolve.current-state",
                text: `SELECT status,generation,current_ceremony_intent_id FROM nationality_requirement_states WHERE action_kind='handle_claim' AND intent_id=$1 AND actor_id=$2 AND requirement_kind='nationality' FOR UPDATE`,
                values: [text(attempt, "intent_id"), input.actor_id],
                readonly: false,
              });
              const state = current.rows[0];
              if (
                !state ||
                state.status !== "pending" ||
                state.current_ceremony_intent_id !== input.intent_id ||
                integer(state, "generation") !== integer(attempt, "generation")
              )
                return null;
              const policy = yield* policyFrom(context);
              if (policy.requirement_hash !== attempt.requirement_hash) return null;
              const original = policy.provider_bindings.find(
                (value) => value.provider_id === attempt.provider_id,
              );
              const selected = policy.provider_bindings.find(
                (value) => value.provider_id === input.provider_id,
              );
              if (
                !original ||
                !selected ||
                nationalityProviderBindingHash(original) !== attempt.provider_binding_hash
              )
                return null;
              const action = yield* reserve(transaction, context, policy, input.provider_id);
              const plan = Schema.decodeUnknownOption(VerificationProviderPlanInput)({
                method: selected.method,
                scope: selected.scope,
                requested_requirements: [policy.requirement],
                requested_claim_ids: ["nationality.allowed"],
                subject_binding_intent: "establish",
                protocol_version: selected.protocol_version,
                environment: selected.environment,
                verification_purpose: {
                  intent: "qualifier_disclosure",
                  policy_id: policy.policy_version_id,
                },
              });
              return Option.isSome(plan)
                ? { ...plan.value, resolved_intent_id: action.ceremonyIntentId }
                : null;
            }),
          );
        }),
      ).pipe(
        Effect.provide(layer),
        Effect.mapError(() => new VerificationStartStorageFailed()),
      );
    },
  };
}

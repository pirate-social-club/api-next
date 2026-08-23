import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneResult,
  type ControlPlaneStatement,
} from "@pirate/application";
import {
  type VerificationIntentResolver,
  VerificationStartStorageFailed,
} from "@pirate/application/use-cases/verification-start";
import { VerificationProviderPlanInput } from "@pirate/application/verification";
import {
  communityCreationCeremonyReservationHash,
  communityCreationProviderBindingHash,
  HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
  VERY_WEB_CONFIGURATION_REFERENCE,
  VERY_WEB_CONFIGURATION_VERSION,
  VERY_WEB_ISSUER,
  VERY_WEB_METHOD,
  VERY_WEB_PROTOCOL_VERSION,
  VERY_WEB_PROVIDER_ID,
  VERY_WEB_RP_SCOPE,
} from "@pirate/domain";
import { Effect, type Layer, Option, Schema } from "effect";

type IntentRow = Readonly<{
  readonly intent_id: unknown;
  readonly actor_id: unknown;
  readonly revision: unknown;
  readonly status: unknown;
  readonly creation_contract_version: unknown;
  readonly requirement_kind: unknown;
  readonly requirement_status: unknown;
  readonly requirement_hash: unknown;
  readonly provider_id: unknown;
  readonly provider_binding_hash: unknown;
  readonly provider_configuration_kind: unknown;
  readonly provider_configuration_ref: unknown;
  readonly provider_configuration_version: unknown;
  readonly generation: unknown;
  readonly current_ceremony_intent_id: unknown;
  readonly route_family: unknown;
  readonly route_root_label: unknown;
  readonly route_root_label_display: unknown;
  readonly route_path_segment: unknown;
  readonly ceremony_intent_id: unknown;
  readonly ceremony_requirement_kind: unknown;
  readonly ceremony_generation: unknown;
  readonly ceremony_requirement_hash: unknown;
  readonly ceremony_provider_id: unknown;
  readonly ceremony_provider_binding_hash: unknown;
  readonly ceremony_provider_configuration_kind: unknown;
  readonly ceremony_provider_configuration_ref: unknown;
  readonly ceremony_provider_configuration_version: unknown;
  readonly ceremony_route_family: unknown;
  readonly ceremony_route_root_label: unknown;
  readonly ceremony_route_root_label_display: unknown;
  readonly ceremony_route_path_segment: unknown;
  readonly reservation_request_hash: unknown;
  readonly intent_active: unknown;
  readonly ceremony_active: unknown;
}>;

const CANONICAL_REQUIREMENTS = [
  { claim_id: "credential.subject_unique" },
  { claim_id: "human.personhood" },
] as const;

const CANONICAL_CLAIM_IDS = ["credential.subject_unique", "human.personhood"] as const;

function storageFailure(): VerificationStartStorageFailed {
  return new VerificationStartStorageFailed();
}

function validEnvironment(value: string): boolean {
  return value.length > 0 && value.trim() === value && !value.includes("\u0000");
}

function oneRow<Row>(result: ControlPlaneResult<Row>): Row | null | undefined {
  if (result.rows.length > 1) return undefined;
  return result.rows[0] ?? null;
}

function exactIntentBinding(
  row: IntentRow,
  input: Readonly<{
    readonly actor_id: string;
    readonly provider_id: string;
    readonly creation_intent_id: string;
    readonly ceremony_intent_id: string;
    readonly requirement: "human_identity";
    readonly generation: number;
    readonly expected_revision: number;
  }>,
): boolean {
  const providerBindingHash = communityCreationProviderBindingHash({
    requirement: "human_identity",
    family: null,
    provider_id: VERY_WEB_PROVIDER_ID,
    provider_configuration: {
      kind: "dynamic",
      reference: VERY_WEB_CONFIGURATION_REFERENCE,
      version: VERY_WEB_CONFIGURATION_VERSION,
    },
    protocol_version: VERY_WEB_PROTOCOL_VERSION,
  });
  const reservationHash = communityCreationCeremonyReservationHash({
    actor_id: input.actor_id,
    creation_intent_id: input.creation_intent_id,
    ceremony_intent_id: input.ceremony_intent_id,
    requirement: "human_identity",
    generation: input.generation,
    requirement_hash: HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
    provider_id: VERY_WEB_PROVIDER_ID,
    provider_binding_hash: providerBindingHash,
    route: null,
  });
  return (
    row.intent_id === input.creation_intent_id &&
    row.actor_id === input.actor_id &&
    Number(row.revision) === input.expected_revision &&
    row.status === "verification_required" &&
    (row.creation_contract_version === "route_v1" ||
      row.creation_contract_version === "optional_route_v2") &&
    row.requirement_kind === "human_identity" &&
    row.requirement_status === "pending" &&
    row.requirement_hash === HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH &&
    row.provider_id === VERY_WEB_PROVIDER_ID &&
    row.provider_id === input.provider_id &&
    row.provider_binding_hash === providerBindingHash &&
    row.provider_configuration_kind === "dynamic" &&
    row.provider_configuration_ref === VERY_WEB_CONFIGURATION_REFERENCE &&
    row.provider_configuration_version === VERY_WEB_CONFIGURATION_VERSION &&
    Number(row.generation) === input.generation &&
    row.current_ceremony_intent_id === input.ceremony_intent_id &&
    row.route_family === null &&
    row.route_root_label === null &&
    row.route_root_label_display === null &&
    row.route_path_segment === null &&
    row.ceremony_intent_id === input.ceremony_intent_id &&
    row.ceremony_requirement_kind === "human_identity" &&
    Number(row.ceremony_generation) === input.generation &&
    row.ceremony_requirement_hash === HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH &&
    row.ceremony_provider_id === VERY_WEB_PROVIDER_ID &&
    row.ceremony_provider_binding_hash === providerBindingHash &&
    row.ceremony_provider_configuration_kind === "dynamic" &&
    row.ceremony_provider_configuration_ref === VERY_WEB_CONFIGURATION_REFERENCE &&
    row.ceremony_provider_configuration_version === VERY_WEB_CONFIGURATION_VERSION &&
    row.ceremony_route_family === null &&
    row.ceremony_route_root_label === null &&
    row.ceremony_route_root_label_display === null &&
    row.ceremony_route_path_segment === null &&
    row.reservation_request_hash === reservationHash &&
    row.intent_active === true &&
    row.ceremony_active === true
  );
}

function plan(environment: string): unknown {
  return {
    method: VERY_WEB_METHOD,
    scope: {
      kind: "named",
      scope_semantics: "issuer_rp_scope",
      issuer: VERY_WEB_ISSUER,
      rp_scope: VERY_WEB_RP_SCOPE,
    },
    requested_requirements: CANONICAL_REQUIREMENTS,
    requested_claim_ids: CANONICAL_CLAIM_IDS,
    subject_binding_intent: "establish",
    protocol_version: VERY_WEB_PROTOCOL_VERSION,
    environment,
    verification_purpose: {
      intent: "community_creation",
    },
  };
}

export function makeCommunityCreationIntentResolver(
  execute: <Row = unknown>(
    statement: ControlPlaneStatement,
  ) => Effect.Effect<ControlPlaneResult<Row>, VerificationStartStorageFailed>,
  environment: string,
): VerificationIntentResolver {
  const decodedPlan = Schema.decodeUnknownOption(VerificationProviderPlanInput)(plan(environment));
  if (!validEnvironment(environment) || Option.isNone(decodedPlan)) {
    return { resolve: () => Effect.fail(storageFailure()) };
  }
  return {
    resolve: (input) =>
      Effect.gen(function* () {
        if (!("creation_intent_id" in input) || input.requirement !== "human_identity") return null;
        const result = yield* execute<IntentRow>({
          label: "community.creation.resolve-verification-intent",
          text: `SELECT intent.intent_id,
                        intent.actor_id,
                        intent.revision,
                        intent.status,
                        intent.creation_contract_version,
                        state.requirement_kind,
                        state.status AS requirement_status,
                        state.requirement_hash,
                        state.provider_id,
                        state.provider_binding_hash,
                        state.provider_configuration_kind,
                        state.provider_configuration_ref,
                        state.provider_configuration_version,
                        state.generation,
                        state.current_ceremony_intent_id,
                        state.route_family,
                        state.route_root_label,
                        state.route_root_label_display,
                        state.route_path_segment,
                        attempt.ceremony_intent_id,
                        attempt.requirement_kind AS ceremony_requirement_kind,
                        attempt.generation AS ceremony_generation,
                        attempt.requirement_hash AS ceremony_requirement_hash,
                        attempt.provider_id AS ceremony_provider_id,
                        attempt.provider_binding_hash AS ceremony_provider_binding_hash,
                        attempt.provider_configuration_kind AS ceremony_provider_configuration_kind,
                        attempt.provider_configuration_ref AS ceremony_provider_configuration_ref,
                        attempt.provider_configuration_version AS ceremony_provider_configuration_version,
                        attempt.route_family AS ceremony_route_family,
                        attempt.route_root_label AS ceremony_route_root_label,
                        attempt.route_root_label_display AS ceremony_route_root_label_display,
                        attempt.route_path_segment AS ceremony_route_path_segment,
                        attempt.reservation_request_hash,
                        intent.expires_at > clock_timestamp() AS intent_active,
                        attempt.expires_at > clock_timestamp() AS ceremony_active
                   FROM community_creation_intents AS intent
                   JOIN community_creation_requirement_states AS state
                     ON state.intent_id = intent.intent_id
                    AND state.actor_id = intent.actor_id
                    AND state.requirement_kind = 'human_identity'
                   JOIN community_creation_ceremony_attempts AS attempt
                     ON attempt.actor_id = intent.actor_id
                    AND attempt.intent_id = intent.intent_id
                    AND attempt.requirement_kind = state.requirement_kind
                    AND attempt.generation = state.generation
                    AND attempt.ceremony_intent_id = state.current_ceremony_intent_id
                  WHERE intent.intent_id = $1
                    AND intent.actor_id = $2
                    AND attempt.ceremony_intent_id = $3`,
          values: [input.creation_intent_id, input.actor_id, input.ceremony_intent_id],
          readonly: true,
        });
        const row = oneRow(result);
        if (row === undefined) return yield* Effect.fail(storageFailure());
        if (row === null || !exactIntentBinding(row, input)) return null;
        return decodedPlan.value;
      }),
  };
}

/** Resolve only server-persisted community-creation requirements. */
export function makeControlPlaneCommunityCreationIntentResolver(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  environment: string,
): VerificationIntentResolver {
  return makeCommunityCreationIntentResolver(
    <Row>(statement: ControlPlaneStatement) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.execute<Row>(statement);
      }).pipe(
        Effect.provide(runtime),
        Effect.mapError(() => storageFailure()),
      ),
    environment,
  );
}

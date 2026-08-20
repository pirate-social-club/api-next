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
  HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
  VERY_OAUTH_CONFIGURATION_REFERENCE,
  VERY_OAUTH_CONFIGURATION_VERSION,
  VERY_OAUTH_ISSUER,
  VERY_OAUTH_METHOD,
  VERY_OAUTH_PROTOCOL_VERSION,
  VERY_OAUTH_PROVIDER_ID,
  VERY_OAUTH_RP_SCOPE,
} from "@pirate/domain";
import { Effect, type Layer, Option, Schema } from "effect";

type IntentRow = Readonly<{
  readonly intent_id: unknown;
  readonly actor_id: unknown;
  readonly status: unknown;
  readonly verification_requirement_hash: unknown;
  readonly verification_provider_id: unknown;
  readonly provider_configuration_kind: unknown;
  readonly provider_configuration_ref: unknown;
  readonly provider_configuration_version: unknown;
  readonly active: unknown;
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
    readonly intent_id: string;
    readonly provider_id: string;
  }>,
): boolean {
  return (
    row.intent_id === input.intent_id &&
    row.actor_id === input.actor_id &&
    row.status === "verification_required" &&
    row.verification_requirement_hash === HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH &&
    row.verification_provider_id === VERY_OAUTH_PROVIDER_ID &&
    row.verification_provider_id === input.provider_id &&
    row.provider_configuration_kind === "dynamic" &&
    row.provider_configuration_ref === VERY_OAUTH_CONFIGURATION_REFERENCE &&
    row.provider_configuration_version === VERY_OAUTH_CONFIGURATION_VERSION &&
    row.active === true
  );
}

function plan(environment: string): unknown {
  return {
    method: VERY_OAUTH_METHOD,
    scope: {
      kind: "named",
      scope_semantics: "issuer_rp_scope",
      issuer: VERY_OAUTH_ISSUER,
      rp_scope: VERY_OAUTH_RP_SCOPE,
    },
    requested_requirements: CANONICAL_REQUIREMENTS,
    requested_claim_ids: CANONICAL_CLAIM_IDS,
    subject_binding_intent: "establish",
    protocol_version: VERY_OAUTH_PROTOCOL_VERSION,
    environment,
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
        const result = yield* execute<IntentRow>({
          label: "community.creation.resolve-verification-intent",
          text: `SELECT intent_id,
                        actor_id,
                        status,
                        verification_requirement_hash,
                        verification_provider_id,
                        provider_configuration_kind,
                        provider_configuration_ref,
                        provider_configuration_version,
                        expires_at > clock_timestamp() AS active
                   FROM community_creation_intents
                  WHERE intent_id = $1
                    AND actor_id = $2`,
          values: [input.intent_id, input.actor_id],
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

import {
  ControlPlaneDb,
  type ControlPlaneError,
  type OperatorControlPromotionOutcome,
  type OperatorControlPromotionStoreInput,
  type OperatorControlPromotionStoreService,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

type OutcomeRow = Readonly<{
  readonly outcome: unknown;
  readonly receipt_id: unknown;
  readonly evidence_ref: unknown;
  readonly route_binding_id: unknown;
  readonly binding_generation: unknown;
  readonly app_host_activation_generation: unknown;
}>;

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function positiveInteger(value: unknown): number | null {
  const normalized =
    typeof value === "string" && /^[1-9][0-9]*$/u.test(value) ? Number(value) : value;
  return typeof normalized === "number" && Number.isSafeInteger(normalized) && normalized > 0
    ? normalized
    : null;
}

function decodeOutcome(row: OutcomeRow | undefined): OperatorControlPromotionOutcome {
  const bindingGeneration = positiveInteger(row?.binding_generation);
  const appHostGeneration = positiveInteger(row?.app_host_activation_generation);
  if (
    row === undefined ||
    (row.outcome !== "promoted" && row.outcome !== "replayed") ||
    !validIdentity(row.receipt_id) ||
    !validIdentity(row.evidence_ref) ||
    !validIdentity(row.route_binding_id) ||
    bindingGeneration === null ||
    appHostGeneration === null
  ) {
    throw new Error("Operator control promotion repository returned an invalid row");
  }
  return {
    outcome: row.outcome,
    receipt_id: row.receipt_id,
    evidence_ref: row.evidence_ref,
    route_binding_id: row.route_binding_id,
    binding_generation: bindingGeneration,
    app_host_activation_generation: appHostGeneration,
  };
}

const statement = (input: OperatorControlPromotionStoreInput) =>
  ({
    label: "community.routes.operator-control.promote",
    text: `SELECT outcome,
                  receipt_id,
                  evidence_ref,
                  route_binding_id,
                  binding_generation,
                  app_host_activation_generation
             FROM promote_operator_managed_route_from_hns_candidate_v1(
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::bytea
             )`,
    values: [
      input.receipt_id,
      input.operation_id,
      input.operator_principal_id,
      input.operator_authority_grant_id,
      input.idempotency_key,
      input.request_hash,
      input.community_id,
      input.route_binding_id,
      input.operator_route_activation_id,
      input.evidence_ref,
      input.reviewed_candidate_bytes,
    ],
    readonly: false,
  }) as const;

export function makeControlPlaneOperatorControlPromotionRepository() {
  return {
    promote: (
      input: OperatorControlPromotionStoreInput,
    ): Effect.Effect<OperatorControlPromotionOutcome, ControlPlaneError, ControlPlaneDb> =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<OutcomeRow>(statement(input));
        if (result.rows.length !== 1) {
          return yield* Effect.die("Operator control promotion returned invalid cardinality");
        }
        return decodeOutcome(result.rows[0]);
      }),
  };
}

export function makeControlPlaneOperatorControlPromotionStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): OperatorControlPromotionStoreService {
  const repository = makeControlPlaneOperatorControlPromotionRepository();
  return {
    promote: (input) => Effect.provide(runtime)(repository.promote(input)),
  };
}

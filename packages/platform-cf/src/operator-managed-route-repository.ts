import {
  ControlPlaneDb,
  type ControlPlaneError,
  type OperatorManagedRouteOutcome,
  type OperatorManagedRouteStoreActivateInput,
  type OperatorManagedRouteStoreRevokeInput,
  type OperatorManagedRouteStoreService,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

type OutcomeRow = Readonly<{
  readonly outcome: unknown;
  readonly operator_route_activation_id: unknown;
  readonly route_binding_id: unknown;
  readonly activation_generation: unknown;
}>;

function validIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes("\u0000")
  );
}

function positiveInteger(value: unknown): number | null {
  const normalized =
    typeof value === "string" && /^[1-9][0-9]*$/u.test(value) ? Number(value) : value;
  return typeof normalized === "number" && Number.isSafeInteger(normalized) && normalized > 0
    ? normalized
    : null;
}

function decodeOutcome(row: OutcomeRow | undefined): OperatorManagedRouteOutcome {
  const generation = positiveInteger(row?.activation_generation);
  if (
    row === undefined ||
    (row.outcome !== "activated" && row.outcome !== "revoked" && row.outcome !== "replayed") ||
    !validIdentity(row.operator_route_activation_id) ||
    !validIdentity(row.route_binding_id) ||
    generation === null
  ) {
    throw new Error("Operator-managed route repository returned an invalid row");
  }
  return {
    outcome: row.outcome,
    operator_route_activation_id: row.operator_route_activation_id,
    route_binding_id: row.route_binding_id,
    activation_generation: generation,
  };
}

const activateStatement = (input: OperatorManagedRouteStoreActivateInput) =>
  ({
    label: "community.routes.operator-managed.activate",
    text: `SELECT outcome,
                  operator_route_activation_id,
                  route_binding_id,
                  activation_generation
             FROM activate_operator_managed_route_v1(
               $1, $2, $3, $4, $5, $6, $7, $8,
               $9, $10::bigint, $11, $12, $13, $14
             )`,
    values: [
      input.operation_id,
      input.operator_principal_id,
      input.operator_authority_grant_id,
      input.idempotency_key,
      input.request_hash,
      input.community_id,
      input.canonical_root,
      input.root_label_display,
      input.registry_reference,
      input.registry_version,
      input.registry_digest,
      input.operator_route_activation_id,
      input.route_binding_id,
      input.reason_code,
    ],
    readonly: false,
  }) as const;

const revokeStatement = (input: OperatorManagedRouteStoreRevokeInput) =>
  ({
    label: "community.routes.operator-managed.revoke",
    text: `SELECT outcome,
                  operator_route_activation_id,
                  route_binding_id,
                  activation_generation
             FROM revoke_operator_managed_route_v1(
               $1, $2, $3, $4, $5, $6, $7, $8,
               $9, $10::bigint, $11
             )`,
    values: [
      input.operation_id,
      input.operator_principal_id,
      input.operator_authority_grant_id,
      input.idempotency_key,
      input.request_hash,
      input.community_id,
      input.canonical_root,
      input.operator_route_activation_id,
      input.route_binding_id,
      input.expected_activation_generation,
      input.reason_code,
    ],
    readonly: false,
  }) as const;

export interface OperatorManagedRouteRepository {
  readonly activate: (
    input: OperatorManagedRouteStoreActivateInput,
  ) => Effect.Effect<OperatorManagedRouteOutcome, ControlPlaneError, ControlPlaneDb>;
  readonly revoke: (
    input: OperatorManagedRouteStoreRevokeInput,
  ) => Effect.Effect<OperatorManagedRouteOutcome, ControlPlaneError, ControlPlaneDb>;
}

export function makeControlPlaneOperatorManagedRouteRepository(): OperatorManagedRouteRepository {
  return {
    activate: (input) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<OutcomeRow>(activateStatement(input));
        if (result.rows.length !== 1) {
          return yield* Effect.die(
            "Operator-managed route activation returned invalid cardinality",
          );
        }
        return decodeOutcome(result.rows[0]);
      }),
    revoke: (input) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<OutcomeRow>(revokeStatement(input));
        if (result.rows.length !== 1) {
          return yield* Effect.die(
            "Operator-managed route revocation returned invalid cardinality",
          );
        }
        return decodeOutcome(result.rows[0]);
      }),
  };
}

export function makeControlPlaneOperatorManagedRouteStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): OperatorManagedRouteStoreService {
  const repository = makeControlPlaneOperatorManagedRouteRepository();
  return {
    activate: (input) => Effect.provide(runtime)(repository.activate(input)),
    revoke: (input) => Effect.provide(runtime)(repository.revoke(input)),
  };
}

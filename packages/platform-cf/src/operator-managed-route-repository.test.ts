import { expect, test } from "bun:test";
import {
  ControlPlaneDb,
  type ControlPlaneResult,
  type ControlPlaneStatement,
} from "@pirate/application";
import type { Sha256Hex } from "@pirate/domain/verification";
import { Effect } from "effect";
import { makeControlPlaneOperatorManagedRouteRepository } from "./operator-managed-route-repository.ts";

function fakeDb(rows: readonly Record<string, unknown>[], calls: ControlPlaneStatement[]) {
  const execute = <R = unknown>(statement: ControlPlaneStatement) => {
    calls.push(statement);
    return Effect.succeed({
      rows: rows as readonly R[],
      rowCount: rows.length,
    } satisfies ControlPlaneResult<R>);
  };
  return {
    execute,
    withTransaction: <A, E, R>(
      use: (transaction: { execute: typeof execute }) => Effect.Effect<A, E, R>,
    ) => use({ execute }),
  } satisfies ControlPlaneDb["Service"];
}

const common = {
  operation_id: "operator-operation-1",
  operator_principal_id: "operator-1",
  operator_authority_grant_id: "operator-grant-1",
  idempotency_key: "operator-key-1",
  request_hash: "a".repeat(64) as Sha256Hex,
  community_id: "community_123e4567-e89b-42d3-a456-426614174000",
  canonical_root: "pirate",
  operator_route_activation_id: "operator-activation-1",
  route_binding_id: "operator-binding-1",
  reason_code: "first-party-root",
} as const;

test("calls the source-closed activation function with exact authority", async () => {
  const calls: ControlPlaneStatement[] = [];
  const repository = makeControlPlaneOperatorManagedRouteRepository();
  const result = await Effect.runPromise(
    Effect.provideService(
      repository.activate({
        ...common,
        root_label_display: "pirate",
        registry_reference: "operator-managed-roots-2026-08",
        registry_version: 1,
        registry_digest:
          "f60b4c58bdf17672aae9014e6fed2f522fc77ef0190ed80b822249b8826b1292" as Sha256Hex,
      }),
      ControlPlaneDb,
      fakeDb(
        [
          {
            outcome: "activated",
            operator_route_activation_id: common.operator_route_activation_id,
            route_binding_id: common.route_binding_id,
            activation_generation: "1",
          },
        ],
        calls,
      ),
    ),
  );
  expect(result).toMatchObject({ outcome: "activated", activation_generation: 1 });
  expect(calls[0]).toMatchObject({
    label: "community.routes.operator-managed.activate",
    readonly: false,
  });
  expect(calls[0]?.text).toContain("activate_operator_managed_route_v1");
  expect(calls[0]?.values).toHaveLength(14);
});

test("calls revocation with the expected activation generation", async () => {
  const calls: ControlPlaneStatement[] = [];
  const repository = makeControlPlaneOperatorManagedRouteRepository();
  const result = await Effect.runPromise(
    Effect.provideService(
      repository.revoke({ ...common, expected_activation_generation: 1 }),
      ControlPlaneDb,
      fakeDb(
        [
          {
            outcome: "revoked",
            operator_route_activation_id: common.operator_route_activation_id,
            route_binding_id: common.route_binding_id,
            activation_generation: 2,
          },
        ],
        calls,
      ),
    ),
  );
  expect(result).toMatchObject({ outcome: "revoked", activation_generation: 2 });
  expect(calls[0]?.text).toContain("revoke_operator_managed_route_v1");
  expect(calls[0]?.values[9]).toBe(1);
});

import { expect, test } from "bun:test";
import type { Sha256Hex } from "@pirate/domain/verification";
import { Effect, Exit } from "effect";
import {
  activateOperatorManagedRoute,
  type OperatorManagedRouteStoreActivateInput,
  type OperatorManagedRouteStoreRevokeInput,
  operatorManagedRouteActivationRequestPreimage,
  revokeOperatorManagedRoute,
} from "./operator-managed-route.ts";

const digest = "f60b4c58bdf17672aae9014e6fed2f522fc77ef0190ed80b822249b8826b1292" as Sha256Hex;
const activation = {
  operation_id: "operator-route-operation-1",
  operator_principal_id: "platform-operator-1",
  operator_authority_grant_id: "operator-route-grant-1",
  idempotency_key: "operator-route-key-1",
  community_id: "community_123e4567-e89b-42d3-a456-426614174000",
  canonical_root: "pirate",
  registry_reference: "operator-managed-roots-2026-08",
  registry_version: 1,
  registry_digest: digest,
  operator_route_activation_id: "operator-route-activation-1",
  route_binding_id: "operator-route-binding-1",
  reason_code: "first-party-root",
} as const;

test("binds activation to the exact registry and canonical route display", async () => {
  const calls: OperatorManagedRouteStoreActivateInput[] = [];
  const result = await Effect.runPromise(
    activateOperatorManagedRoute(activation, {
      store: {
        activate: (input) => {
          calls.push(input);
          return Effect.succeed({
            outcome: "activated" as const,
            operator_route_activation_id: input.operator_route_activation_id,
            route_binding_id: input.route_binding_id,
            activation_generation: 1,
          });
        },
        revoke: () => Effect.die("not used"),
      },
    }),
  );
  expect(result.outcome).toBe("activated");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    canonical_root: "pirate",
    root_label_display: "pirate",
    request_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
  });
  expect(operatorManagedRouteActivationRequestPreimage(activation)).toContain(
    '"operator-managed-roots-2026-08",1,"f60b4c58',
  );
});

test("rejects noncanonical roots before storage", async () => {
  let called = false;
  const exit = await Effect.runPromiseExit(
    activateOperatorManagedRoute(
      { ...activation, canonical_root: "Pirate" },
      {
        store: {
          activate: () => {
            called = true;
            return Effect.die("must not run");
          },
          revoke: () => Effect.die("not used"),
        },
      },
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  expect(called).toBe(false);
});

test("binds revocation to the expected activation generation", async () => {
  const calls: OperatorManagedRouteStoreRevokeInput[] = [];
  const input = {
    operation_id: "operator-route-revoke-1",
    operator_principal_id: activation.operator_principal_id,
    operator_authority_grant_id: activation.operator_authority_grant_id,
    idempotency_key: "operator-route-revoke-key-1",
    community_id: activation.community_id,
    canonical_root: activation.canonical_root,
    operator_route_activation_id: activation.operator_route_activation_id,
    route_binding_id: activation.route_binding_id,
    expected_activation_generation: 1,
    reason_code: "root-retired",
  } as const;
  const result = await Effect.runPromise(
    revokeOperatorManagedRoute(input, {
      store: {
        activate: () => Effect.die("not used"),
        revoke: (value) => {
          calls.push(value);
          return Effect.succeed({
            outcome: "revoked" as const,
            operator_route_activation_id: value.operator_route_activation_id,
            route_binding_id: value.route_binding_id,
            activation_generation: value.expected_activation_generation + 1,
          });
        },
      },
    }),
  );
  expect(result).toMatchObject({ outcome: "revoked", activation_generation: 2 });
  expect(calls[0]?.request_hash).toMatch(/^[0-9a-f]{64}$/u);
});

import {
  ControlPlaneDb,
  type ControlPlaneResult,
  type ControlPlaneStatement,
} from "@pirate/application";
import { Effect, Layer } from "effect";
import { expect, test } from "vitest";
import { makeControlPlaneOperatorControlPromotionStore } from "./operator-control-promotion-repository.ts";

test("operator promotion repository sends exact candidate bytes", async () => {
  const calls: Array<{ readonly text: string; readonly values: readonly unknown[] }> = [];
  const bytes = new TextEncoder().encode("candidate");
  const store = makeControlPlaneOperatorControlPromotionStore(
    Layer.succeed(ControlPlaneDb, {
      execute: <Row = unknown>(statement: ControlPlaneStatement) => {
        calls.push(statement);
        return Effect.succeed({
          rows: [
            {
              outcome: "promoted",
              receipt_id: "receipt-1",
              evidence_ref: "evidence-1",
              route_binding_id: "binding-1",
              binding_generation: "2",
              app_host_activation_generation: "12",
            },
          ] as readonly Row[],
          rowCount: 1,
        } satisfies ControlPlaneResult<Row>);
      },
    }),
  );
  const outcome = await Effect.runPromise(
    store.promote({
      receipt_id: "receipt-1",
      operation_id: "operation-1",
      operator_principal_id: "operator-1",
      operator_authority_grant_id: "grant-1",
      idempotency_key: "key-1",
      request_hash: "a".repeat(64),
      community_id: "community-1",
      route_binding_id: "binding-1",
      operator_route_activation_id: "activation-1",
      evidence_ref: "evidence-1",
      reviewed_candidate_bytes: bytes,
    }),
  );
  expect(outcome.binding_generation).toBe(2);
  expect(calls[0]?.text).toContain("promote_operator_managed_route_from_hns_candidate_v1");
  expect(calls[0]?.values.at(-1)).toEqual(bytes);
});

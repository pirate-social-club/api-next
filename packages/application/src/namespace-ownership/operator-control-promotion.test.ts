import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import {
  OperatorControlPromotionRejected,
  type PromoteOperatorControlRouteInput,
  promoteOperatorControlRoute,
} from "./operator-control-promotion.ts";

const candidate = new TextEncoder().encode('{"version":"candidate"}');
const input: PromoteOperatorControlRouteInput = {
  receipt_id: "hns-promotion-receipt-1",
  operation_id: "hns-promotion-operation-1",
  operator_principal_id: "platform-operator-1",
  operator_authority_grant_id: "operator-route-grant-1",
  idempotency_key: "hns-promotion-key-1",
  community_id: "community-1",
  route_binding_id: "route-binding-1",
  operator_route_activation_id: "operator-route-activation-1",
  evidence_ref: "hns-evidence-1",
  reviewed_candidate_bytes: candidate,
};

describe("operator control promotion", () => {
  test("derives the request hash from exact candidate bytes", async () => {
    const seen: unknown[] = [];
    const outcome = await Effect.runPromise(
      promoteOperatorControlRoute(input, {
        store: {
          promote: (value) => {
            seen.push(value);
            return Effect.succeed({
              outcome: "promoted" as const,
              receipt_id: value.receipt_id,
              evidence_ref: value.evidence_ref,
              route_binding_id: value.route_binding_id,
              binding_generation: 2,
              app_host_activation_generation: 12,
            });
          },
        },
      }),
    );
    expect(outcome.outcome).toBe("promoted");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      request_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      reviewed_candidate_bytes: candidate,
    });
  });

  test("changes the request hash when only candidate bytes change", async () => {
    const hashes: string[] = [];
    const store = {
      promote: (
        value: Parameters<Parameters<typeof promoteOperatorControlRoute>[1]["store"]["promote"]>[0],
      ) => {
        hashes.push(value.request_hash);
        return Effect.succeed({
          outcome: "promoted" as const,
          receipt_id: value.receipt_id,
          evidence_ref: value.evidence_ref,
          route_binding_id: value.route_binding_id,
          binding_generation: 2,
          app_host_activation_generation: 12,
        });
      },
    };
    await Effect.runPromise(promoteOperatorControlRoute(input, { store }));
    await Effect.runPromise(
      promoteOperatorControlRoute(
        { ...input, reviewed_candidate_bytes: new TextEncoder().encode("different") },
        { store },
      ),
    );
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  test("refuses an empty candidate before storage", async () => {
    await expect(
      Effect.runPromise(
        promoteOperatorControlRoute(
          { ...input, reviewed_candidate_bytes: new Uint8Array() },
          { store: { promote: () => Effect.die("unreachable") } },
        ),
      ),
    ).rejects.toBeInstanceOf(OperatorControlPromotionRejected);
  });
});

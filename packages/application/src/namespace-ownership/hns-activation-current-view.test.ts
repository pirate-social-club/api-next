import { describe, expect, test } from "bun:test";
import {
  gatherHnsActivationCurrentViewV1,
  type HnsActivationCurrentViewPortsV1,
} from "./hns-activation-current-view.ts";

/**
 * The activation current-view gatherer: the identity read, the provider read
 * outside any transaction, and the wire digest the activation gate compares.
 * Confirmed conflict and unavailable evidence stay distinct, and qualification
 * is bound to the identity's generation-bound digest (the adopted digest after
 * adoption).
 */

const planDigest = "a".repeat(64);

function ports(
  overrides: Partial<HnsActivationCurrentViewPortsV1> = {},
): HnsActivationCurrentViewPortsV1 {
  return {
    identity: async () => ({
      root_label: "exampleroot",
      lifecycle_revision: 2,
      lifecycle_generation: 1,
      plan_encoded_resource_sha256: planDigest,
    }),
    observe_current: async () =>
      ({
        kind: "observed",
        observation: { records: [], observed_at_epoch_ms: 1_770_000_000_000 },
      }) as never,
    wire_digest: async () => planDigest,
    ...overrides,
  };
}

describe("the activation current-view gatherer", () => {
  test("returns the wire digest and qualification for matching current authority", async () => {
    const result = await gatherHnsActivationCurrentViewV1("session-1", ports());
    expect(result).toEqual({
      kind: "gathered",
      binding: {
        lifecycle_revision: 2,
        lifecycle_generation: 1,
        observed_at_epoch_ms: 1_770_000_000_000,
        resource_sha256: planDigest,
        qualifying: true,
      },
    });
  });

  test("an observed resource that differs is gathered as non-qualifying, not invented", async () => {
    const result = await gatherHnsActivationCurrentViewV1(
      "session-1",
      ports({ wire_digest: async () => "b".repeat(64) }),
    );
    expect(result.kind).toBe("gathered");
    if (result.kind !== "gathered") throw new Error("expected gathered");
    expect(result.binding.qualifying).toBe(false);
    expect(result.binding.resource_sha256).toBe("b".repeat(64));
  });

  test("a finding about the name is a conflict; an outage is unavailable", async () => {
    const mismatch = await gatherHnsActivationCurrentViewV1(
      "session-1",
      ports({
        observe_current: async () =>
          ({ kind: "finding", classification: "resource_mismatch" }) as never,
      }),
    );
    expect(mismatch).toEqual({ kind: "conflict", classification: "resource_mismatch" });
    const outage = await gatherHnsActivationCurrentViewV1(
      "session-1",
      ports({
        observe_current: async () =>
          ({ kind: "unavailable", classification: "node_unavailable" }) as never,
      }),
    );
    expect(outage).toEqual({ kind: "unavailable", classification: "node_unavailable" });
  });

  test("an absent operation and an unobservable provider are reported without a binding", async () => {
    expect(
      await gatherHnsActivationCurrentViewV1("session-1", ports({ identity: async () => null })),
    ).toEqual({ kind: "operation_absent" });
    expect(
      await gatherHnsActivationCurrentViewV1(
        "session-1",
        ports({
          observe_current: async () => {
            throw new Error("RPC unavailable");
          },
        }),
      ),
    ).toEqual({ kind: "unavailable", classification: "transport_failure" });
  });

  test("qualification follows the identity's generation-bound digest after adoption", async () => {
    const adoptedDigest = "c".repeat(64);
    const result = await gatherHnsActivationCurrentViewV1(
      "session-1",
      ports({
        identity: async () => ({
          root_label: "exampleroot",
          lifecycle_revision: 3,
          lifecycle_generation: 2,
          plan_encoded_resource_sha256: adoptedDigest,
        }),
        wire_digest: async () => adoptedDigest,
      }),
    );
    expect(result.kind).toBe("gathered");
    if (result.kind !== "gathered") throw new Error("expected gathered");
    expect(result.binding.qualifying).toBe(true);
    expect(result.binding.lifecycle_generation).toBe(2);
  });

  test("an unencodable observed resource is unavailable, never qualifying", async () => {
    const result = await gatherHnsActivationCurrentViewV1(
      "session-1",
      ports({
        wire_digest: async () => {
          throw new Error("resource too large");
        },
      }),
    );
    expect(result).toEqual({ kind: "unavailable", classification: "malformed_response" });
  });
});

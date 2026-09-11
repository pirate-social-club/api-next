import { describe, expect, test } from "bun:test";
import type { HnsRetainedAuthorityReferenceV1 } from "@pirate/application/namespace-ownership";
import { makeHnsIncidentRetainedPlanReadV1 } from "./incident-hsd.ts";

/**
 * Reading an incident on a deployment that predates the lifecycle tables.
 *
 * Four of the five evidence questions are answered by the chain and the
 * provider, and the exposed plan lives in the older session tables, so such an
 * operation can be read and classified. What it cannot do is have a finding
 * persisted against it, and the report has to say so rather than fail or
 * pretend otherwise.
 */

const planDigest = "1".repeat(64);
const authority: HnsRetainedAuthorityReferenceV1 = {
  ns_names: ["ns1.pirate."],
  ds: [],
  challenge_txt_value: "pirate-verification=incident",
};

const planBytes = new TextEncoder().encode(
  JSON.stringify({
    version: "pirate-hns-root-import-publish-plan-v1",
    encoded_resource_sha256: planDigest,
    replacement_records: [{ type: "NS", ns: "ns1.pirate." }],
  }),
);

type Rows = Record<string, unknown>[];

function reader(lifecycle: Rows, session: Rows, onThrow = false) {
  return makeHnsIncidentRetainedPlanReadV1(
    async (text: string) => {
      if (text.includes("hns_root_import_lifecycle")) {
        if (onThrow) throw new Error("relation does not exist");
        return { rows: lifecycle as never };
      }
      return { rows: session as never };
    },
    () => authority,
    () => planDigest,
  );
}

describe("the retained plan read tolerates both schemas", () => {
  test("a lifecycle-managed operation reports its own generation and digest", async () => {
    const read = reader(
      [
        {
          root_label: "managed",
          generation: 3,
          revision: 7,
          plan_encoded_resource_sha256: planDigest,
        },
      ],
      [{ root_label: "managed", ownership_generation: 1, revision: 2, publish_plan_bytes: null }],
    );
    expect(await read("session-managed")).toEqual({
      root_label: "managed",
      generation: 3,
      revision: 7,
      plan_encoded_sha256: planDigest,
      authority: null,
      lifecycle_present: true,
    });
  });

  test("a lifecycle row without a digest falls back to the plan document's own", async () => {
    const read = reader(
      [{ root_label: "managed", generation: 3, revision: 7, plan_encoded_resource_sha256: null }],
      [
        {
          root_label: "managed",
          ownership_generation: 1,
          revision: 2,
          publish_plan_bytes: planBytes,
        },
      ],
    );
    const result = await read("session-managed");
    expect(result?.plan_encoded_sha256).toBe(planDigest);
    expect(result?.authority).toEqual(authority);
    expect(result?.lifecycle_present).toBe(true);
  });

  test("an operation the lifecycle does not know about is readable but not recordable", async () => {
    const read = reader(
      [],
      [
        {
          root_label: "legacy",
          ownership_generation: 4,
          revision: 9,
          publish_plan_bytes: planBytes,
        },
      ],
    );
    expect(await read("session-legacy")).toEqual({
      root_label: "legacy",
      generation: 4,
      revision: 9,
      plan_encoded_sha256: planDigest,
      authority,
      lifecycle_present: false,
    });
  });

  test("a deployment with no lifecycle table at all still reads the session", async () => {
    // The table simply does not exist there. That is a schema fact, not a
    // finding about the operation, so the read continues rather than failing.
    const read = reader(
      [],
      [
        {
          root_label: "legacy",
          ownership_generation: 4,
          revision: 9,
          publish_plan_bytes: planBytes,
        },
      ],
      true,
    );
    const result = await read("session-legacy");
    expect(result?.lifecycle_present).toBe(false);
    expect(result?.plan_encoded_sha256).toBe(planDigest);
  });

  test("an unreadable plan yields no digest and no authority, never a guess", async () => {
    const read = makeHnsIncidentRetainedPlanReadV1(
      async (text: string) => ({
        rows: (text.includes("hns_root_import_lifecycle")
          ? []
          : [
              {
                root_label: "legacy",
                ownership_generation: 4,
                revision: 9,
                publish_plan_bytes: new TextEncoder().encode("{not json"),
              },
            ]) as never,
      }),
      () => {
        throw new Error("undecodable plan");
      },
      () => planDigest,
    );
    const result = await read("session-legacy");
    expect(result?.plan_encoded_sha256).toBeNull();
    expect(result?.authority).toBeNull();
  });

  test("an operation neither table knows about is absent", async () => {
    expect(await reader([], [])("session-missing")).toBeNull();
  });
});

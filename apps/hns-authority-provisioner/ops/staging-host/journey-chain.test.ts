import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  buildHnsRootImportPublishPlanV1,
  encodeHnsResourceV1,
  validateHnsRootResourceRecordsV1,
} from "@pirate/application/namespace-ownership";
import { canonicalJson } from "@pirate/domain";
import { reservationAccount } from "../../src/powerdns.ts";
import {
  parseJourneyCommand,
  requireBoundSessionResponse,
  requirePlanProvenance,
  requirePublishablePlan,
  requireSessionPlan,
} from "./journey-chain.ts";

const root = "e2eabc123";
const responseDigest = "a".repeat(64);
const challenge = "pirate-verification=00000000-0000-4000-8000-000000000000";
const ds = [
  { key_tag: 1, algorithm: 13, digest_type: 2 as const, digest: "a".repeat(64) },
  { key_tag: 1, algorithm: 13, digest_type: 4 as const, digest: "b".repeat(96) },
];
const zoneDs = ["1 13 2 " + "A".repeat(64), "1 13 4 " + "B".repeat(96)];

const code = async (run: () => unknown) => {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code ?? "untyped";
  }
  return "admitted";
};

async function productPlan() {
  return buildHnsRootImportPublishPlanV1({
    current_records: [],
    challenge_txt_value: challenge,
    ds_records: ds,
  });
}

function sessionResponse(plan: unknown) {
  return {
    community_id: "community_fixture",
    root_import_session_id: "session_fixture",
    root_label: root,
    status: "awaiting_owner_update",
    publish_plan: plan,
    publish_plan_sha256: createHash("sha256").update(canonicalJson(plan)).digest("hex"),
  };
}

function authority(zone: unknown, keys: unknown, status = 200) {
  return async (url: string) => {
    const body = url.endsWith("/cryptokeys") ? keys : zone;
    return new Response(JSON.stringify(body), { status });
  };
}

describe("staging journey chain command", () => {
  test("parses only bounded commands on journey-generated roots", async () => {
    expect(parseJourneyCommand(["begin", "--root", root])).toEqual({ kind: "begin", root });
    expect(parseJourneyCommand(["mine", "--root", root, "--blocks", "5"])).toEqual({
      kind: "mine",
      root,
      blocks: 5,
    });
    expect(
      parseJourneyCommand([
        "advance-safe",
        "--root",
        root,
        "--plan",
        "/p.json",
        "--response-sha256",
        responseDigest,
      ]),
    ).toEqual({
      kind: "advance-safe",
      root,
      plan: "/p.json",
      responseSha256: responseDigest,
    });
    expect(await code(() => parseJourneyCommand(["mine", "--blocks", "5"]))).toBe("root_invalid");
    expect(await code(() => parseJourneyCommand(["mine", "--root", root, "--blocks", "61"]))).toBe(
      "blocks_invalid",
    );
    expect(await code(() => parseJourneyCommand(["acquire", "--root", "0qcm"]))).toBe(
      "root_invalid",
    );
    expect(await code(() => parseJourneyCommand(["acquire", "--root", "pirate"]))).toBe(
      "root_invalid",
    );
    expect(await code(() => parseJourneyCommand(["acquire", "--root", root, "--root", root]))).toBe(
      "option_duplicate",
    );
    expect(
      await code(() =>
        parseJourneyCommand([
          "publish",
          "--root",
          root,
          "--plan",
          "rel",
          "--response-sha256",
          responseDigest,
        ]),
      ),
    ).toBe("plan_path_invalid");
    expect(
      await code(() => parseJourneyCommand(["publish", "--root", root, "--plan", "/p.json"])),
    ).toBe("response_digest_invalid");
    expect(await code(() => parseJourneyCommand(["transfer", "--root", root]))).toBe(
      "command_invalid",
    );
  });

  test("publishes only a self-consistent plan for this root", async () => {
    const plan = await productPlan();
    expect(await code(() => requirePublishablePlan(root, plan))).toBe("admitted");
    expect(
      await code(() => requirePublishablePlan("e2eother99", { ...plan, root_label: root })),
    ).toBe("plan_root_mismatch");
    expect(
      await code(() =>
        requirePublishablePlan(root, { ...plan, encoded_resource_sha256: "b".repeat(64) }),
      ),
    ).toBe("plan_digest_mismatch");
    expect(await code(() => requirePublishablePlan(root, { root_label: root }))).toBe("plan_shape");
    expect(
      await code(() =>
        requirePublishablePlan(root, {
          ...plan,
          added_records: [{ type: "BOGUS" }],
          replacement_records: [{ type: "BOGUS" }],
        }),
      ),
    ).toBe("plan_records_invalid");
  });

  test("binds every replacement record to the product session plan digest", async () => {
    const plan = await productPlan();
    const response = sessionResponse(plan);
    expect(await code(() => requireSessionPlan(root, response))).toBe("admitted");
    const bytes = Buffer.from(JSON.stringify(response));
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect((await requireBoundSessionResponse(root, bytes, digest)).response_sha256).toBe(digest);
    expect(await code(() => requireBoundSessionResponse(root, bytes, responseDigest))).toBe(
      "response_digest_mismatch",
    );
    const changedNs = {
      ...plan,
      replacement_records: plan.replacement_records.map((record) =>
        record.type === "NS" ? { type: "NS", ns: "wrong.example." } : record,
      ),
    };
    expect(
      await code(() => requireSessionPlan(root, { ...response, publish_plan: changedNs })),
    ).toBe("plan_document_digest_mismatch");
    const alteredRecords = plan.replacement_records.map((record) =>
      record.type === "NS" ? { type: "NS", ns: "wrong.example." } : record,
    );
    const alteredPlan = {
      ...plan,
      added_records: alteredRecords,
      replacement_records: alteredRecords,
      encoded_resource_sha256: createHash("sha256")
        .update(encodeHnsResourceV1(alteredRecords))
        .digest("hex"),
    };
    expect(await code(() => requireSessionPlan(root, sessionResponse(alteredPlan)))).toBe(
      "plan_not_product_build",
    );
    expect(
      await code(() => requireSessionPlan(root, { ...response, root_label: "e2eother99" })),
    ).toBe("session_identity_mismatch");
    expect(await code(() => requireSessionPlan(root, { ...response, status: "activated" }))).toBe(
      "session_not_awaiting_update",
    );
    expect(
      await code(() =>
        requireSessionPlan(root, { ...response, publish_plan_sha256: "0".repeat(64) }),
      ),
    ).toBe("plan_document_digest_mismatch");
  });

  test("requires a product-provisioned zone for the exact challenge and DS set", async () => {
    const records = validateHnsRootResourceRecordsV1((await productPlan()).replacement_records);
    const account = await reservationAccount(challenge);
    const keys = [{ active: true, published: true, ds: zoneDs }];
    const run = (fetcher: ReturnType<typeof authority>, url = "http://127.0.0.21:8081") =>
      requirePlanProvenance(root, records, fetcher, url, "fixture-key");
    expect(await code(() => run(authority({ account }, keys)))).toBe("admitted");
    expect(await code(() => run(authority({ account: "0".repeat(40) }, keys)))).toBe(
      "plan_not_from_product_provisioning",
    );
    expect(
      await code(() =>
        run(
          authority({ account }, [
            { active: true, published: true, ds: ["1 13 2 " + "C".repeat(64)] },
          ]),
        ),
      ),
    ).toBe("plan_ds_differs_from_zone");
    expect(
      await code(() =>
        run(authority({ account }, [{ active: false, published: true, ds: zoneDs }])),
      ),
    ).toBe("plan_ds_differs_from_zone");
    expect(await code(() => run(authority({}, keys, 404)))).toBe("plan_zone_absent");
    expect(await code(() => run(authority({ account }, keys), "http://10.0.0.5:8081"))).toBe(
      "authority_not_loopback",
    );
    expect(
      await code(() => run(authority({ account }, keys), "http://127.evil.example:8081")),
    ).toBe("authority_not_loopback");
  });
});

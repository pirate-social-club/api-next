import { describe, expect, test } from "bun:test";
import {
  buildHnsRootImportPublishPlanV1,
  validateHnsRootResourceRecordsV1,
} from "@pirate/application/namespace-ownership";
import { reservationAccount } from "../../src/powerdns.ts";
import {
  parseJourneyCommand,
  requirePlanProvenance,
  requirePublishablePlan,
} from "./journey-chain.ts";

const root = "e2eabc123";
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
  const built = await buildHnsRootImportPublishPlanV1({
    current_records: [],
    challenge_txt_value: challenge,
    ds_records: ds,
  });
  return {
    root_label: root,
    replacement_records: built.replacement_records,
    encoded_resource_sha256: built.encoded_resource_sha256,
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
    expect(parseJourneyCommand(["advance-safe", "--root", root, "--plan", "/p.json"])).toEqual({
      kind: "advance-safe",
      root,
      plan: "/p.json",
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
      await code(() => parseJourneyCommand(["publish", "--root", root, "--plan", "rel"])),
    ).toBe("plan_path_invalid");
    expect(await code(() => parseJourneyCommand(["transfer", "--root", root]))).toBe(
      "command_invalid",
    );
  });

  test("publishes only a self-consistent plan for this root", async () => {
    const plan = await productPlan();
    expect(await code(() => requirePublishablePlan(root, plan))).toBe("admitted");
    expect(await code(() => requirePublishablePlan("e2eother99", plan))).toBe("plan_root_mismatch");
    expect(
      await code(() =>
        requirePublishablePlan(root, { ...plan, encoded_resource_sha256: "b".repeat(64) }),
      ),
    ).toBe("plan_digest_mismatch");
    expect(await code(() => requirePublishablePlan(root, { root_label: root }))).toBe("plan_shape");
    expect(
      await code(() =>
        requirePublishablePlan(root, { ...plan, replacement_records: [{ type: "BOGUS" }] }),
      ),
    ).toBe("plan_records_invalid");
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
  });
});

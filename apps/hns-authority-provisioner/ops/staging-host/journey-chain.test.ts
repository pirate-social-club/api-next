import { describe, expect, test } from "bun:test";
import { buildHnsRootImportPublishPlanV1 } from "@pirate/application/namespace-ownership";
import { parseJourneyCommand, requirePublishablePlan } from "./journey-chain.ts";

const code = async (run: () => unknown) => {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code ?? "untyped";
  }
  return "admitted";
};

describe("staging journey chain command", () => {
  test("parses only the five bounded commands", async () => {
    expect(parseJourneyCommand(["advance-safe", "--root", "e2eabc", "--plan", "/p.json"])).toEqual({
      kind: "advance-safe",
      root: "e2eabc",
      plan: "/p.json",
    });
    expect(parseJourneyCommand(["acquire", "--root", "e2eabc"])).toEqual({
      kind: "acquire",
      root: "e2eabc",
    });
    expect(parseJourneyCommand(["mine", "--blocks", "5"])).toEqual({ kind: "mine", blocks: 5 });
    expect(await code(() => parseJourneyCommand(["mine", "--blocks", "61"]))).toBe(
      "blocks_invalid",
    );
    expect(await code(() => parseJourneyCommand(["mine", "--blocks", "0"]))).toBe("blocks_invalid");
    expect(await code(() => parseJourneyCommand(["acquire", "--root", "Bad Root"]))).toBe(
      "root_invalid",
    );
    expect(await code(() => parseJourneyCommand(["acquire", "--root", "x", "--root", "y"]))).toBe(
      "option_duplicate",
    );
    expect(
      await code(() => parseJourneyCommand(["publish", "--root", "e2eabc", "--plan", "rel.json"])),
    ).toBe("plan_path_invalid");
    expect(
      await code(() => parseJourneyCommand(["status", "--root", "e2eabc", "--blocks", "1"])),
    ).toBe("option_unexpected");
    expect(await code(() => parseJourneyCommand(["transfer", "--root", "e2eabc"]))).toBe(
      "command_invalid",
    );
  });

  test("publishes only the product plan for this root at its digest", async () => {
    const built = await buildHnsRootImportPublishPlanV1({
      current_records: [],
      challenge_txt_value: "pirate-verification=00000000-0000-4000-8000-000000000000",
      ds_records: [
        { key_tag: 1, algorithm: 13, digest_type: 2, digest: "a".repeat(64) },
        { key_tag: 1, algorithm: 13, digest_type: 4, digest: "b".repeat(96) },
      ],
    });
    const plan = {
      root_label: "e2eabc",
      replacement_records: built.replacement_records,
      encoded_resource_sha256: built.encoded_resource_sha256,
    };
    expect(await code(() => requirePublishablePlan("e2eabc", plan))).toBe("admitted");
    expect(await code(() => requirePublishablePlan("e2eother", plan))).toBe("plan_root_mismatch");
    expect(
      await code(() =>
        requirePublishablePlan("e2eabc", { ...plan, encoded_resource_sha256: "b".repeat(64) }),
      ),
    ).toBe("plan_digest_mismatch");
    expect(
      await code(() =>
        requirePublishablePlan("e2eabc", { ...plan, encoded_resource_sha256: "short" }),
      ),
    ).toBe("plan_digest_invalid");
    expect(await code(() => requirePublishablePlan("e2eabc", { root_label: "e2eabc" }))).toBe(
      "plan_shape",
    );
    expect(
      await code(() =>
        requirePublishablePlan("e2eabc", { ...plan, replacement_records: [{ type: "BOGUS" }] }),
      ),
    ).toBe("plan_records_invalid");
  });
});

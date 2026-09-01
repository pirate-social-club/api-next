import { describe, expect, test } from "bun:test";
import {
  buildHnsRootImportPublishPlanV1,
  HNS_ROOT_IMPORT_NAMESERVERS,
  HnsRootImportPlanError,
  hnsRootImportPublishPlanSha256V1,
} from "./hns-root-import-plan.ts";

const dsRecords = [
  { key_tag: 10_875, algorithm: 13, digest_type: 4 as const, digest: "AB".repeat(48) },
  { key_tag: 10_875, algorithm: 13, digest_type: 2 as const, digest: "CD".repeat(32) },
] as const;

describe("HNS root import publish plan", () => {
  test("returns a complete replacement while preserving unrelated records", async () => {
    const currentRecords = [
      { type: "SYNTH4", address: "192.0.2.44" },
      { type: "TXT", txt: ["owner=", "preserved"] },
      { type: "NS", ns: "old.example." },
      { type: "DS", keyTag: 1, algorithm: 13, digestType: 2, digest: "ef".repeat(32) },
      { type: "TXT", txt: ["pirate-verification=stale"] },
      { type: "GLUE4", ns: "unrelated.example.", address: "192.0.2.45" },
    ] as const;
    const original = structuredClone(currentRecords);
    const plan = buildHnsRootImportPublishPlanV1({
      current_records: currentRecords,
      challenge_txt_value: "pirate-verification=session_1",
      ds_records: dsRecords,
    });

    expect(currentRecords).toEqual(original);
    expect(plan.replacement_semantics).toBe("complete_resource");
    expect(plan.preserved_records).toEqual([
      currentRecords[0],
      currentRecords[1],
      currentRecords[5],
    ]);
    expect(plan.removed_conflicts).toEqual([
      currentRecords[2],
      currentRecords[3],
      currentRecords[4],
    ]);
    expect(plan.added_records.slice(0, 2)).toEqual(
      HNS_ROOT_IMPORT_NAMESERVERS.map((ns) => ({ type: "NS", ns })),
    );
    expect(plan.added_records.slice(2)).toEqual([
      { type: "TXT", txt: ["pirate-verification=session_1"] },
      {
        type: "DS",
        keyTag: 10_875,
        algorithm: 13,
        digestType: 2,
        digest: "cd".repeat(32),
      },
      {
        type: "DS",
        keyTag: 10_875,
        algorithm: 13,
        digestType: 4,
        digest: "ab".repeat(48),
      },
    ]);
    expect(plan.replacement_records).toEqual([...plan.preserved_records, ...plan.added_records]);
    expect(plan.preserved_unknown_record_types).toEqual(["SYNTH4"]);
    expect(await hnsRootImportPublishPlanSha256V1(plan)).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("preserves duplicate and unknown records in their original order", () => {
    const records = [
      { type: "SYNTH6", address: "2001:db8::1" },
      { type: "SYNTH6", address: "2001:db8::1" },
      { type: "TXT", txt: ["unrelated"] },
    ] as const;
    const plan = buildHnsRootImportPublishPlanV1({
      current_records: records,
      challenge_txt_value: "pirate-verification=session_2",
      ds_records: dsRecords,
    });
    expect(plan.preserved_records).toEqual(records);
    expect(plan.preserved_unknown_record_types).toEqual(["SYNTH6"]);
  });

  test("rejects incomplete or mismatched DS pairs", () => {
    expect(() =>
      buildHnsRootImportPublishPlanV1({
        current_records: [],
        challenge_txt_value: "pirate-verification=session_3",
        ds_records: dsRecords.slice(0, 1),
      }),
    ).toThrow(HnsRootImportPlanError);
    expect(() =>
      buildHnsRootImportPublishPlanV1({
        current_records: [],
        challenge_txt_value: "pirate-verification=session_3",
        ds_records: [{ ...dsRecords[0], key_tag: 1 }, dsRecords[1]],
      }),
    ).toThrow(HnsRootImportPlanError);
  });

  test("accepts complete SHA-256 and SHA-384 pairs during a KSK rollover", () => {
    const plan = buildHnsRootImportPublishPlanV1({
      current_records: [],
      challenge_txt_value: "pirate-verification=rollover",
      ds_records: [
        ...dsRecords,
        { key_tag: 20_000, algorithm: 13, digest_type: 4, digest: "ef".repeat(48) },
        { key_tag: 20_000, algorithm: 13, digest_type: 2, digest: "ab".repeat(32) },
      ],
    });
    expect(plan.added_records.filter((record) => record.type === "DS")).toHaveLength(4);
  });

  test("rejects malformed challenge and current record inputs", () => {
    expect(() =>
      buildHnsRootImportPublishPlanV1({
        current_records: [],
        challenge_txt_value: "owner=wrong",
        ds_records: dsRecords,
      }),
    ).toThrow(HnsRootImportPlanError);
    expect(() =>
      buildHnsRootImportPublishPlanV1({
        current_records: [{ type: "txt", txt: ["invalid"] }],
        challenge_txt_value: "pirate-verification=session_4",
        ds_records: dsRecords,
      }),
    ).toThrow(HnsRootImportPlanError);
  });
});

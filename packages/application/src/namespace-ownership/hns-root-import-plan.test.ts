import { describe, expect, test } from "bun:test";
import {
  encodeHnsResourceV1,
  HNS_RESOURCE_MAX_WIRE_BYTES_V1,
  normalizedHnsResourceMultisetKeyV1,
} from "./hns-resource-codec.ts";
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
    const plan = await buildHnsRootImportPublishPlanV1({
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

  test("carries a plan-document hash distinct from the encoded-resource hash", async () => {
    const plan = await buildHnsRootImportPublishPlanV1({
      current_records: [],
      challenge_txt_value: "pirate-verification=session_1",
      ds_records: dsRecords,
    });
    const planDocumentSha256 = await hnsRootImportPublishPlanSha256V1(plan);
    expect(plan.encoded_resource_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(plan.encoded_resource_sha256).not.toBe(planDocumentSha256);
    // The encoded-resource hash is over the real HSD wire encoding of the
    // replacement records, not the plan document bytes.
    const encoded = encodeHnsResourceV1(plan.replacement_records);
    const encodedDigest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoded))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(encodedDigest).toBe(plan.encoded_resource_sha256);
    expect(encoded.byteLength).toBeLessThanOrEqual(HNS_RESOURCE_MAX_WIRE_BYTES_V1);
  });

  test("rejects a replacement whose real encoding exceeds the 512-byte consensus limit", async () => {
    await expect(
      buildHnsRootImportPublishPlanV1({
        current_records: [
          { type: "TXT", txt: ["a".repeat(253)] },
          { type: "TXT", txt: ["b".repeat(253)] },
        ],
        challenge_txt_value: "pirate-verification=session_5",
        ds_records: dsRecords,
      }),
    ).rejects.toThrow(HnsRootImportPlanError);
  });

  test("preserves duplicate and unknown records in their original order", async () => {
    const records = [
      { type: "SYNTH6", address: "2001:db8::1" },
      { type: "SYNTH6", address: "2001:db8::1" },
      { type: "TXT", txt: ["unrelated"] },
    ] as const;
    const plan = await buildHnsRootImportPublishPlanV1({
      current_records: records,
      challenge_txt_value: "pirate-verification=session_2",
      ds_records: dsRecords,
    });
    expect(plan.preserved_records).toEqual(records);
    expect(plan.preserved_unknown_record_types).toEqual(["SYNTH6"]);
  });

  test("preserves an existing matching Pirate delegation and DNSSEC key byte-for-byte", async () => {
    const records = [
      { type: "GLUE4", ns: "ns1.dankmeme.", address: "44.231.6.183" },
      { type: "NS", ns: "ns1.pirate." },
      { type: "TXT", txt: ["pirate-verification=previous"] },
      {
        type: "DS",
        keyTag: 10_875,
        algorithm: 13,
        digestType: 4,
        digest: "AB".repeat(48),
      },
      { type: "NS", ns: "ns2.pirate." },
      {
        type: "DS",
        keyTag: 10_875,
        algorithm: 13,
        digestType: 2,
        digest: "CD".repeat(32),
      },
    ] as const;
    const plan = await buildHnsRootImportPublishPlanV1({
      current_records: records,
      challenge_txt_value: "pirate-verification=current",
      ds_records: dsRecords,
    });

    expect(plan.preserved_records).toEqual([
      records[0],
      records[1],
      records[3],
      records[4],
      records[5],
    ]);
    expect(plan.removed_conflicts).toEqual([records[2]]);
    expect(plan.added_records).toEqual([{ type: "TXT", txt: ["pirate-verification=current"] }]);
    expect(plan.replacement_records).toEqual([
      records[0],
      records[1],
      records[3],
      records[4],
      records[5],
      { type: "TXT", txt: ["pirate-verification=current"] },
    ]);
  });

  test("rejects incomplete or mismatched DS pairs", async () => {
    await expect(
      buildHnsRootImportPublishPlanV1({
        current_records: [],
        challenge_txt_value: "pirate-verification=session_3",
        ds_records: dsRecords.slice(0, 1),
      }),
    ).rejects.toThrow(HnsRootImportPlanError);
    await expect(
      buildHnsRootImportPublishPlanV1({
        current_records: [],
        challenge_txt_value: "pirate-verification=session_3",
        ds_records: [{ ...dsRecords[0], key_tag: 1 }, dsRecords[1]],
      }),
    ).rejects.toThrow(HnsRootImportPlanError);
  });

  test("accepts complete SHA-256 and SHA-384 pairs during a KSK rollover", async () => {
    const plan = await buildHnsRootImportPublishPlanV1({
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

  test("rejects malformed challenge and current record inputs", async () => {
    await expect(
      buildHnsRootImportPublishPlanV1({
        current_records: [],
        challenge_txt_value: "owner=wrong",
        ds_records: dsRecords,
      }),
    ).rejects.toThrow(HnsRootImportPlanError);
    await expect(
      buildHnsRootImportPublishPlanV1({
        current_records: [{ type: "txt", txt: ["invalid"] }],
        challenge_txt_value: "pirate-verification=session_4",
        ds_records: dsRecords,
      }),
    ).rejects.toThrow(HnsRootImportPlanError);
  });

  test("normalizes order, case, and canonicalization while retaining multiplicity", () => {
    const left = [
      { type: "NS", ns: "NS2.pirate." },
      { type: "DS", keyTag: 1, algorithm: 13, digestType: 2, digest: "AB".repeat(32) },
      { type: "TXT", txt: ["same"] },
    ];
    const right = [
      { type: "TXT", txt: ["same"] },
      { type: "DS", keyTag: 1, algorithm: 13, digestType: 2, digest: "ab".repeat(32) },
      { type: "NS", ns: "ns2.pirate" },
    ];
    expect(normalizedHnsResourceMultisetKeyV1(left)).toBe(
      normalizedHnsResourceMultisetKeyV1(right),
    );
    const [firstRecord] = left;
    if (firstRecord === undefined) throw new Error("fixture incomplete");
    const duplicated = [...left, firstRecord];
    expect(normalizedHnsResourceMultisetKeyV1(duplicated)).not.toBe(
      normalizedHnsResourceMultisetKeyV1(left),
    );
    const changed = [
      { type: "NS", ns: "ns2.pirate." },
      { type: "DS", keyTag: 1, algorithm: 13, digestType: 2, digest: "ac".repeat(32) },
      { type: "TXT", txt: ["same"] },
    ];
    expect(normalizedHnsResourceMultisetKeyV1(changed)).not.toBe(
      normalizedHnsResourceMultisetKeyV1(left),
    );
    const canonicalAddress = [{ type: "SYNTH6", address: "2001:0db8:0000::1" }];
    const equivalentAddress = [{ type: "SYNTH6", address: "2001:db8::1" }];
    expect(normalizedHnsResourceMultisetKeyV1(canonicalAddress)).toBe(
      normalizedHnsResourceMultisetKeyV1(equivalentAddress),
    );
  });
});

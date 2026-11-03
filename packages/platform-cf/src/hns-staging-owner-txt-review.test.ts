import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalJson } from "@pirate/domain";
import {
  type HnsStagingOwnerTxtRecovery,
  requireHnsStagingOwnerTxtReview,
} from "./hns-staging-owner-txt-review.ts";

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const txtHash = (value: string) => createHash("sha256").update(value).digest("hex");
const oldTxt = { type: "TXT", txt: ["pirate-verification=", "old"] };
const newTxt = { type: "TXT", txt: ["pirate-verification=new"] };
const delegation = [
  { type: "NS", ns: "ns1.newroot." },
  { type: "DS", keyTag: 7, algorithm: 13, digestType: 2, digest: "ab".repeat(32) },
  { type: "TXT", txt: ["unrelated=keep", "-chunks"] },
];
const previous = [delegation[0], oldTxt, ...delegation.slice(1)];
const next = [delegation[0], newTxt, ...delegation.slice(1)];
const review = {
  version: "hns-reviewed-staging-owner-txt-v1",
  root_label: "newroot",
  community_id: "community-root",
  route_binding_id: "route-root",
  binding_generation: 3,
  evidence_ref: "new-evidence",
  recovery_attempt_id: "recovery-attempt",
  dns_zone_activation_id: "dns-root",
  app_host_activation_id: "app-root",
  app_generation: 2,
  sale_namespace_activation_id: "sale-root",
  sale_generation: 2,
  previous_generation: 25,
  previous_health_generation: 2,
  previous_chain_records: previous,
  chain_records: next,
};
const recovery: HnsStagingOwnerTxtRecovery = {
  community_id: review.community_id,
  route_binding_id: review.route_binding_id,
  binding_generation: "3",
  evidence_ref: review.evidence_ref,
  recovery_attempt_id: review.recovery_attempt_id,
  dns_zone_activation_id: review.dns_zone_activation_id,
  app_host_activation_id: review.app_host_activation_id,
  app_generation: "2",
  sale_namespace_activation_id: review.sale_namespace_activation_id,
  sale_generation: "2",
  root_label: "newroot",
  previous_txt_sha256: txtHash("pirate-verification=old"),
  txt_sha256: txtHash("pirate-verification=new"),
  expires_at: new Date("2026-10-29T00:00:00Z"),
};
const input = {
  review,
  recovery,
  predecessor: {
    environment: "staging",
    root_label: "newroot",
    generation: 25,
    health_generation: 2,
    chain_reference: `hns-root-chain:${hash(previous)}`,
  },
  observed_chain_sha256: hash(next),
  database_time: Date.parse("2026-10-28T00:00:00Z"),
};

describe("reviewed staging owner TXT continuity", () => {
  test("replaces one complete TXT record using joined chunk identities", () => {
    expect(() => requireHnsStagingOwnerTxtReview(input)).not.toThrow();
  });
  test.each([
    ["delegation", [newTxt, { type: "NS", ns: "other." }, ...delegation.slice(1)]],
    ["record order", [newTxt, delegation[0], ...delegation.slice(1)]],
    [
      "unrelated TXT chunks",
      [delegation[0], newTxt, delegation[1], { type: "TXT", txt: ["unrelated=keep-chunks"] }],
    ],
    ["duplicate challenge", [...next, newTxt]],
    ["old challenge retained", [...next, oldTxt]],
    ["challenge appended rather than replaced", [...previous, newTxt]],
  ] as const)(
    "refuses %s even when the observed hash matches the proposed resource",
    (_, records) => {
      expect(() =>
        requireHnsStagingOwnerTxtReview({
          ...input,
          review: { ...review, chain_records: records },
          observed_chain_sha256: hash(records),
        }),
      ).toThrow("unreviewed chain records");
    },
  );
  test.each([
    { community_id: "other" },
    { route_binding_id: "other" },
    { binding_generation: 4 },
    { evidence_ref: "other" },
    { recovery_attempt_id: "other" },
    { root_label: "other" },
    { dns_zone_activation_id: "other" },
    { app_generation: 3 },
    { sale_generation: 3 },
    { app_host_activation_id: "other" },
    { sale_namespace_activation_id: "other" },
    { previous_generation: 24 },
    { previous_health_generation: 1 },
  ])("refuses a review detached from its exact recovery or DNS predecessor: %j", (patch) => {
    expect(() =>
      requireHnsStagingOwnerTxtReview({ ...input, review: { ...review, ...patch } }),
    ).toThrow("fence changed");
  });
  test("refuses stale, duplicate or unchanged prior control identities", () => {
    for (const proof of [
      { ...recovery, expires_at: new Date(input.database_time) },
      { ...recovery, txt_sha256: recovery.previous_txt_sha256 },
      { ...recovery, previous_txt_sha256: txtHash("another-control") },
    ])
      expect(() => requireHnsStagingOwnerTxtReview({ ...input, recovery: proof })).toThrow();
    const repeated = [...previous, oldTxt];
    expect(() =>
      requireHnsStagingOwnerTxtReview({
        ...input,
        review: { ...review, previous_chain_records: repeated },
        predecessor: { ...input.predecessor, chain_reference: `hns-root-chain:${hash(repeated)}` },
      }),
    ).toThrow("unreviewed chain records");
  });
  test("refuses production, wrong hashes and an untyped policy waiver", () => {
    for (const patch of [
      { predecessor: { ...input.predecessor, environment: "production" } },
      {
        predecessor: { ...input.predecessor, chain_reference: `hns-root-chain:${"ff".repeat(32)}` },
      },
      { observed_chain_sha256: "ff".repeat(32) },
      { review: { ...review, allow_chain_change: true } },
    ])
      expect(() => requireHnsStagingOwnerTxtReview({ ...input, ...patch })).toThrow();
  });
});

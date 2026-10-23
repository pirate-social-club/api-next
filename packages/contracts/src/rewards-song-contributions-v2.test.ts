import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { generateClient } from "./codegen.ts";
import {
  CancellationReceiptV2,
  CancellationRecoveryPolicyV2,
  ContributionRequestV2,
  CreateSongMegapotContributionV2,
  cancellationInstructionPreimageV2,
  cancellationPolicyPreimageV2,
  committedTermsPreimageV2,
  decodeFundingCommandJsonV2,
  decodeFundingCommandV2,
  fundingCommandPreimageV2,
  ProspectiveTermsV2,
  prospectiveTermsPreimageV2,
  SubmissionClaimDeliveryV2,
  TermsV2,
} from "./rewards-song-contributions-v2.ts";

// Exact fictional vectors from accepted V5, not live financial configuration.
const fixture = {
  request: {
    version: 2 as const,
    idempotency_key: "fixture_create_key_0001",
    persona_id: "fixture-persona-a",
    funding_amount_atomic: "1000000",
    expected_context_hash: "47e14f282256168eac75d25ceeae2fe1e77eb4ad4d1c484bf9519b4539adc352",
    expected_lifecycle_revision: 0,
    context_version: "funding-context-reference-v1" as const,
    context_slot_id: "fixture-slot",
    context_slot_generation: 0,
    context_leg_snapshot_id: "",
    context_schedule_witness_id: "fixture-witness",
    context_profile_id: "fixture-profile",
    context_profile_hash: "a4ed102f029f8b3f5d49ca9fe64c131c017e3471a0d388fa65bfeb4db10b97dc",
    context_funding_policy_hash: "1bb42413cfc2fe292c95fcab0e62436a54199ffce08360a33d789aa12773dac6",
    context_wallet_assignment_id: "fixture-wallet",
    context_wallet_assignment_revision: 1,
    context_lifecycle_revision: 0,
    expected_terms_kind: "prospective" as const,
    expected_terms_hash: "4d0d1092962c36cec741a0316c79f87de7898669b9d3d4eb65b364219c2eed3d",
  },
  prospectus: {
    version: "shared-song-megapot-prospectus-v1",
    target: {
      community_id: "fixture-community",
      post_id: "fixture-song-post",
      canonical_song_id: "fixture-canonical-song",
      audio_revision: 1,
    },
    profile_id: "fixture-profile",
    profile_hash: "a4ed102f029f8b3f5d49ca9fe64c131c017e3471a0d388fa65bfeb4db10b97dc",
    funding_policy_revision: 1,
    funding_policy_hash: "1bb42413cfc2fe292c95fcab0e62436a54199ffce08360a33d789aa12773dac6",
    reward_policy_template_hash: "a0cd51067000c5186cb2730e726f74f5c83fd854616e591f7afa0b65f54537ba",
    start_rule: "allocation_linearization_time",
    budget_source: "leg_budget",
    empty_behavior: "no_purchase",
    eligible_activities: ["study", "karaoke", "dance"],
    dance_scope: "any_policy_accepted",
    qualification_templates: [
      {
        template_key: "fixture-template-study",
        activity: "study",
        grading_family: "numeric",
        qualification_policy_id: "fixture-policy-study",
        qualification_policy_hash:
          "554bc9235abe7225d53bed756c3160310aad25a87f9d9b78d0ed4803c48aba54",
        numeric_floor_bps: 7000,
        choreography_scope: "not_applicable",
        admission_id: "fixture-admission-study",
        admission_hash: "70332f4dfab8eed9a2d748e63120bdf1f2f9e81fcf0fe42c167b1e6754042a88",
        disclosure_version: "fixture-disclosure",
      },
      {
        template_key: "fixture-template-karaoke",
        activity: "karaoke",
        grading_family: "numeric",
        qualification_policy_id: "fixture-policy-karaoke",
        qualification_policy_hash:
          "77daf062a46a206f001d73e762f92a436570aacc9b6cd31f6a7c904a99b4774b",
        numeric_floor_bps: 7000,
        choreography_scope: "not_applicable",
        admission_id: "fixture-admission-karaoke",
        admission_hash: "038b8168ce17be82369ef9211c2f1d9c33edf1227e05fb47e88d2365084993c9",
        disclosure_version: "fixture-disclosure",
      },
      {
        template_key: "fixture-template-dance",
        activity: "dance",
        grading_family: "moderator_verdict",
        qualification_policy_id: "fixture-policy-dance",
        qualification_policy_hash:
          "d492a8a0394e718c4ae5a8195713dc8f5392aceded39ceda00544361f189c5ce",
        numeric_floor_bps: null,
        choreography_scope: "any_policy_accepted",
        admission_id: "fixture-admission-dance",
        admission_hash: "1d81efad71c0ca76bbb80302db9171ab196c451a7215b3517bf127b1f2205f36",
        disclosure_version: "fixture-disclosure",
      },
    ],
    fixed_ends_at: "2026-10-18T14:00:00.000Z",
    first_drawing_id: "101",
    last_planned_drawing_id: "101",
    planned_drawing_ids: ["101"],
    planned_schedule_hash: "d12eabade5e1ef732861ea6d571e133aaced4390acca64c472eb159e2b77e982",
    ticket_price_ceiling_atomic: "1000000",
    disclosure_version: "fixture-disclosure",
  },
  terms: {
    version: "shared-song-megapot-v2",
    profile_id: "fixture-profile",
    profile_hash: "a4ed102f029f8b3f5d49ca9fe64c131c017e3471a0d388fa65bfeb4db10b97dc",
    terms_hash: "193803d32724c8a8e7be7f973b9dd757e55b829445dfb6d22225a1bbd934592b",
    funding_policy_revision: 1,
    funding_policy_hash: "1bb42413cfc2fe292c95fcab0e62436a54199ffce08360a33d789aa12773dac6",
    budget_source: "leg_budget",
    empty_behavior: "no_purchase",
    eligible_activities: ["study", "karaoke", "dance"],
    dance_scope: "any_policy_accepted",
    starts_at: "2026-10-18T13:00:10.000Z",
    ends_at: "2026-10-18T14:00:00.000Z",
    first_drawing_id: "101",
    last_planned_drawing_id: "101",
    ticket_price_ceiling_atomic: "1000000",
    disclosure_version: "fixture-disclosure",
    origin_prospective_terms_hash:
      "4d0d1092962c36cec741a0316c79f87de7898669b9d3d4eb65b364219c2eed3d",
    origin_slot_generation: 0,
    reward_policy_hash: "d877db814f56439fa0540cf8da2468bbab800af912f0700526d622ecfde11e81",
    qualification_bindings: [
      {
        template_key: "fixture-template-study",
        activity: "study",
        grading_family: "numeric",
        qualification_policy_id: "fixture-policy-study",
        qualification_policy_hash:
          "554bc9235abe7225d53bed756c3160310aad25a87f9d9b78d0ed4803c48aba54",
        numeric_floor_bps: 7000,
        choreography_scope: "not_applicable",
        admission_id: "fixture-admission-study",
        admission_hash: "70332f4dfab8eed9a2d748e63120bdf1f2f9e81fcf0fe42c167b1e6754042a88",
        disclosure_version: "fixture-disclosure",
        binding_id: "fixture-binding-study",
        objective_id: "fixture-objective-study",
        offer_id: "fixture-offer",
        leg_id: "fixture-leg",
      },
      {
        template_key: "fixture-template-karaoke",
        activity: "karaoke",
        grading_family: "numeric",
        qualification_policy_id: "fixture-policy-karaoke",
        qualification_policy_hash:
          "77daf062a46a206f001d73e762f92a436570aacc9b6cd31f6a7c904a99b4774b",
        numeric_floor_bps: 7000,
        choreography_scope: "not_applicable",
        admission_id: "fixture-admission-karaoke",
        admission_hash: "038b8168ce17be82369ef9211c2f1d9c33edf1227e05fb47e88d2365084993c9",
        disclosure_version: "fixture-disclosure",
        binding_id: "fixture-binding-karaoke",
        objective_id: "fixture-objective-karaoke",
        offer_id: "fixture-offer",
        leg_id: "fixture-leg",
      },
      {
        template_key: "fixture-template-dance",
        activity: "dance",
        grading_family: "moderator_verdict",
        qualification_policy_id: "fixture-policy-dance",
        qualification_policy_hash:
          "d492a8a0394e718c4ae5a8195713dc8f5392aceded39ceda00544361f189c5ce",
        numeric_floor_bps: null,
        choreography_scope: "any_policy_accepted",
        admission_id: "fixture-admission-dance",
        admission_hash: "1d81efad71c0ca76bbb80302db9171ab196c451a7215b3517bf127b1f2205f36",
        disclosure_version: "fixture-disclosure",
        binding_id: "fixture-binding-dance",
        objective_id: "fixture-objective-dance",
        offer_id: "fixture-offer",
        leg_id: "fixture-leg",
      },
    ],
    qualification_bindings_hash: "f1db724c9fff1192044f87e861cebbb09cb69da42cfe5f9653be59cc33490dd0",
    planned_drawing_ids: ["101"],
    planned_schedule_hash: "d12eabade5e1ef732861ea6d571e133aaced4390acca64c472eb159e2b77e982",
  },
  cancel: {
    object: "contribution_cancellation_command_receipt",
    version: 2,
    command_id: "fixture-cancel-command-1",
    request_hash: "6f2e8c50aba9de435746b91cf418847e62f4b9c5a844bee067669e9fb4e3e153",
    contribution_id: "fixture-contribution",
    chain_id: 84532,
    sender: "0x1111111111111111111111111111111111111111",
    recipient: "0x1111111111111111111111111111111111111111",
    nonce: "7",
    value_atomic: "0",
    data: "0x",
    instruction_hash: "09efa8a8d7ddf8b23b6663d637e7b161ed939cfceed62d08d01a2087aaa2678b",
    current_state_href:
      "/communities/fixture-community/posts/fixture-song-post/megapot-contributions/fixture-contribution",
    purpose: "nonce_cancellation",
    preparation_id: "fixture-cancel-plan-1",
    preparation_revision: 1,
    previous_preparation_id: null,
    previous_preparation_instruction_hash: null,
    prepared_state_revision: 4,
    prepared_at: "2026-10-18T14:20:00.000Z",
    dispatch_expires_at: "2026-10-18T14:23:00.000Z",
    original_funding_instruction_hash:
      "4c25e5532b6f8b2a33d5b3d61eaf759f87cc520af34ca2704031678d6d9c5a74",
    recovery_policy_id: "fixture-recovery-policy",
    recovery_policy_hash: "aac2afb21c6adb4dd242ee7273d692f0087813ff96ab8956b5d7b7f18a46030b",
    recovery_attestation_id: "fixture-recovery-attestation-1",
    recovery_attestation_hash: "eba597ccfb49f56c4340944437ecf9060449c23297c51013b8dc9997c2b7cf3d",
    recovery_attestation_valid_until: "2026-10-18T14:30:00.000Z",
    fee_policy_id: "fixture-fee-policy",
    fee_policy_hash: "7246b3571ad5228ea98f410d9947ef7c31f9a99463d0bd1ae17df0ad7428a4c9",
    wallet_assignment_id: "fixture-wallet",
    wallet_index: 0,
  },
  policy: {
    object: "nonce_cancellation_recovery_policy",
    version: "nonce-cancellation-recovery-v1",
    policy_id: "fixture-recovery-policy",
    policy_hash: "aac2afb21c6adb4dd242ee7273d692f0087813ff96ab8956b5d7b7f18a46030b",
    chain_id: 84532,
    valid_from: "2026-10-18T14:00:00.000Z",
    valid_until: "2026-10-18T16:00:00.000Z",
    dispatch_ttl_seconds: 180,
    max_preparations_per_contribution: 2,
    fee_policy_id: "fixture-fee-policy",
    fee_policy_hash: "7246b3571ad5228ea98f410d9947ef7c31f9a99463d0bd1ae17df0ad7428a4c9",
    attestation_contract_version: "fixture-recovery-attestation-v1",
  },
  delivery: {
    receipt: {
      object: "contribution_submission_claim_receipt",
      version: 2,
      command_id: "fixture-cancel-claim-command-1",
      request_hash: "9cfaa9fe09b785f366bb75d9c7f2e2052819b7d7c6ee5abaa74a4035c0afde4a",
      contribution_id: "fixture-contribution",
      instruction_hash: "09efa8a8d7ddf8b23b6663d637e7b161ed939cfceed62d08d01a2087aaa2678b",
      purpose: "nonce_cancellation",
      grant_id: "fixture-cancel-grant-1",
      grant_revision: 5,
      holder_client_instance_id: "fixture_cancel_client_instance_001",
      submission_attempt_id: "fixture_cancel_attempt_001",
      claimed_at: "2026-10-18T14:20:05.000Z",
      valid_until: "2026-10-18T14:23:00.000Z",
      current_state_href:
        "/communities/fixture-community/posts/fixture-song-post/megapot-contributions/fixture-contribution",
      cancellation_preparation_id: "fixture-cancel-plan-1",
      cancellation_preparation_revision: 1,
    },
    delivery: {
      kind: "fresh_grant",
      replayed: false,
    },
  },
};
const hash = async (s: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
describe("V5 funding command boundary", () => {
  test("exact V5 canonical hash vectors, no allocated start in prospectus", async () => {
    const req = Schema.decodeUnknownSync(ContributionRequestV2)(fixture.request);
    expect(
      await hash(
        fundingCommandPreimageV2(
          "CreateSongMegapotContributionV2",
          "fixture-account-a",
          "fixture-community",
          "fixture-song-post",
          null,
          req,
        ),
      ),
    ).toBe("9c77e5a87aad695b9413324d1ab3bc75cc50e30f70f8f52560aba35b15b3020a");
    expect(
      await hash(
        prospectiveTermsPreimageV2(
          Schema.decodeUnknownSync(ProspectiveTermsV2)(fixture.prospectus),
        ),
      ),
    ).toBe("4d0d1092962c36cec741a0316c79f87de7898669b9d3d4eb65b364219c2eed3d");
    expect(
      await hash(committedTermsPreimageV2(Schema.decodeUnknownSync(TermsV2)(fixture.terms))),
    ).toBe(fixture.terms.terms_hash);
    expect(
      await hash(
        cancellationInstructionPreimageV2(
          Schema.decodeUnknownSync(CancellationReceiptV2)(fixture.cancel),
        ),
      ),
    ).toBe(fixture.cancel.instruction_hash);
    expect(
      await hash(
        cancellationPolicyPreimageV2(
          Schema.decodeUnknownSync(CancellationRecoveryPolicyV2)(fixture.policy),
        ),
      ),
    ).toBe(fixture.policy.policy_hash);
  });
  test("canonical pair order ignores object insertion order, preserves actor/path/key scope", () => {
    const req = Schema.decodeUnknownSync(ContributionRequestV2)(fixture.request);
    const first = fundingCommandPreimageV2(
      "CreateSongMegapotContributionV2",
      "account",
      "community",
      "post",
      null,
      req,
    );
    const reordered = Object.fromEntries(Object.entries(fixture.request).reverse());
    expect(
      fundingCommandPreimageV2(
        "CreateSongMegapotContributionV2",
        "account",
        "community",
        "post",
        null,
        decodeFundingCommandV2("CreateSongMegapotContributionV2", reordered),
      ),
    ).toBe(first);
    expect(
      fundingCommandPreimageV2(
        "CreateSongMegapotContributionV2",
        "other",
        "community",
        "post",
        null,
        req,
      ),
    ).not.toBe(first);
    expect(() =>
      fundingCommandPreimageV2(
        "CreateSongMegapotContributionV2",
        "account",
        "community",
        "post",
        "unexpected",
        req,
      ),
    ).toThrow();
  });
  test("strict positive uint256 atomic decoding precedes allocation", () => {
    for (const amount of [
      "0",
      "-1",
      "+1",
      "01",
      "1.0",
      "1e3",
      " 1",
      "1 ",
      (1n << 256n).toString(),
      1,
      1.5,
    ]) {
      expect(() =>
        decodeFundingCommandV2("CreateSongMegapotContributionV2", {
          ...fixture.request,
          funding_amount_atomic: amount,
        }),
      ).toThrow();
    }
    expect(
      decodeFundingCommandV2("CreateSongMegapotContributionV2", {
        ...fixture.request,
        funding_amount_atomic: ((1n << 256n) - 1n).toString(),
      }).funding_amount_atomic,
    ).toBe(((1n << 256n) - 1n).toString());
  });
  test("unknown nested keys, routine/owner selectors and conflicting quote branches refuse", () => {
    for (const body of [
      { ...fixture.request, owner_only: true },
      { ...fixture.request, routine_id: "routine" },
      { ...fixture.request, context_ref: { secret: "x" } },
      {
        ...fixture.request,
        context_leg_snapshot_id: "leg",
      },
    ]) {
      expect(() => decodeFundingCommandV2("CreateSongMegapotContributionV2", body)).toThrow();
    }
    expect(
      decodeFundingCommandV2("CreateSongMegapotContributionV2", {
        ...fixture.request,
        persona_id: "κοινότητα",
      }).persona_id,
    ).toBe("κοινότητα");
  });
  test("raw duplicate and escaped duplicate keys are rejected before evidence is lost", () => {
    const text = JSON.stringify(fixture.request);
    const decode = (s: string) =>
      decodeFundingCommandJsonV2("CreateSongMegapotContributionV2", s, {
        maxBytes: 10000,
        maxDepth: 10,
      });
    expect(decode(text)).toEqual(Schema.decodeUnknownSync(ContributionRequestV2)(fixture.request));
    expect(() => decode(text.replace('"version":2', '"version":2,"version":2'))).toThrow();
    expect(() => decode(text.replace('"version":2', '"version":2,"\\u0076ersion":2'))).toThrow();
    expect(() =>
      decode(
        text.replace(
          '"context_slot_generation":0',
          '"context_slot_generation":0,"context_slot_generation":0',
        ),
      ),
    ).toThrow();
    expect(() =>
      decodeFundingCommandJsonV2("CreateSongMegapotContributionV2", text, {
        maxBytes: 10,
        maxDepth: 10,
      }),
    ).toThrow();
    expect(
      decodeFundingCommandJsonV2("CreateSongMegapotContributionV2", text, {
        maxBytes: 10000,
        maxDepth: 1,
      }),
    ).toEqual(fixture.request);
    expect(() =>
      decodeFundingCommandJsonV2(
        "CreateSongMegapotContributionV2",
        JSON.stringify({ ...fixture.request, nested: { value: 1 } }),
        { maxBytes: 10000, maxDepth: 1 },
      ),
    ).toThrow("JSON depth exceeded");
  });
  test("categorical Dance has null score, binding hash has no self dependency", () => {
    const terms = structuredClone(fixture.terms);
    const dance = terms.qualification_bindings[2];
    if (dance === undefined) throw new Error("Missing Dance fixture");
    dance.numeric_floor_bps = 7000;
    expect(() => Schema.decodeUnknownSync(TermsV2, { onExcessProperty: "error" })(terms)).toThrow();
    expect(
      Schema.decodeUnknownSync(TermsV2)(fixture.terms).qualification_bindings[2]?.numeric_floor_bps,
    ).toBeNull();
  });
  test("cancellation binds same sender and immutable history links; delivery kinds stay separate", () => {
    expect(() =>
      Schema.decodeUnknownSync(CancellationReceiptV2)({
        ...fixture.cancel,
        recipient: `0x${"2".repeat(40)}`,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CancellationReceiptV2)({
        ...fixture.cancel,
        preparation_revision: 2,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CancellationReceiptV2)({
        ...fixture.cancel,
        dispatch_expires_at: fixture.cancel.prepared_at,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SubmissionClaimDeliveryV2)({
        ...fixture.delivery,
        delivery: { kind: "fresh_grant", replayed: true },
      }),
    ).toThrow();
  });
});

describe("scalar exact JSON funding wire", () => {
  test("every movable authority scalar remains bound to the original V5 hash domain", () => {
    const preimage = (body: unknown) =>
      fundingCommandPreimageV2(
        "CreateSongMegapotContributionV2",
        "account",
        "community",
        "post",
        null,
        decodeFundingCommandV2("CreateSongMegapotContributionV2", body),
      );
    const original = preimage(fixture.request);
    for (const change of [
      { context_slot_id: "different-slot" },
      { context_slot_generation: 1 },
      { context_schedule_witness_id: "different-witness" },
      { context_profile_id: "different-profile" },
      { context_profile_hash: "f".repeat(64) },
      { context_funding_policy_hash: "f".repeat(64) },
      { context_wallet_assignment_id: "different-wallet" },
      { context_wallet_assignment_revision: 2 },
      { context_lifecycle_revision: 1 },
      { expected_lifecycle_revision: 1 },
      { expected_terms_hash: "f".repeat(64) },
      { expected_context_hash: "f".repeat(64) },
      { persona_id: "different-persona" },
      { funding_amount_atomic: "2000000" },
      { context_leg_snapshot_id: "committed-snapshot", expected_terms_kind: "committed" },
    ])
      expect(preimage({ ...fixture.request, ...change })).not.toBe(original);
    for (const change of [
      { context_leg_snapshot_id: null },
      { context_leg_snapshot_id: " " },
      { context_version: "different" },
      { context_slot_generation: "0" },
    ])
      expect(() => preimage({ ...fixture.request, ...change })).toThrow();
  });
  test("maintained client serializes the real scalar command canonically, refuses missing/excess keys before fetch and never retries unknown transport", async () => {
    const source = generateClient({ CreateSongMegapotContributionV2 });
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
    const generated = await import(`data:text/javascript;base64,${btoa(js)}`);
    const sent: string[] = [];
    const unknown = new Error("offline lost response");
    const client = generated.createPirateApiClient("https://fixture.invalid", {
      fetchImpl: async (_url: unknown, init: RequestInit) => {
        sent.push(String(init.body));
        throw unknown;
      },
    });
    const invoke = Object.values(client)[0];
    if (typeof invoke !== "function") throw new Error("Missing generated contribution method");
    const body = Object.fromEntries(Object.entries(fixture.request).reverse());
    const input = { path: { communityId: "community", postId: "post" }, body };
    await expect(invoke(input)).rejects.toBe(unknown);
    expect(sent).toEqual([JSON.stringify(fixture.request)]);
    expect(
      decodeFundingCommandJsonV2("CreateSongMegapotContributionV2", sent[0] ?? "", {
        maxBytes: 10000,
        maxDepth: 1,
      }),
    ).toEqual(fixture.request);
    const missing = { ...body };
    delete missing.context_profile_hash;
    for (const invalid of [
      missing,
      { ...body, owner_only: false },
      { ...body, context_ref: { slot_id: "nested" } },
    ])
      await expect(invoke({ ...input, body: invalid })).rejects.toMatchObject({
        _tag: "ApiClientProtocolError",
      });
    expect(sent).toHaveLength(1);
  });
});

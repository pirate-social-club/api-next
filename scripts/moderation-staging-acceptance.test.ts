import { describe, expect, test } from "bun:test";
import {
  type AcceptanceEvidence,
  verifyModerationStagingEvidence,
} from "./moderation-staging-acceptance";

const locked = {
  kind: "age_locked",
  content_rating: "adult_18",
  next_action: { kind: "verify_minimum_age", minimum_age: 18 },
} as const;

const validEvidence = (): AcceptanceEvidence => ({
  origin: "https://pirate-http-worker-staging.workers.dev",
  attestation: { before_restricted_status: 403, after_attestation_status: 200 },
  locked_resources: [locked, locked, locked],
  rating_ancestry: {
    parent_rating: "adult_18",
    child_rating: "adult_18",
    raised_parent_rating: "adult_18",
    raised_descendant_ratings: ["adult_18", "adult_18"],
  },
  prospectivity: {
    evaluation_revision_before_policy_change: "policy-v1",
    evaluation_revision_after_policy_change: "policy-v1",
  },
  legacy_action: {
    fresh_status: 409,
    fresh_reason_code: "contract_version_unsupported",
    committed_body: { action: "reject", case_ref: "case-1" },
    replay_body: { case_ref: "case-1", action: "reject" },
  },
  authority: { owner_status: 200, non_owner_status: 404 },
  text_provider: {
    clean_status: "published",
    flagged_status: "manual_review",
    disabled_status: "manual_review",
  },
  cover: {
    clean_artifact_projected: true,
    withheld_artifact_ref: null,
    withheld_public_fetch_status: 404,
  },
});

describe("moderation staging acceptance evidence", () => {
  test("accepts the complete owner-only backend proof and emits no raw evidence", () => {
    const result = verifyModerationStagingEvidence(validEvidence());
    expect(result).toEqual({
      environment: "staging",
      checks: 18,
      evidence_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test("refuses production and non-HTTPS targets", () => {
    expect(() =>
      verifyModerationStagingEvidence({ ...validEvidence(), origin: "https://api.example.com" }),
    ).toThrow("explicit staging Worker");
    expect(() =>
      verifyModerationStagingEvidence({
        ...validEvidence(),
        origin: "http://pirate-http-worker-staging.workers.dev",
      }),
    ).toThrow("explicit staging Worker");
  });

  test("rejects a placeholder carrying content or engagement metadata", () => {
    expect(() =>
      verifyModerationStagingEvidence({
        ...validEvidence(),
        locked_resources: [{ ...locked, title: "leak" }, locked, locked],
      }),
    ).toThrow("exactly the three ratified fields");
  });

  test("pins the attestation, ancestry, prospectivity, compatibility, and authority fences", () => {
    const mutations: AcceptanceEvidence[] = [
      {
        ...validEvidence(),
        attestation: { before_restricted_status: 200, after_attestation_status: 200 },
      },
      {
        ...validEvidence(),
        rating_ancestry: { ...validEvidence().rating_ancestry, child_rating: "general" },
      },
      {
        ...validEvidence(),
        prospectivity: {
          evaluation_revision_before_policy_change: "v1",
          evaluation_revision_after_policy_change: "v2",
        },
      },
      {
        ...validEvidence(),
        legacy_action: { ...validEvidence().legacy_action, fresh_status: 200 },
      },
      { ...validEvidence(), authority: { owner_status: 200, non_owner_status: 403 } },
    ];
    for (const evidence of mutations)
      expect(() => verifyModerationStagingEvidence(evidence)).toThrow();
  });

  test("pins provider failure and both cover leak boundaries", () => {
    expect(() =>
      verifyModerationStagingEvidence({
        ...validEvidence(),
        text_provider: {
          ...validEvidence().text_provider,
          disabled_status: "published" as "manual_review",
        },
      }),
    ).toThrow("provider");
    expect(() =>
      verifyModerationStagingEvidence({
        ...validEvidence(),
        cover: { ...validEvidence().cover, withheld_public_fetch_status: 200 as 404 },
      }),
    ).toThrow("Cover");
  });
});

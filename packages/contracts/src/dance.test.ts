import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { generateClient, generateOpenApi, schemaToOpenApi } from "./codegen.ts";
import {
  AppendDanceChoreographyRevision,
  ClearSongDancePresentation,
  CreateDanceChoreography,
  DanceChoreographyPublicRevisionV1,
  DanceChoreographyV1,
  DanceReferenceProcessingV1,
  DanceSegmentBoundsV1,
  DisableDanceChoreography,
  GetDanceChoreographyProcessing,
  GetDanceChoreographyRevision,
  ListReadyDanceChoreographies,
  RetireDanceChoreography,
  SetSongDancePresentation,
} from "./dance.ts";
import { registry } from "./registry.ts";
import { ActivityQualificationV1, QualifyingActivityV1 } from "./rewards-qualification.ts";
import { AddMegapotPoolLeg, RewardActivityV1 } from "./rewards-song-offers.ts";

const strict = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" });

const sha = (character: string): string => character.repeat(64);

const segment = {
  segment_id: "segment_1",
  song_post_id: "post_1",
  audio_revision: 3,
  start_ms: 1_000,
  end_ms: 7_000,
  duration_ms: 6_000,
  canonical_segment_sha256: sha("a"),
  extraction_policy_version: "dance-segment-v1",
  segment_terms_hash: sha("b"),
} as const;

const publicRevision = {
  object: "dance_choreography_revision",
  choreography_id: "choreography_1",
  revision: 1,
  song_post_id: "post_1",
  audio_revision: 3,
  segment,
  readiness: "ready",
  mirror_policy: "allowed",
  reference_video: { post_id: "video_post_1", href: "/posts/video_post_1" },
  creator_persona: {
    persona_id: "persona_1",
    object: "persona",
    display_name: "Dancer",
    avatar_ref: null,
    primary_public_handle: "dancer",
  },
  is_active_revision: true,
  featured: false,
  revision_terms_hash: sha("c"),
  created_at: "2026-08-30T10:00:00.000Z",
  ready_at: "2026-08-30T10:01:00.000Z",
} as const;

describe("Dance reference contracts", () => {
  test("enforces exact half-open bounds at 6000 and 30000 milliseconds", () => {
    expect(strict(DanceSegmentBoundsV1)({ start_ms: 0, end_ms: 6_000 })).toEqual({
      start_ms: 0,
      end_ms: 6_000,
    });
    expect(strict(DanceSegmentBoundsV1)({ start_ms: 5_000, end_ms: 35_000 })).toEqual({
      start_ms: 5_000,
      end_ms: 35_000,
    });
    for (const bounds of [
      { start_ms: 0, end_ms: 5_999 },
      { start_ms: 0, end_ms: 30_001 },
      { start_ms: -1, end_ms: 6_000 },
      { start_ms: 6_000, end_ms: 6_000 },
      { start_ms: 6_001, end_ms: 6_000 },
      { start_ms: 0.5, end_ms: 6_000.5 },
      { start_ms: 0, end_ms: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => strict(DanceSegmentBoundsV1)(bounds)).toThrow();
    }
  });

  test("accepts author choices but rejects client-supplied segment authority", () => {
    const body = CreateDanceChoreography.request?.body;
    if (body === undefined) throw new Error("Dance choreography request body missing");
    const request = {
      idempotency_key: "dance-create-1",
      creator_persona_id: "persona_1",
      audio_revision: 3,
      reference_video_post_id: "video_post_1",
      start_ms: 1_000,
      end_ms: 7_000,
      mirror_policy: "allowed",
    } as const;
    expect(strict(body)(request)).toEqual(request);
    expect(() =>
      strict(body)({
        ...request,
        canonical_segment_sha256: sha("a"),
        segment_id: "client_segment",
      }),
    ).toThrow();
  });

  test("keeps processing and aggregate lifecycle facts internally consistent", () => {
    expect(
      strict(DanceChoreographyV1)({
        object: "dance_choreography",
        choreography_id: "choreography_1",
        song_post_id: "post_1",
        creator_persona_id: "persona_1",
        status: "ready",
        active_revision: 1,
        created_at: "2026-08-30T10:00:00.000Z",
        disabled_at: null,
        retired_at: null,
      }).active_revision,
    ).toBe(1);
    expect(
      strict(DanceReferenceProcessingV1)({
        object: "dance_reference_processing",
        choreography_id: "choreography_1",
        revision: 1,
        song_post_id: "post_1",
        audio_revision: 3,
        reference_video_post_id: "video_post_1",
        start_ms: 1_000,
        end_ms: 7_000,
        mirror_policy: "allowed",
        status: "ready",
        segment,
        reference_video_scored_start_ms: 2_000,
        reference_video_scored_end_ms: 8_000,
        processing_failure_code: null,
        revision_terms_hash: sha("c"),
        created_at: "2026-08-30T10:00:00.000Z",
        terminal_at: "2026-08-30T10:01:00.000Z",
      }).status,
    ).toBe("ready");
    expect(() =>
      strict(DanceReferenceProcessingV1)({
        object: "dance_reference_processing",
        choreography_id: "choreography_1",
        revision: 1,
        song_post_id: "post_1",
        audio_revision: 3,
        reference_video_post_id: "video_post_1",
        start_ms: 1_000,
        end_ms: 7_000,
        mirror_policy: "allowed",
        status: "ready",
        segment: null,
        reference_video_scored_start_ms: null,
        reference_video_scored_end_ms: null,
        processing_failure_code: null,
        revision_terms_hash: sha("c"),
        created_at: "2026-08-30T10:00:00.000Z",
        terminal_at: "2026-08-30T10:01:00.000Z",
      }),
    ).toThrow();
  });

  test("keeps public choreography projections persona-only and score-free", () => {
    const decoded = strict(DanceChoreographyPublicRevisionV1)(publicRevision);
    const encoded = JSON.stringify(decoded);
    for (const privateField of [
      "account_id",
      "wallet",
      "provider",
      "artifact_ref",
      "fingerprint",
      "score_bps",
      "platform_floor",
    ]) {
      expect(encoded).not.toContain(privateField);
    }
    expect(() =>
      strict(DanceChoreographyPublicRevisionV1)({
        ...publicRevision,
        creator_account_id: "account_1",
      }),
    ).toThrow();
  });

  test("declares only the phase-6 reference and presentation routes", () => {
    expect(CreateDanceChoreography.path).toBe(
      "/communities/:communityId/posts/:postId/dance/choreographies",
    );
    expect(GetDanceChoreographyProcessing.path).toBe(
      "/communities/:communityId/dance/choreographies/:choreographyId",
    );
    expect(AppendDanceChoreographyRevision.path).toEndWith(
      "/dance/choreographies/:choreographyId/revisions",
    );
    expect(DisableDanceChoreography.path).toEndWith(
      "/dance/choreographies/:choreographyId/disable",
    );
    expect(RetireDanceChoreography.path).toEndWith("/dance/choreographies/:choreographyId/retire");
    expect(ListReadyDanceChoreographies.auth.optionalUser).toBe(true);
    expect(GetDanceChoreographyRevision.auth.optionalUser).toBe(true);
    expect(SetSongDancePresentation.method).toBe("PUT");
    expect(ClearSongDancePresentation.method).toBe("DELETE");
    expect(() =>
      strict(SetSongDancePresentation.response)({
        presentation: {
          object: "song_dance_presentation",
          song_post_id: "post_1",
          audio_revision: 3,
          presentation_revision: 2,
          featured: null,
          updated_at: "2026-08-30T10:02:00.000Z",
        },
        replayed: false,
      }),
    ).toThrow();
    expect(() =>
      strict(ClearSongDancePresentation.response)({
        presentation: {
          object: "song_dance_presentation",
          song_post_id: "post_1",
          audio_revision: 3,
          presentation_revision: 2,
          featured: { choreography_id: "choreography_1", choreography_revision: 1 },
          updated_at: "2026-08-30T10:02:00.000Z",
        },
        replayed: false,
      }),
    ).toThrow();
  });

  test("keeps Dance reserved across runtime and generated qualification surfaces", () => {
    expect(() => Schema.decodeUnknownSync(QualifyingActivityV1)("dance")).toThrow();
    expect(() => Schema.decodeUnknownSync(RewardActivityV1)("dance")).toThrow();
    expect(schemaToOpenApi(QualifyingActivityV1)).toEqual({
      type: "string",
      enum: ["study", "karaoke"],
    });

    expect(() =>
      strict(ActivityQualificationV1)({
        object: "activity_qualification",
        qualification_id: "qualification_1",
        persona_id: "persona_1",
        community_id: "community_1",
        post_id: "post_1",
        audio_revision: 3,
        activity: "dance",
        attempt_ref: {
          kind: "dance",
          session_id: "dance_session_1",
          attempt_id: "dance_attempt_1",
        },
        score_bps: 10_000,
        qualification_policy_version_id: "dance-policy-v1",
        qualified_at: "2026-08-30T10:00:00.000Z",
        reward_period_key: "2026-08-30",
        streak_day: "2026-08-30",
        evidence_summary: { kind: "dance_qualification_v1" },
      }),
    ).toThrow();

    const rewardOperation = generateOpenApi({ AddMegapotPoolLeg }).paths[
      "/reward-offers/{offerId}/megapot-pool-legs"
    ]?.post;
    const rewardClient = generateClient({ AddMegapotPoolLeg });
    expect(JSON.stringify(rewardOperation)).toContain('"study"');
    expect(JSON.stringify(rewardOperation)).toContain('"karaoke"');
    expect(JSON.stringify(rewardOperation)).not.toContain('"dance"');
    expect(rewardClient).toContain(
      'readonly eligible_activities: ReadonlyArray<"study" | "karaoke">',
    );
    expect(rewardClient).not.toContain('"dance"');

    const danceEndpoints = Object.entries(registry).filter(([, value]) =>
      value.path.includes("/dance/"),
    );
    expect(danceEndpoints).toHaveLength(15);
    for (const [name, value] of danceEndpoints) {
      expect(name).not.toMatch(/Qualification/u);
      expect(value.path).not.toMatch(/qualifications|rewards/u);
    }
  });
});

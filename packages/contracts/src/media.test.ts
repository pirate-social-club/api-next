import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  BindMediaPostSubmissionReference,
  CancelMediaPostSubmission,
  CreateMediaPostSubmission,
  CreateMediaUploadReservation,
  CreatePost,
  FinalizeMediaPostSubmission,
  ModerateMediaPostSubmission,
  RetryMediaPostSubmission,
  schemaToOpenApi,
} from "./index.ts";

const decode = (schema: Schema.Schema<unknown>, value: unknown): unknown =>
  Schema.decodeUnknownSync(schema as unknown as Schema.ConstraintDecoder<unknown>, {
    onExcessProperty: "error",
  })(value);

const songInput = {
  version: "song-author-input-v1",
  title: "A song",
  lyrics: null,
  audio_reservation_id: "res_1",
  rights_declaration: { kind: "original" },
  license_preset: "commercial-remix",
  royalty_allocations: [{ recipient_id: "author_1", share_bps: 10_000 }],
  access_mode: "public",
  idempotency_key: "create_1",
} as const;

const published = {
  submission_id: "sub_1",
  href: "/media-post-submissions/sub_1",
  track: "song",
  creation_revision: 1,
  status: "published",
  published_resource: { post_id: "post_1", href: "/posts/post_1" },
  updated_at: "2026-08-23T12:00:00.000Z",
} as const;

describe("song media R0 contracts", () => {
  test("exposes the exact command routes and status responses", () => {
    expect(CreateMediaUploadReservation.path).toBe(
      "/communities/:communityId/media-upload-reservations",
    );
    expect(CreateMediaUploadReservation.successStatus).toBe(201);
    expect(CreateMediaPostSubmission.path).toBe("/communities/:communityId/media-post-submissions");
    expect(CreateMediaPostSubmission.successStatus).toBe(201);
    expect(FinalizeMediaPostSubmission.path).toBe("/media-post-submissions/:submissionId/finalize");
    expect(BindMediaPostSubmissionReference.path).toBe(
      "/media-post-submissions/:submissionId/reference",
    );
    expect(RetryMediaPostSubmission.path).toBe("/media-post-submissions/:submissionId/retry");
    expect(CancelMediaPostSubmission.path).toBe("/media-post-submissions/:submissionId/cancel");
    expect(ModerateMediaPostSubmission.path).toBe(
      "/moderation/media-post-submissions/:submissionId/actions",
    );
    expect(ModerateMediaPostSubmission.auth).toEqual({
      policy: { kind: "admin", scope: "moderation" },
    });
    expect(() =>
      decode(ModerateMediaPostSubmission.request?.body as Schema.Schema<unknown>, {
        idempotency_key: "moderate_1",
        expected_creation_revision: 0,
        action: "approve",
        approval_kind: "standard",
      }),
    ).toThrow();
  });

  test("accepts the primary-song reservation and rejects mutable storage facts", () => {
    const reservation = decode(
      CreateMediaUploadReservation.request?.body as Schema.Schema<unknown>,
      {
        idempotency_key: "reserve_1",
        track: "song",
        slot: "primary_audio",
        expected_content_type: "audio/mpeg",
        expected_size_bytes: 1,
        expected_sha256: "a".repeat(64),
      },
    );
    expect(reservation).toMatchObject({ track: "song", slot: "primary_audio" });
    expect(() =>
      decode(CreateMediaUploadReservation.request?.body as Schema.Schema<unknown>, {
        idempotency_key: "reserve_1",
        track: "song",
        slot: "primary_audio",
        expected_content_type: "audio/mpeg; charset=utf-8",
        expected_size_bytes: 1,
        bucket: "private-bucket",
      }),
    ).toThrow();
  });

  test("keeps commercial remix basis points editable, bounded, and non-aliased", () => {
    const body = decode(CreateMediaPostSubmission.request?.body as Schema.Schema<unknown>, {
      ...songInput,
      commercial_rev_share_bps: 0,
    });
    expect(body).toMatchObject({ commercial_rev_share_bps: 0 });
    const omitted = decode(CreateMediaPostSubmission.request?.body as Schema.Schema<unknown>, {
      ...songInput,
    });
    expect(omitted).toMatchObject({ commercial_rev_share_bps: 1000 });
    expect(() =>
      decode(CreateMediaPostSubmission.request?.body as Schema.Schema<unknown>, {
        ...songInput,
        commercial_rev_share_bps: 10_001,
      }),
    ).toThrow();
    expect(() =>
      decode(CreateMediaPostSubmission.request?.body as Schema.Schema<unknown>, {
        ...songInput,
        commercial_rev_share_pct: 10,
      }),
    ).toThrow();
    expect(() =>
      decode(CreateMediaPostSubmission.request?.body as Schema.Schema<unknown>, {
        ...songInput,
        license_preset: "commercial-use",
        commercial_rev_share_bps: 1000,
      }),
    ).toThrow();
    expect(() =>
      decode(CreateMediaPostSubmission.request?.body as Schema.Schema<unknown>, {
        ...songInput,
        license_preset: "non-commercial",
        commercial_rev_share_bps: 1000,
      }),
    ).toThrow();
    for (const field of [
      "cover_art_reservation_id",
      "instrumental_audio_reservation_id",
      "vocal_audio_reservation_id",
      "is_instrumental",
    ]) {
      expect(() =>
        decode(CreateMediaPostSubmission.request?.body as Schema.Schema<unknown>, {
          ...songInput,
          [field]: "not-in-v1",
        }),
      ).toThrow();
    }
  });

  test("requires unique positive royalty shares totaling 10000", () => {
    expect(() =>
      decode(CreateMediaPostSubmission.request?.body as Schema.Schema<unknown>, {
        ...songInput,
        royalty_allocations: [
          { recipient_id: "author_1", share_bps: 5_000 },
          { recipient_id: "author_1", share_bps: 5_000 },
        ],
      }),
    ).toThrow();
    expect(() =>
      decode(CreateMediaPostSubmission.request?.body as Schema.Schema<unknown>, {
        ...songInput,
        royalty_allocations: [{ recipient_id: "author_1", share_bps: 9_999 }],
      }),
    ).toThrow();
  });

  test("uses a closed song-only submission snapshot and closed badge vocabulary", () => {
    const mediaSubmissionSchema = CreateMediaPostSubmission.response as Schema.Schema<unknown>;
    expect(decode(mediaSubmissionSchema, published)).toEqual(published);
    expect(() => decode(mediaSubmissionSchema, { ...published, track: "video" })).toThrow();
    const processing = {
      submission_id: "sub_1",
      href: "/media-post-submissions/sub_1",
      track: "song",
      creation_revision: 1,
      status: "processing",
      phase: "awaiting_upload",
      updated_at: "2026-08-23T12:00:00.000Z",
    } as const;
    expect(decode(mediaSubmissionSchema, processing)).toMatchObject({
      status: "processing",
      phase: "awaiting_upload",
    });
    const openApi = schemaToOpenApi(mediaSubmissionSchema);
    expect(JSON.stringify(openApi)).not.toContain("acr_no_match");
    expect(JSON.stringify(openApi)).not.toContain("rights_clearance");
    const createOpenApi = schemaToOpenApi(CreateMediaPostSubmission.request?.body);
    expect(JSON.stringify(createOpenApi)).toContain('"default":1000');
  });

  test("makes CreatePost text-only and removes legacy common song fields", () => {
    const properties = schemaToOpenApi(CreatePost.request?.body).properties as Record<
      string,
      unknown
    >;
    const removalManifest = [
      "agent_id",
      "agent_action_proof",
      "anonymous_scope",
      "disclosed_qualifier_ids",
      "parent_post_id",
      "label_id",
      "caption",
      "link_url",
      "media_refs",
      "creator_relation",
      "promotion_disclosure",
      "asset_id",
      "file_upload",
      "song_artifact_bundle",
      "song_mode",
      "rights_basis",
      "upstream_asset_refs",
      "license_preset",
      "access_mode",
      "commercial_rev_share_pct",
      "royalty_allocations",
      "lyrics",
      "source_post",
      "source_community",
      "crosspost_source",
      "event",
      "listing_draft",
      "age_gate_policy",
      "translation_policy",
    ] as const;
    for (const field of removalManifest) {
      expect(Object.hasOwn(properties, field)).toBe(false);
      expect(() =>
        decode(CreatePost.request?.body as Schema.Schema<unknown>, {
          post_type: "text",
          idempotency_key: "key_1",
          body: "hello",
          [field]: "legacy",
        }),
      ).toThrow();
    }
    expect(() =>
      decode(CreatePost.request?.body as Schema.Schema<unknown>, {
        post_type: "song",
        idempotency_key: "key_1",
        audio_reservation_id: "res_1",
      }),
    ).toThrow();
  });
});

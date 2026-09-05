import type { LocalizedPostDocument } from "@pirate/application";

type PublicPostDocument = Extract<LocalizedPostDocument, { readonly post: unknown }>;
export type PublicVideoPostProjection = NonNullable<PublicPostDocument["video"]>;

type Row = Readonly<Record<string, unknown>>;

export const videoPostProjectionSelect = `video_projection.media_kind AS video_media_kind,
  video_submission.video_intent AS video_intent,
  video_projection.caption AS video_caption,
  video_projection.original_sound_id AS video_original_sound_id,
  original_sound.origin_video_post_id AS video_origin_post_id,
  origin_post.author_persona_id AS video_origin_author_persona_id,
  stream_ingest.state AS video_stream_state,
  stream_ingest.provider_video_id AS video_playback_ref,
  thumbnail_enrichment.state AS video_thumbnail_state,
  video_projection.poster_artifact_ref AS video_thumbnail_artifact_ref,
  video_data_registration.state AS video_data_registration_state`;

export const videoPostProjectionJoins = `LEFT JOIN media_publication_projections AS video_projection
    ON video_projection.community_id = p.community_id
   AND video_projection.post_id = p.post_id
   AND video_projection.media_kind = 'video'
  LEFT JOIN media_post_submissions AS video_submission
    ON video_submission.submission_id = video_projection.submission_id
   AND video_submission.operation_id = video_projection.operation_id
   AND video_submission.media_kind = 'video'
  LEFT JOIN media_video_original_sounds AS original_sound
    ON original_sound.submission_id = video_projection.submission_id
   AND original_sound.original_sound_id = video_projection.original_sound_id
  LEFT JOIN posts AS origin_post
    ON origin_post.community_id = p.community_id
   AND origin_post.post_id = original_sound.origin_video_post_id
   AND origin_post.post_type = 'video'
   AND origin_post.status = 'published'
  LEFT JOIN media_video_stream_ingests AS stream_ingest
    ON stream_ingest.operation_id = video_projection.operation_id
  LEFT JOIN media_video_enrichment_outbox AS thumbnail_enrichment
    ON thumbnail_enrichment.submission_id = video_projection.submission_id
   AND thumbnail_enrichment.enrichment_kind = 'thumbnail'
  LEFT JOIN data_registration_operations AS video_data_registration
    ON video_data_registration.submission_id = video_projection.submission_id
   AND video_data_registration.post_id = video_projection.post_id
   AND video_data_registration.media_kind = 'video'
   AND video_data_registration.rights_basis = 'original'
   AND video_data_registration.registration_revision = 1`;

const requiredText = (row: Row, key: string): string | null => {
  const value = row[key];
  return typeof value === "string" && value.length > 0 && value.trim() === value ? value : null;
};

const nullableText = (row: Row, key: string): string | null | undefined => {
  const value = row[key];
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
};

const dataRegistrationState = (
  value: unknown,
): PublicVideoPostProjection["data_registration"] | null => {
  switch (value) {
    case "registered":
    case "failed":
      return value;
    case "pending":
    case "signing":
    case "broadcast":
    case "confirming":
    case "reconciliation_required":
      return "registration_pending";
    default:
      return null;
  }
};

export const videoPostProjectionFromRow = (row: Row): PublicVideoPostProjection | null => {
  const caption = nullableText(row, "video_caption");
  const originalSoundId = requiredText(row, "video_original_sound_id");
  const originVideoPostId = requiredText(row, "video_origin_post_id");
  const originAuthorPersonaId = requiredText(row, "video_origin_author_persona_id");
  const streamState = requiredText(row, "video_stream_state");
  const playbackRef = nullableText(row, "video_playback_ref");
  const thumbnailState = requiredText(row, "video_thumbnail_state");
  const thumbnailArtifactRef = requiredText(row, "video_thumbnail_artifact_ref");
  const registration = dataRegistrationState(row.video_data_registration_state);

  if (
    row.video_media_kind !== "video" ||
    row.video_intent !== "original_audio" ||
    caption === undefined ||
    originalSoundId === null ||
    originVideoPostId === null ||
    originAuthorPersonaId === null ||
    (streamState === null && row.video_stream_state !== null) ||
    playbackRef === undefined ||
    thumbnailState === null ||
    thumbnailArtifactRef === null ||
    registration === null
  ) {
    return null;
  }

  const playback: PublicVideoPostProjection["playback"] | null =
    streamState === "bound"
      ? playbackRef === null || requiredText(row, "video_playback_ref") === null
        ? null
        : // Binding proves source identity only. A later delivery observation
          // must establish encoding and signed-access readiness before ready.
          { status: "pending" }
      : (streamState === null ||
            ["not_started", "sending", "manual_review"].includes(streamState)) &&
          playbackRef === null
        ? { status: "pending" }
        : null;
  const thumbnail: PublicVideoPostProjection["thumbnail"] | null =
    thumbnailState === "ready"
      ? { status: "ready", artifact_ref: thumbnailArtifactRef }
      : ["pending", "running", "failed"].includes(thumbnailState)
        ? { status: "pending" }
        : null;
  if (playback === null || thumbnail === null) return null;

  return {
    track: "video",
    caption,
    caption_dir: caption === null ? null : "auto",
    caption_lang: null,
    soundtrack: {
      kind: "original_audio",
      original_sound_id: originalSoundId,
      origin_video_post_id: originVideoPostId,
      origin_author_persona_id: originAuthorPersonaId,
    },
    playback,
    thumbnail,
    data_registration: registration,
    capabilities: { can_post_with_song: false },
  };
};

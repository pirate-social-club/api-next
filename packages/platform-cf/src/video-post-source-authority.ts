import { mediaProcessingPhysicalObjectKey } from "./media-immutable-object-key.ts";
import type { TelegramDatabase } from "./telegram-database.ts";

export interface TelegramVideoSource {
  readonly physicalKey: string;
  readonly canonicalSha256: string;
  readonly rights: "original" | "derivative";
}

/**
 * Resolves the accepted source for an eligible video publication: the sealed
 * immutable revision for original rights, or the accepted song master for
 * derivative rights. The result is a validated physical identity, never a
 * fetchable locator; the bucket reader verifies the bytes against the
 * canonical hash before transfer.
 */
export function makeTelegramVideoSource(db: TelegramDatabase) {
  return async (
    post: Readonly<{ id: string; communityId: string }>,
  ): Promise<TelegramVideoSource | null> => {
    const rows = await db.query(
      `SELECT r.rights_basis,
          CASE WHEN r.rights_basis='original' THEN v.immutable_ref ELSE m.verified_object_key END AS source_ref,
          p.canonical_video_sha256
        FROM media_publication_projections p
        JOIN media_post_submissions s ON s.submission_id=p.submission_id
          AND s.operation_id=p.operation_id AND s.community_id=p.community_id
          AND s.post_id=p.post_id AND s.media_kind='video' AND s.status='published'
        JOIN media_video_rights r ON r.submission_id=p.submission_id
        LEFT JOIN media_video_revisions v ON r.rights_basis='original'
          AND v.submission_id=p.submission_id AND v.operation_id=p.operation_id
          AND v.community_id=p.community_id AND v.video_revision=p.video_revision
          AND v.immutable_ref=p.video_asset_ref AND v.canonical_sha256=p.canonical_video_sha256
        LEFT JOIN media_song_video_accepted_masters a ON r.rights_basis='derivative'
          AND a.plan_id=p.song_video_plan_id AND a.master_revision_id=p.song_video_master_revision_id
        LEFT JOIN media_song_video_masters m ON r.rights_basis='derivative'
          AND m.plan_id=a.plan_id AND m.master_revision_id=a.master_revision_id
          AND m.verified_object_key=p.video_asset_ref AND m.master_sha256=p.canonical_video_sha256
        WHERE p.post_id=$1 AND p.community_id=$2 AND p.media_kind='video'`,
      [post.id, post.communityId],
    );
    const row = rows[0];
    const reference = row?.source_ref;
    const sha256 = row?.canonical_video_sha256;
    const rights = row?.rights_basis;
    if (
      (rights !== "original" && rights !== "derivative") ||
      typeof reference !== "string" ||
      reference.length === 0 ||
      typeof sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(sha256)
    )
      return null;
    try {
      const physicalKey =
        rights === "original" ? mediaProcessingPhysicalObjectKey(reference) : reference;
      if (
        !/^immutable\/[A-Za-z0-9._/-]+$/u.test(physicalKey) ||
        physicalKey.includes("..") ||
        physicalKey.includes("\\")
      )
        return null;
      return { physicalKey, canonicalSha256: sha256, rights };
    } catch {
      return null;
    }
  };
}

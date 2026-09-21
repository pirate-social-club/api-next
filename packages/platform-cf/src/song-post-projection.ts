import { SongPostStatusProjectionV1 } from "@pirate/contracts";
import { Option, Schema } from "effect";

export const songPostProjectionSelect = `song_projection.media_kind AS song_media_kind,
  song_projection.alignment AS song_alignment,
  song_projection.data_registration AS song_data_registration`;
export const songPostProjectionJoins = `LEFT JOIN media_publication_projections AS song_projection
  ON song_projection.community_id = p.community_id
 AND song_projection.post_id = p.post_id
 AND song_projection.media_kind = 'song'`;

export function songPostStatusProjectionFromRow(
  row: Readonly<Record<string, unknown>>,
): SongPostStatusProjectionV1 | null {
  if (row.song_media_kind !== "song") return null;
  return Option.getOrNull(
    Schema.decodeUnknownOption(SongPostStatusProjectionV1)({
      alignment: row.song_alignment,
      data_registration: row.song_data_registration,
    }),
  );
}

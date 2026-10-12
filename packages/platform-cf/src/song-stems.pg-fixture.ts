import type { Client } from "pg";

/** Seeds activity fixtures while their parent suite has disabled fixture triggers. */
export async function insertSongStemPairFixture(
  admin: Client,
  input: {
    submissionId: string;
    communityId: string;
    actorUserId: string;
    operationId: string;
    personaId: string;
  },
): Promise<void> {
  for (const slot of ["instrumental_audio", "vocal_audio"] as const) {
    await admin.query(
      `INSERT INTO media_song_stems (
         submission_id,slot,community_id,actor_user_id,operation_id,
         reservation_id,immutable_ref,destination_ref,etag,object_version,
         size_bytes,content_type,canonical_sha256,author_persona_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'etag','version',16,'audio/mpeg',$9,$10)`,
      [
        input.submissionId,
        slot,
        input.communityId,
        input.actorUserId,
        `${input.operationId}-stem-${slot}`,
        `${input.submissionId}-reservation-${slot}`,
        `media://immutable/${input.operationId}-stem-${slot}/audio/1`,
        `r2://immutable/${input.operationId}-stem-${slot}/audio/1`,
        slot === "instrumental_audio" ? "8".repeat(64) : "9".repeat(64),
        input.personaId,
      ],
    );
  }
}

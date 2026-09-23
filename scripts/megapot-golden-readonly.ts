import { Schema } from "effect";
import { Client } from "pg";
import type { MultiGoldenInput, MultiParticipantPreflight } from "./megapot-golden-multi-input.ts";
import { goldenObservationSql } from "./megapot-golden-observation-sql.ts";
import { GoldenObservation } from "./megapot-golden-reconciliation.ts";
import { megapotVeryEvidenceCte } from "./megapot-very-preflight-sql.ts";

/** A pinned read-only connection, never the migration/admin connection. */
export async function withGoldenReadOnly<A>(
  connectionString: string,
  expectedHost: string,
  expectedDatabase: string,
  run: (client: Client) => Promise<A>,
): Promise<A> {
  const url = new URL(connectionString);
  if (
    !expectedHost ||
    !expectedDatabase ||
    url.hostname !== expectedHost ||
    decodeURIComponent(url.pathname.slice(1)) !== expectedDatabase ||
    !["postgres:", "postgresql:"].includes(url.protocol)
  )
    throw new Error("Staging database pin mismatch.");
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 10000,
    query_timeout: 15000,
  });
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '10s'");
    return await run(client);
  } finally {
    await client.end();
  }
}

export async function observeGoldenDrawing(
  client: Client,
  legId: string,
  drawingId: string,
): Promise<GoldenObservation> {
  const result = await client.query(goldenObservationSql, [legId, drawingId]);
  if (result.rows.length !== 1) throw new Error("Exact drawing observation missing.");
  return Schema.decodeUnknownSync(GoldenObservation, { onExcessProperty: "error" })(
    result.rows[0].observation,
  );
}

/** Includes terminal drawings: never pick the newest/open drawing after a crash. */
export const goldenDrawingRecoverySql = `SELECT d.drawing_id::text AS drawing_id
 FROM megapot_pool_drawings d
 JOIN song_reward_offer_legs l ON l.leg_id=d.pool_leg_id
 JOIN song_reward_offers o ON o.offer_id=l.offer_id
 WHERE l.leg_id=$1 AND o.community_id=$2 AND o.post_id=$3
 AND o.audio_revision=$4 AND l.kind='megapot_pool' AND l.chain_id=84532
 ORDER BY d.drawing_id LIMIT 2`;

export async function recoverGoldenDrawing(
  client: Client,
  input: MultiGoldenInput,
  legId: string,
): Promise<string> {
  const result = await client.query(goldenDrawingRecoverySql, [
    legId,
    input.community_id,
    input.post_id,
    input.audio_revision,
  ]);
  if (result.rows.length !== 1)
    throw new Error("Exact recovery drawing missing or ambiguous; operator review required.");
  return Schema.decodeUnknownSync(Schema.Struct({ drawing_id: Schema.String }))(result.rows[0])
    .drawing_id;
}

export const goldenIdentitySql = `${megapotVeryEvidenceCte}
SELECT wallet.assignment_id, wallet.address,
 COALESCE((SELECT jsonb_agg(jsonb_build_object(
 'subject_key_id',subject_key_id,'binding_event_id',binding_event_id,'binding_epoch',binding_epoch,
 'binding_group_id',binding_group_id,'evidence_receipt_id',evidence_receipt_id,'evidence_hash',evidence_hash,
 'personhood_assertion_id',personhood_assertion_id,'subject_unique_assertion_id',subject_unique_assertion_id,
 'proof_session_id',proof_session_id,'evidence_expires_at',CASE WHEN evidence_expires_at IS NULL THEN NULL ELSE
 to_char(evidence_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END))
 FROM exact_evidence),'[]'::jsonb) AS evidence
 FROM personas persona JOIN persona_wallet_assignments wallet
 ON wallet.persona_id=persona.persona_id AND wallet.account_id=persona.account_id AND wallet.status='active'
 WHERE persona.account_id=$1 AND persona.persona_id=$2 AND persona.status='active'`;

const Identity = Schema.Struct({
  assignment_id: Schema.String,
  address: Schema.String,
  evidence: Schema.Array(
    Schema.Record(Schema.String, Schema.NullOr(Schema.Union([Schema.String, Schema.Int]))),
  ),
});

export const goldenContentSql = `SELECT publication.audio_revision::int, publication.lyrics_revision::int,
 (SELECT count(DISTINCT exercise_review_key)::int FROM study_exercise_versions e
  WHERE e.community_id=publication.community_id AND e.post_id=publication.post_id
  AND e.audio_revision=publication.audio_revision AND e.lyrics_revision=publication.lyrics_revision
  AND e.exercise_type='say_it_back' AND e.target_language IS NULL AND e.learner_band IS NULL AND e.retired_at IS NULL) AS study_exercise_count
 FROM media_publication_projections publication JOIN media_post_submissions submission
 ON submission.submission_id=publication.submission_id AND submission.audio_revision=publication.audio_revision
 AND submission.current_lyrics_revision=publication.lyrics_revision
 WHERE publication.community_id=$1 AND publication.post_id=$2 AND publication.lyrics_status='ready'`;
const Content = Schema.Struct({
  audio_revision: Schema.Int,
  lyrics_revision: Schema.Int,
  study_exercise_count: Schema.Int,
});

/** Confirms that the separately reviewed ceremony artifact still has its exact live witness. */
export async function verifyGoldenIdentity(
  client: Client,
  artifact: MultiParticipantPreflight,
  now: number = Date.now(),
): Promise<void> {
  const result = await client.query(goldenIdentitySql, [artifact.account_id, artifact.persona_id]);
  if (result.rows.length !== 1) throw new Error("Current participant identity missing.");
  const row = Schema.decodeUnknownSync(Identity)(result.rows[0]);
  if (
    result.rows.length !== 1 ||
    row.assignment_id !== artifact.wallet_assignment_id ||
    row.address !== artifact.wallet_address ||
    !Array.isArray(row.evidence) ||
    row.evidence.length !== artifact.very_evidence.length
  )
    throw new Error("Current participant identity mismatch.");
  for (const evidence of artifact.very_evidence) {
    const current = row.evidence[0];
    const expiresAt = current?.evidence_expires_at;
    if (typeof expiresAt === "string" && Date.parse(expiresAt) <= now)
      throw new Error("Current Very witness expired.");
    for (const key of [
      "subject_key_id",
      "binding_event_id",
      "binding_epoch",
      "binding_group_id",
      "evidence_receipt_id",
      "proof_session_id",
      "evidence_hash",
      "personhood_assertion_id",
      "subject_unique_assertion_id",
    ] as const) {
      if (current?.[key] !== evidence[key]) throw new Error("Current Very witness mismatch.");
    }
  }
  const content = await client.query(goldenContentSql, [artifact.community_id, artifact.post_id]);
  if (content.rows.length !== 1) throw new Error("Current song publication missing.");
  const current = Schema.decodeUnknownSync(Content)(content.rows[0]);
  if (
    current.audio_revision !== artifact.audio_revision ||
    current.lyrics_revision !== artifact.lyrics_revision ||
    current.study_exercise_count < artifact.study_exercise_count
  )
    throw new Error("Current song preflight mismatch.");
}

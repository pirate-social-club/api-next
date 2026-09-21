import { GetKaraokeReadiness, type KaraokeReadiness } from "@pirate/contracts";
import { Schema } from "effect";
import type { Client } from "pg";
import { type GoldenHttpOptions, requestJson } from "./megapot-golden-http.ts";
import {
  assertMultiParticipantPreflight,
  type MultiGoldenInput,
  MultiParticipantPreflight,
  type RehearsalParticipant,
} from "./megapot-golden-multi-input.ts";
import { goldenContentSql, goldenIdentitySql } from "./megapot-golden-readonly.ts";

const EvidenceRow = Schema.Struct({
  assignment_id: Schema.String,
  address: Schema.String,
  evidence: Schema.Array(
    Schema.Record(Schema.String, Schema.NullOr(Schema.Union([Schema.String, Schema.Int]))),
  ),
});
const ContentRow = Schema.Struct({
  audio_revision: Schema.Int,
  lyrics_revision: Schema.Int,
  study_exercise_count: Schema.Int,
});

/** Formats observed evidence; never creates a ceremony, receipt, activity, or wallet. */
export function assembleGoldenPreflight(
  input: MultiGoldenInput,
  participant: RehearsalParticipant,
  identityRow: unknown,
  contentRow: unknown,
  readiness: KaraokeReadiness | null,
  ceremonyReference: string | undefined,
  now: number,
): MultiParticipantPreflight {
  const identity = Schema.decodeUnknownSync(EvidenceRow)(identityRow);
  const content = Schema.decodeUnknownSync(ContentRow)(contentRow);
  if (identity.evidence.length > 1 || (identity.evidence.length === 1 && !ceremonyReference))
    throw new Error("Exactly one reviewed real ceremony reference required for verified evidence.");
  let validUntil = now + 600000;
  for (const evidence of identity.evidence) {
    if (evidence.evidence_expires_at !== null) {
      if (
        typeof evidence.evidence_expires_at !== "string" ||
        !Number.isFinite(Date.parse(evidence.evidence_expires_at))
      )
        throw new Error("Evidence expiry invalid.");
      validUntil = Math.min(validUntil, Date.parse(evidence.evidence_expires_at));
    }
  }
  const artifact = Schema.decodeUnknownSync(MultiParticipantPreflight, {
    onExcessProperty: "error",
  })({
    object: "megapot_participant_preflight_v2",
    checked_at: new Date(now).toISOString(),
    valid_until: new Date(validUntil).toISOString(),
    account_id: participant.account_id,
    persona_id: participant.persona_id,
    community_id: input.community_id,
    post_id: input.post_id,
    ...content,
    wallet_assignment_id: identity.assignment_id,
    wallet_address: identity.address,
    verification_state: identity.evidence.length === 1 ? "eligible" : "verification_missing",
    very_evidence: identity.evidence.map((e) => ({ ...e, ceremony_reference: ceremonyReference })),
    karaoke_revision_id: readiness?.state === "ready" ? readiness.karaoke_revision_id : null,
    karaoke_line_count: readiness?.state === "ready" ? readiness.karaoke_lines.length : 0,
    playback_kind: readiness?.state === "ready" ? readiness.playback_kind : null,
  });
  if (
    readiness?.state === "ready" &&
    (readiness.community_id !== input.community_id || readiness.post_id !== input.post_id)
  )
    throw new Error("Karaoke content scope mismatch.");
  assertMultiParticipantPreflight(artifact, input, participant, now);
  return artifact;
}

export async function collectGoldenPreflight(
  client: Client,
  input: MultiGoldenInput,
  participant: RehearsalParticipant,
  http: GoldenHttpOptions,
  ceremonyReference?: string,
) {
  const identity = await client.query(goldenIdentitySql, [
    participant.account_id,
    participant.persona_id,
  ]);
  const content = await client.query(goldenContentSql, [input.community_id, input.post_id]);
  if (identity.rows.length !== 1 || content.rows.length !== 1)
    throw new Error("Exact participant and song preflight unavailable.");
  const readiness = participant.activities.includes("karaoke")
    ? await requestJson(
        { fetcher: fetch },
        http,
        `/communities/${encodeURIComponent(input.community_id)}/posts/${encodeURIComponent(input.post_id)}/karaoke`,
        GetKaraokeReadiness.response,
      )
    : null;
  return assembleGoldenPreflight(
    input,
    participant,
    identity.rows[0],
    content.rows[0],
    readiness,
    ceremonyReference,
    Date.now(),
  );
}

/**
 * Persistence for the Spec 013 Gate A song-video identities.
 *
 * This adapter owns the obligation the typed contracts cannot discharge: a
 * `claimedSourceSha256` asserts which source a render used and is not evidence
 * that the source was verified. Sealing here establishes that binding against
 * the stored sealed object and refuses when it cannot, rather than trusting the
 * claim.
 *
 * U.2, U.4, U.5 and U.6 remain open gates. No default is supplied for any of
 * them; the byte ceiling that applied is recorded per master so a later ratified
 * value stays auditable instead of being assumed retroactively.
 */

import type { Client } from "pg";

/** Surfaces structurally through SealOutcome. */
type SourceBindingFailure =
  | { readonly kind: "sealed_source_absent"; readonly immutableRef: string }
  | {
      readonly kind: "sealed_source_digest_mismatch";
      readonly immutableRef: string;
      readonly storedSha256: string;
    };

export type SealOutcome =
  | { readonly sealed: true; readonly masterRevisionId: string }
  | { readonly sealed: false; readonly failure: SourceBindingFailure };

export type AcceptOutcome =
  | { readonly accepted: true; readonly masterRevisionId: string }
  | { readonly accepted: false; readonly winningMasterRevisionId: string };

export type PersistedPlan = {
  readonly planId: string;
  readonly submissionId: string;
  readonly songPostId: string;
  readonly songAssetId: string;
  readonly audioRevision: number;
  readonly songDurationSamples: number;
  readonly clipStartSamples: number;
  readonly clipDurationSamples: number;
};

export type PersistedAttempt = {
  readonly attemptId: string;
  readonly planId: string;
  readonly generation: number;
};

export type SealRequest = {
  readonly masterRevisionId: string;
  readonly attempt: PersistedAttempt;
  readonly sourceImmutableRef: string;
  /** A claim about which source was used, checked here against stored bytes. */
  readonly claimedSourceSha256: string;
  readonly masterSha256: string;
  readonly masterByteLength: number;
  /** U.6's configured ceiling. Supplied by the caller; never defaulted here. */
  readonly masterCeilingBytes: number;
  readonly rendererIdentity: string;
  readonly rendererPolicyRevision: number;
  readonly decisionClipStartSamples: number;
  readonly decisionClipDurationSamples: number;
};

/** Persists the plan frozen at reservation. Containment is enforced by the schema. */
export async function persistRenderPlan(client: Client, plan: PersistedPlan): Promise<void> {
  await client.query(
    `INSERT INTO media_song_video_render_plans
       (plan_id, submission_id, song_post_id, song_asset_id, audio_revision,
        song_duration_samples, clip_start_samples, clip_duration_samples)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      plan.planId,
      plan.submissionId,
      plan.songPostId,
      plan.songAssetId,
      plan.audioRevision,
      plan.songDurationSamples,
      plan.clipStartSamples,
      plan.clipDurationSamples,
    ],
  );
}

/**
 * Records attempt identity before the renderer is dispatched, so a worker that
 * stops is always attributable to a known attempt.
 */
export async function startRenderAttempt(client: Client, attempt: PersistedAttempt): Promise<void> {
  await client.query(
    `INSERT INTO media_song_video_render_attempts (attempt_id, plan_id, generation, state)
     VALUES ($1,$2,$3,'started')`,
    [attempt.attemptId, attempt.planId, attempt.generation],
  );
}

/**
 * Seals a master only after establishing the source binding against the stored
 * sealed object. The claimed digest is compared with the digest PostgreSQL holds
 * for that immutable reference; an absent object or a mismatch refuses the seal
 * and leaves the attempt untouched.
 */
export async function sealMaster(client: Client, request: SealRequest): Promise<SealOutcome> {
  await client.query("BEGIN");
  try {
    const stored = await client.query<{ canonical_sha256: string }>(
      "SELECT canonical_sha256 FROM media_immutable_objects WHERE immutable_ref = $1 FOR SHARE",
      [request.sourceImmutableRef],
    );
    const row = stored.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return {
        sealed: false,
        failure: { kind: "sealed_source_absent", immutableRef: request.sourceImmutableRef },
      };
    }
    if (row.canonical_sha256 !== request.claimedSourceSha256) {
      await client.query("ROLLBACK");
      return {
        sealed: false,
        failure: {
          kind: "sealed_source_digest_mismatch",
          immutableRef: request.sourceImmutableRef,
          storedSha256: row.canonical_sha256,
        },
      };
    }
    await client.query(
      `INSERT INTO media_song_video_masters
         (master_revision_id, plan_id, attempt_id, source_immutable_ref, source_sha256,
          master_sha256, master_byte_length, master_ceiling_bytes, renderer_identity,
          renderer_policy_revision, decision_clip_start_samples, decision_clip_duration_samples)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        request.masterRevisionId,
        request.attempt.planId,
        request.attempt.attemptId,
        request.sourceImmutableRef,
        // The stored digest is written, not the claim, so the row records what
        // was established rather than what was asserted.
        row.canonical_sha256,
        request.masterSha256,
        request.masterByteLength,
        request.masterCeilingBytes,
        request.rendererIdentity,
        request.rendererPolicyRevision,
        request.decisionClipStartSamples,
        request.decisionClipDurationSamples,
      ],
    );
    await client.query(
      "UPDATE media_song_video_render_attempts SET state = 'sealed' WHERE attempt_id = $1 AND state = 'started'",
      [request.attempt.attemptId],
    );
    await client.query("COMMIT");
    return { sealed: true, masterRevisionId: request.masterRevisionId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/**
 * Accepts one master per plan by compare-and-set. Concurrency is resolved by the
 * primary key rather than by application ordering, so a loser observes the
 * existing winner instead of replacing it.
 */
export async function acceptMaster(
  client: Client,
  input: { readonly planId: string; readonly masterRevisionId: string; readonly attemptId: string },
): Promise<AcceptOutcome> {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const inserted = await client.query(
      `INSERT INTO media_song_video_accepted_masters (plan_id, master_revision_id)
       VALUES ($1,$2) ON CONFLICT (plan_id) DO NOTHING
       RETURNING master_revision_id`,
      [input.planId, input.masterRevisionId],
    );
    if (inserted.rowCount === 1) {
      await client.query(
        "UPDATE media_song_video_render_attempts SET state = 'accepted' WHERE attempt_id = $1",
        [input.attemptId],
      );
      await client.query("COMMIT");
      return { accepted: true, masterRevisionId: input.masterRevisionId };
    }
    const winner = await client.query<{ master_revision_id: string }>(
      "SELECT master_revision_id FROM media_song_video_accepted_masters WHERE plan_id = $1",
      [input.planId],
    );
    const winningMasterRevisionId = winner.rows[0]?.master_revision_id;
    if (winningMasterRevisionId === undefined) {
      throw new Error("accepted master conflict was not observable");
    }
    await client.query(
      "UPDATE media_song_video_render_attempts SET state = 'loser', disposition = 'not_first_accepted_master' WHERE attempt_id = $1",
      [input.attemptId],
    );
    await client.query("COMMIT");
    return { accepted: false, winningMasterRevisionId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

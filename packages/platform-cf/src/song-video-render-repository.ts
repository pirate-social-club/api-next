/**
 * Persistence for the Spec 013 Gate A song-video identities.
 *
 * This adapter owns part of the obligation the typed contracts cannot
 * discharge. Sealing binds a master to the source object PostgreSQL holds for
 * this plan's submission, and refuses when it cannot.
 *
 * The evidence is narrow and should be described that way. This reads stored
 * digest metadata, not object bytes: it establishes that the claimed digest
 * matches what the database recorded when the source was sealed for this
 * submission, not that those bytes exist or still hash to that value. The
 * master's own digest and byte length are likewise accepted as claims, because
 * no output object is verified here. Output verification is separate work and
 * nothing below asserts it happened.
 *
 * U.2, U.4, U.5 and U.6 remain open gates. No default is supplied for any of
 * them; the byte ceiling that applied is recorded per master so a later ratified
 * value stays auditable instead of being assumed retroactively.
 */

import type { Client } from "pg";

/** Surfaces structurally through SealOutcome. */
type SourceBindingFailure =
  | { readonly kind: "plan_absent"; readonly planId: string }
  | { readonly kind: "attempt_not_of_plan"; readonly attemptId: string; readonly planId: string }
  | {
      readonly kind: "attempt_generation_mismatch";
      readonly attemptId: string;
      readonly storedGeneration: number;
    }
  | { readonly kind: "decision_does_not_match_plan"; readonly planId: string }
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
    // Read the plan and the attempt together, keyed on the pair, so an attempt
    // belonging to a different plan cannot be presented as this plan's work.
    const bound = await client.query<{
      submission_id: string;
      clip_start_samples: string;
      clip_duration_samples: string;
      generation: number;
    }>(
      `SELECT p.submission_id, p.clip_start_samples, p.clip_duration_samples, a.generation
         FROM media_song_video_render_plans p
         JOIN media_song_video_render_attempts a
           ON a.plan_id = p.plan_id AND a.attempt_id = $2
        WHERE p.plan_id = $1
        FOR SHARE`,
      [request.attempt.planId, request.attempt.attemptId],
    );
    const boundRow = bound.rows[0];
    if (!boundRow) {
      // Either the plan does not exist, or the attempt is not an attempt of it.
      const planExists = await client.query(
        "SELECT 1 FROM media_song_video_render_plans WHERE plan_id = $1",
        [request.attempt.planId],
      );
      await client.query("ROLLBACK");
      return planExists.rowCount === 0
        ? { sealed: false, failure: { kind: "plan_absent", planId: request.attempt.planId } }
        : {
            sealed: false,
            failure: {
              kind: "attempt_not_of_plan",
              attemptId: request.attempt.attemptId,
              planId: request.attempt.planId,
            },
          };
    }
    if (boundRow.generation !== request.attempt.generation) {
      await client.query("ROLLBACK");
      return {
        sealed: false,
        failure: {
          kind: "attempt_generation_mismatch",
          attemptId: request.attempt.attemptId,
          storedGeneration: boundRow.generation,
        },
      };
    }
    if (
      BigInt(boundRow.clip_start_samples) !== BigInt(request.decisionClipStartSamples) ||
      BigInt(boundRow.clip_duration_samples) !== BigInt(request.decisionClipDurationSamples)
    ) {
      await client.query("ROLLBACK");
      return {
        sealed: false,
        failure: { kind: "decision_does_not_match_plan", planId: request.attempt.planId },
      };
    }
    // The source must be an object sealed for this plan's submission. A digest
    // that is valid for some other submission's object is not this work's source.
    const stored = await client.query<{ canonical_sha256: string }>(
      `SELECT canonical_sha256 FROM media_immutable_objects
        WHERE immutable_ref = $1 AND submission_id = $2 FOR SHARE`,
      [request.sourceImmutableRef, boundRow.submission_id],
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
         (master_revision_id, plan_id, attempt_id, attempt_generation, plan_submission_id,
          source_immutable_ref, source_sha256, master_sha256, master_byte_length,
          master_ceiling_bytes, renderer_identity, renderer_policy_revision,
          decision_clip_start_samples, decision_clip_duration_samples)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        request.masterRevisionId,
        request.attempt.planId,
        request.attempt.attemptId,
        request.attempt.generation,
        boundRow.submission_id,
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
      "UPDATE media_song_video_render_attempts SET state = 'sealed' WHERE attempt_id = $1 AND plan_id = $2 AND state = 'started'",
      [request.attempt.attemptId, request.attempt.planId],
    );
    await client.query("COMMIT");
    return { sealed: true, masterRevisionId: request.masterRevisionId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/**
 * Accepts one master per plan by compare-and-set, and recognizes a replay of the
 * winning acceptance as success.
 *
 * Concurrency is resolved by the primary key rather than application ordering.
 * A conflict naming this same master is the lost-response case: the write
 * already succeeded and the response was lost, so it returns success and changes
 * nothing. Only a conflict naming a different master makes this attempt a loser.
 */
async function acceptMasterOnce(
  client: Client,
  input: {
    readonly planId: string;
    readonly masterRevisionId: string;
    readonly attemptId: string;
  },
): Promise<AcceptOutcome> {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    // Bind the master to this plan and attempt before accepting it, so three
    // independently valid identifiers cannot be combined into work that was
    // never rendered together.
    const bound = await client.query(
      `SELECT 1 FROM media_song_video_masters
        WHERE master_revision_id = $1 AND plan_id = $2 AND attempt_id = $3`,
      [input.masterRevisionId, input.planId, input.attemptId],
    );
    if (bound.rowCount !== 1) {
      await client.query("ROLLBACK");
      throw new Error("master, plan and attempt do not describe the same work");
    }
    const inserted = await client.query(
      `INSERT INTO media_song_video_accepted_masters (plan_id, master_revision_id)
       VALUES ($1,$2) ON CONFLICT (plan_id) DO NOTHING
       RETURNING master_revision_id`,
      [input.planId, input.masterRevisionId],
    );
    if (inserted.rowCount === 1) {
      await client.query(
        "UPDATE media_song_video_render_attempts SET state = 'accepted' WHERE attempt_id = $1 AND plan_id = $2",
        [input.attemptId, input.planId],
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
    if (winningMasterRevisionId === input.masterRevisionId) {
      // Replay of the winning acceptance. Return success without touching the
      // attempt, which is already accepted.
      await client.query("COMMIT");
      return { accepted: true, masterRevisionId: winningMasterRevisionId };
    }
    await client.query(
      "UPDATE media_song_video_render_attempts SET state = 'loser', disposition = 'not_first_accepted_master' WHERE attempt_id = $1 AND plan_id = $2",
      [input.attemptId, input.planId],
    );
    await client.query("COMMIT");
    return { accepted: false, winningMasterRevisionId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/**
 * Bounded retry around the serializable acceptance. Concurrent acceptance can
 * raise SQLSTATE 40001; a retry observes the committed winner rather than
 * producing a second one.
 */
export async function acceptMaster(
  client: Client,
  input: {
    readonly planId: string;
    readonly masterRevisionId: string;
    readonly attemptId: string;
  },
): Promise<AcceptOutcome> {
  let lastError: unknown;
  for (let retry = 0; retry < 5; retry += 1) {
    try {
      return await acceptMasterOnce(client, input);
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !("code" in error) || error.code !== "40001") throw error;
      await Bun.sleep(10 * (retry + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("acceptance retry exhausted");
}

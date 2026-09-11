/**
 * Persistence for the Spec 013 Gate A song-video identities.
 *
 * This adapter owns part of the obligation the typed contracts cannot
 * discharge. Sealing binds a master to the source object PostgreSQL holds for
 * this plan's submission, and refuses when it cannot.
 *
 * The evidence is narrow and should be described that way. The source binding
 * reads stored digest metadata, not source bytes: it establishes that the
 * claimed digest matches what the database recorded when the source was sealed
 * for this submission, not that those bytes exist or still hash to that value.
 *
 * The master is different. Its digest, byte length and measured facts come from
 * the rendered output's actual bytes, resolved through the dispatch binding
 * recorded before execution, so none of them is a caller claim. The prober
 * behind those measured facts remains a port, so this establishes binding and
 * hashing rather than real media verification.
 *
 * U.6 was adopted on 2026-09-09. Sealing uses the ratified ceiling, not a
 * request value, and records the applied ceiling per master. This source
 * implementation does not authorize staging execution.
 */

import { SONG_VIDEO_MASTER_POLICY_V1 } from "@pirate/domain";
import type { Client } from "pg";

import {
  type SongVideoOutputProbe,
  type SongVideoOutputStore,
  verifyRenderedOutput,
} from "./song-video-output-verification.ts";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

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
  | {
      readonly kind: "attempt_state_incompatible";
      readonly attemptId: string;
      readonly state: string;
    }
  | { readonly kind: "seal_transition_lost"; readonly attemptId: string }
  | { readonly kind: "output_not_verified"; readonly reason: string }
  | { readonly kind: "output_changed_during_seal"; readonly objectKey: string }
  | { readonly kind: "soundtrack_not_canonical"; readonly planId: string }
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

/** Recorded before the renderer executes; sealing resolves the output through it. */
export type RenderDispatch = {
  readonly outputObjectKey: string;
  readonly rendererIdentity: string;
  readonly rendererPolicyRevision: number;
};

export type SealRequest = {
  readonly masterRevisionId: string;
  readonly attempt: PersistedAttempt;
  readonly sourceImmutableRef: string;
  /** A claim about which source was used, checked here against stored bytes. */
  readonly claimedSourceSha256: string;

  readonly decisionClipStartSamples: number;
  readonly decisionClipDurationSamples: number;
};

/**
 * Binds a master's soundtrack to the selected song. Both digests come from the
 * same pinned decode chain the canonical duration was measured with, so equal
 * digests mean the master's audio is the canonical interval bit for bit.
 */
export type SongVideoSoundtrackVerifier = {
  /** The canonical interval, decoded from the song's exact bytes; null when they do not verify. */
  readonly canonicalIntervalDigest: (input: {
    readonly songAssetId: string;
    readonly canonicalAudioSha256: string;
    readonly songDurationSamples: number;
    readonly clipStartSamples: number;
    readonly clipDurationSamples: number;
  }) => Promise<string | null>;
  /** The master's audio track, decoded; null when it cannot be decoded. */
  readonly decodedSoundtrackDigest: (masterBytes: Uint8Array) => Promise<string | null>;
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
export async function startRenderAttempt(
  client: Client,
  attempt: PersistedAttempt,
  dispatch: RenderDispatch,
): Promise<void> {
  await client.query(
    `INSERT INTO media_song_video_render_attempts
       (attempt_id, plan_id, generation, state, dispatch_output_key,
        dispatch_renderer_identity, dispatch_renderer_policy_revision)
     VALUES ($1,$2,$3,'started',$4,$5,$6)`,
    [
      attempt.attemptId,
      attempt.planId,
      attempt.generation,
      dispatch.outputObjectKey,
      dispatch.rendererIdentity,
      dispatch.rendererPolicyRevision,
    ],
  );
}

/**
 * Verifies the rendered output and seals a master in one operation.
 *
 * This function is the verification boundary. The frozen work and the dispatch
 * binding are loaded from persistence, the output is resolved through that
 * binding rather than chosen by the caller, and the measured identity and facts
 * are persisted with the master.
 *
 * The schema's required verified columns make an unverified master unrecordable,
 * which is a guarantee that the metadata exists. It is not a guarantee that
 * verification occurred: only this path establishes that, so a future writer
 * reaching the tables directly would bypass it. Keep insertion of masters to
 * this function.
 */
export async function verifyAndSealMaster(
  client: Client,
  dependencies: {
    readonly store: SongVideoOutputStore;
    readonly prober: SongVideoOutputProbe;
    readonly soundtrack: SongVideoSoundtrackVerifier;
  },
  request: SealRequest,
): Promise<SealOutcome> {
  await client.query("BEGIN");
  try {
    // Read the plan and the attempt together, keyed on the pair, so an attempt
    // belonging to a different plan cannot be presented as this plan's work.
    const bound = await client.query<{
      submission_id: string;
      song_asset_id: string;
      song_duration_samples: string;
      canonical_audio_sha256: string;
      clip_start_samples: string;
      clip_duration_samples: string;
      generation: number;
      state: string;
      dispatch_output_key: string;
      dispatch_renderer_identity: string;
      dispatch_renderer_policy_revision: number;
    }>(
      // The canonical bytes' digest is the reservation's, reached through the
      // submission, so the soundtrack is judged against the song that was frozen.
      `SELECT p.submission_id, p.song_asset_id, p.song_duration_samples,
              r.canonical_audio_sha256, p.clip_start_samples, p.clip_duration_samples,
              a.generation, a.state, a.dispatch_output_key,
              a.dispatch_renderer_identity, a.dispatch_renderer_policy_revision
         FROM media_song_video_render_plans p
         JOIN media_post_submissions s ON s.submission_id = p.submission_id
         JOIN media_video_reservation_song_plans r ON r.reservation_id = s.audio_reservation_id
         JOIN media_song_video_render_attempts a
           ON a.plan_id = p.plan_id AND a.attempt_id = $2
        WHERE p.plan_id = $1
        FOR UPDATE OF a`,
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
    // The attempt must be in a state a seal can follow. An identical replay of a
    // seal that already committed is success; anything else is refused before a
    // master row is written.
    if (boundRow.state !== "started") {
      const existing = await client.query<{
        master_revision_id: string;
        verified_object_key: string;
      }>(
        `SELECT master_revision_id, verified_object_key
           FROM media_song_video_masters WHERE attempt_id = $1 AND plan_id = $2`,
        [request.attempt.attemptId, request.attempt.planId],
      );
      const priorMaster = existing.rows[0];
      // Replay is judged on the persisted verified object, not on caller facts.
      const identicalReplay =
        priorMaster !== undefined &&
        priorMaster.master_revision_id === request.masterRevisionId &&
        priorMaster.verified_object_key === boundRow.dispatch_output_key;
      await client.query(identicalReplay ? "COMMIT" : "ROLLBACK");
      return identicalReplay
        ? { sealed: true, masterRevisionId: priorMaster.master_revision_id }
        : {
            sealed: false,
            failure: {
              kind: "attempt_state_incompatible",
              attemptId: request.attempt.attemptId,
              state: boundRow.state,
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
    // Verify the completed output against the work just loaded from persistence,
    // not against anything the caller asserted about it.
    const verification = await verifyRenderedOutput({
      store: dependencies.store,
      prober: dependencies.prober,
      objectKey: boundRow.dispatch_output_key,
      planClipDurationSamples: Number(boundRow.clip_duration_samples),
      sourceSha256: row.canonical_sha256,
      masterCeilingBytes: SONG_VIDEO_MASTER_POLICY_V1.maxBytes,
    });
    if (!verification.verified) {
      await client.query("ROLLBACK");
      return {
        sealed: false,
        failure: { kind: "output_not_verified", reason: verification.failure.kind },
      };
    }
    const verified = verification.output;
    // Re-resolve the exact verified version before committing. Reading the key
    // again would only see whatever is current; reading the version proves the
    // identity being sealed still resolves to the bytes that were verified.
    const reread = await dependencies.store.readVersion(
      boundRow.dispatch_output_key,
      verified.objectVersion,
    );
    if (reread === null || (await sha256Hex(reread)) !== verified.masterSha256) {
      await client.query("ROLLBACK");
      return {
        sealed: false,
        failure: { kind: "output_changed_during_seal", objectKey: boundRow.dispatch_output_key },
      };
    }
    // The verified bytes' audio must be the frozen interval of the frozen song.
    // A master of equal length cut from another song, or from another interval
    // of this one, decodes to different samples and is refused here.
    const [expectedSoundtrack, soundtrackSha256] = await Promise.all([
      dependencies.soundtrack.canonicalIntervalDigest({
        songAssetId: boundRow.song_asset_id,
        canonicalAudioSha256: boundRow.canonical_audio_sha256,
        songDurationSamples: Number(boundRow.song_duration_samples),
        clipStartSamples: Number(boundRow.clip_start_samples),
        clipDurationSamples: Number(boundRow.clip_duration_samples),
      }),
      dependencies.soundtrack.decodedSoundtrackDigest(reread),
    ]);
    if (
      expectedSoundtrack === null ||
      soundtrackSha256 === null ||
      expectedSoundtrack !== soundtrackSha256
    ) {
      await client.query("ROLLBACK");
      return {
        sealed: false,
        failure: { kind: "soundtrack_not_canonical", planId: request.attempt.planId },
      };
    }
    await client.query(
      `INSERT INTO media_song_video_masters
         (master_revision_id, plan_id, attempt_id, attempt_generation, plan_submission_id,
          source_immutable_ref, source_sha256, master_sha256, master_byte_length,
          master_ceiling_bytes, renderer_identity, renderer_policy_revision,
          decision_clip_start_samples, decision_clip_duration_samples,
          verified_object_key, verified_object_version, verified_object_etag,
          measured_video_duration_samples,
          measured_audio_duration_samples, measured_audio_sample_rate_hz, measured_audio_channels,
          master_policy_revision, soundtrack_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
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
        verified.masterSha256,
        verified.masterByteLength,
        SONG_VIDEO_MASTER_POLICY_V1.maxBytes,
        boundRow.dispatch_renderer_identity,
        boundRow.dispatch_renderer_policy_revision,
        request.decisionClipStartSamples,
        request.decisionClipDurationSamples,
        verified.objectKey,
        verified.objectVersion,
        verified.objectEtag,
        verified.probe.videoDurationSamples,
        verified.probe.audioDurationSamples,
        verified.probe.audioSampleRateHz,
        verified.probe.audioChannels,
        SONG_VIDEO_MASTER_POLICY_V1.policyRevision,
        soundtrackSha256,
      ],
    );
    const transitioned = await client.query(
      "UPDATE media_song_video_render_attempts SET state = 'sealed' WHERE attempt_id = $1 AND plan_id = $2 AND state = 'started'",
      [request.attempt.attemptId, request.attempt.planId],
    );
    if (transitioned.rowCount !== 1) {
      // The row was locked above, so this should be unreachable. Refusing rather
      // than committing keeps a master from existing over an untransitioned
      // attempt if that assumption ever fails.
      await client.query("ROLLBACK");
      return {
        sealed: false,
        failure: { kind: "seal_transition_lost", attemptId: request.attempt.attemptId },
      };
    }
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

/** Worker-compatible delay. Bun.sleep is not available in the Workers runtime. */
function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export type AcceptRetryOptions = {
  /** Injectable so a test can observe the retry path without wall-clock waits. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly onSerializationRetry?: (attempt: number) => void;
};

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
  options: AcceptRetryOptions = {},
): Promise<AcceptOutcome> {
  const sleep = options.sleep ?? delay;
  let lastError: unknown;
  for (let retry = 0; retry < 5; retry += 1) {
    try {
      return await acceptMasterOnce(client, input);
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !("code" in error) || error.code !== "40001") throw error;
      options.onSerializationRetry?.(retry + 1);
      await sleep(10 * (retry + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("acceptance retry exhausted");
}

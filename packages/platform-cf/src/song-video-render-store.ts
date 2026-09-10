import type {
  SongVideoRenderAttempt,
  SongVideoRenderStore,
} from "@pirate/application/video/song-render";
import type { AcceptedSongVideoMaster } from "@pirate/domain";
import type { Client } from "pg";
import type {
  SongVideoOutputProbe,
  SongVideoOutputStore,
} from "./song-video-output-verification.ts";
import {
  acceptMaster,
  type SongVideoSoundtrackVerifier,
  startRenderAttempt,
  verifyAndSealMaster,
} from "./song-video-render-repository.ts";

/**
 * The render stage's store, over the Gate A render identities: attempts are
 * recorded before dispatch, masters exist only through verified sealing, and
 * acceptance is the plan's compare-and-set.
 *
 * It runs on a dedicated PostgreSQL connection per operation because sealing
 * and acceptance manage their own transactions. That makes it a host-side
 * adapter: the renderer it serves runs FFmpeg, which a Worker cannot.
 */
export function makeSongVideoRenderStore(
  input: Readonly<{
    connect: () => Promise<Client>;
    output: SongVideoOutputStore;
    prober: SongVideoOutputProbe;
    soundtrack: SongVideoSoundtrackVerifier;
  }>,
): SongVideoRenderStore {
  const withClient = async <T>(use: (client: Client) => Promise<T>): Promise<T> => {
    const client = await input.connect();
    try {
      return await use(client);
    } finally {
      await client.end();
    }
  };

  const acceptedMaster = (client: Client, planId: string) =>
    client
      .query<{
        master_revision_id: string;
        attempt_id: string;
        verified_object_key: string;
        master_sha256: string;
        master_byte_length: string;
        soundtrack_sha256: string;
      }>(
        `SELECT m.master_revision_id, m.attempt_id, m.verified_object_key, m.master_sha256,
                m.master_byte_length, m.soundtrack_sha256
           FROM media_song_video_accepted_masters a
           JOIN media_song_video_masters m
             ON m.master_revision_id = a.master_revision_id AND m.plan_id = a.plan_id
          WHERE a.plan_id = $1`,
        [planId],
      )
      .then((result): AcceptedSongVideoMaster | null => {
        const row = result.rows[0];
        if (row === undefined) return null;
        return {
          masterRevisionId: row.master_revision_id,
          attemptId: row.attempt_id,
          masterRef: row.verified_object_key,
          masterSha256: row.master_sha256,
          masterByteLength: Number(row.master_byte_length),
          soundtrackSha256: row.soundtrack_sha256,
        };
      });

  return {
    acceptedMaster: (planId) => withClient((client) => acceptedMaster(client, planId)),

    dispatch: (request) =>
      withClient(async (client) => {
        for (let tries = 0; tries < 3; tries += 1) {
          const latest = await client.query<{
            attempt_id: string;
            generation: number;
            state: string;
            dispatch_output_key: string;
          }>(
            `SELECT attempt_id, generation, state, dispatch_output_key
               FROM media_song_video_render_attempts
              WHERE plan_id = $1 ORDER BY generation DESC LIMIT 1`,
            [request.planId],
          );
          const row = latest.rows[0];
          // A started or sealed attempt is resumed, never duplicated.
          if (row !== undefined && (row.state === "started" || row.state === "sealed")) {
            const attempt: SongVideoRenderAttempt = {
              attemptId: row.attempt_id,
              planId: request.planId,
              generation: row.generation,
              outputObjectKey: row.dispatch_output_key,
            };
            return attempt;
          }
          const generation = (row?.generation ?? 0) + 1;
          const attempt: SongVideoRenderAttempt = {
            attemptId: `${request.planId}:g${generation}`,
            planId: request.planId,
            generation,
            outputObjectKey: `song-video-masters/${request.planId}/g${generation}`,
          };
          try {
            await startRenderAttempt(
              client,
              { attemptId: attempt.attemptId, planId: attempt.planId, generation },
              {
                outputObjectKey: attempt.outputObjectKey,
                rendererIdentity: request.rendererIdentity,
                rendererPolicyRevision: request.rendererPolicyRevision,
              },
            );
            return attempt;
          } catch (error) {
            // Another dispatcher recorded this generation first; read it back.
            if ((error as { code?: unknown }).code !== "23505") throw error;
          }
        }
        throw new Error("song video render attempt could not be recorded");
      }),

    sealAndAccept: (request) =>
      withClient(async (client) => {
        const masterRevisionId = `${request.attempt.attemptId}:master`;
        const sealed = await verifyAndSealMaster(
          client,
          { store: input.output, prober: input.prober, soundtrack: input.soundtrack },
          {
            masterRevisionId,
            attempt: {
              attemptId: request.attempt.attemptId,
              planId: request.attempt.planId,
              generation: request.attempt.generation,
            },
            sourceImmutableRef: request.sourceImmutableRef,
            claimedSourceSha256: request.claimedSourceSha256,
            decisionClipStartSamples: request.clipStartSamples,
            decisionClipDurationSamples: request.clipDurationSamples,
          },
        );
        if (!sealed.sealed) return { status: "refused", reason: sealed.failure.kind };
        // Losing the compare-and-set is not a failure: the plan has a master,
        // and it is the winner that publishes.
        await acceptMaster(client, {
          planId: request.attempt.planId,
          masterRevisionId,
          attemptId: request.attempt.attemptId,
        });
        const master = await acceptedMaster(client, request.attempt.planId);
        if (master === null) throw new Error("accepted song video master is not observable");
        return { status: "accepted", master };
      }),
  };
}

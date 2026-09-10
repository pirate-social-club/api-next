import type { AcceptedSongVideoMaster } from "../../../domain/src/video-submission.ts";

/**
 * Spec 013 §5A render stage ports.
 *
 * Rendering is one more capability of the video workflow, not a job system of
 * its own: an attempt is recorded before its renderer runs, the renderer writes
 * to the output address that attempt was dispatched to, and the output becomes
 * a master only through sealing, which verifies the bytes it reads back rather
 * than anything the renderer reported. Acceptance is a compare-and-set on the
 * plan, so exactly one master can be published for it.
 */

/** One render attempt, recorded before its renderer runs. */
export type SongVideoRenderAttempt = Readonly<{
  attemptId: string;
  planId: string;
  generation: number;
  outputObjectKey: string;
}>;

export type SongVideoSealOutcome =
  | Readonly<{ status: "accepted"; master: AcceptedSongVideoMaster }>
  | Readonly<{ status: "refused"; reason: string }>;

export interface SongVideoRenderStore {
  /** The master the plan's compare-and-set accepted, exactly as it was sealed. */
  readonly acceptedMaster: (planId: string) => Promise<AcceptedSongVideoMaster | null>;
  /**
   * The plan's started attempt, or a new one recorded at the next generation.
   * Recorded before dispatch, so a stopped worker is always attributable.
   */
  readonly dispatch: (
    input: Readonly<{ planId: string; rendererIdentity: string; rendererPolicyRevision: number }>,
  ) => Promise<SongVideoRenderAttempt>;
  /**
   * Verifies the attempt's output against the frozen plan and the sealed
   * source, seals it as a master, and accepts it for the plan.
   */
  readonly sealAndAccept: (
    input: Readonly<{
      attempt: SongVideoRenderAttempt;
      sourceImmutableRef: string;
      claimedSourceSha256: string;
      clipStartSamples: number;
      clipDurationSamples: number;
    }>,
  ) => Promise<SongVideoSealOutcome>;
}

export interface SongVideoRenderer {
  readonly identity: string;
  readonly policyRevision: number;
  /**
   * Renders the interval of the canonical song over the capture's picture and
   * writes the master to `outputObjectKey`. A refusal is a responsibility
   * failure; nothing is padded, stretched or substituted to avoid one.
   */
  readonly render: (
    input: Readonly<{
      outputObjectKey: string;
      source: Readonly<{ immutableRef: string; sha256: string; byteLength: number }>;
      song: Readonly<{ assetRef: string; sha256: string; durationSamples: number }>;
      clipStartSamples: number;
      clipDurationSamples: number;
    }>,
  ) => Promise<Readonly<{ status: "completed" }> | Readonly<{ status: "refused"; reason: string }>>;
}

export type SongVideoRenderServices = Readonly<{
  store: SongVideoRenderStore;
  renderer: SongVideoRenderer;
}>;

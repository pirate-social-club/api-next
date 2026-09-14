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
 *
 * An attempt executes at most once. The intent to execute is recorded before
 * the renderer is invoked; once recorded, the execution may have begun, so a
 * lost response or a retried step only observes it. A new attempt is started
 * only after an explicit refusal abandons the old one.
 */

/** One render attempt, recorded before its renderer runs. */
export type SongVideoRenderAttempt = Readonly<{
  attemptId: string;
  planId: string;
  generation: number;
  outputObjectKey: string;
  /**
   * `recorded`: never executed. `submitting` or `submitted`: may have executed,
   * so only observed from now on. `sealed`: its output is a sealed master that
   * has not been accepted yet, resumed at acceptance without rendering again.
   */
  phase: "recorded" | "submitting" | "submitted" | "sealed";
  /** When execution was first begun; the observation window runs from here. */
  executionStartedAtMs: number | null;
}>;

export type SongVideoSealOutcome =
  | Readonly<{ status: "accepted"; master: AcceptedSongVideoMaster }>
  | Readonly<{ status: "refused"; reason: string }>;

/**
 * What one execution of an attempt established, recorded against that attempt
 * before its output is written. Observation resolves an address from this
 * retained evidence, never from an object's presence: bytes that do not match
 * the execution that owns the address are not that execution's output. A
 * missing record means no execution has been established there yet, so the
 * address stays unresolved rather than completed.
 */
export type SongVideoExecutionRecord =
  | Readonly<{ kind: "output"; sha256: string; byteLength: number }>
  | Readonly<{ kind: "refused"; reason: string }>;

export interface SongVideoExecutionEvidenceStore {
  /**
   * Records the execution's measured outcome under its output address. The
   * first record wins; an identical replay is accepted and a different one is
   * refused, so a crossed execution cannot replace another's evidence.
   */
  readonly recordExecution: (
    outputObjectKey: string,
    record: SongVideoExecutionRecord,
  ) => Promise<void>;
  /** The evidence recorded for that address, or null when none exists. */
  readonly executionEvidence: (outputObjectKey: string) => Promise<SongVideoExecutionRecord | null>;
}

export interface SongVideoRenderStore extends SongVideoExecutionEvidenceStore {
  /** The master the plan's compare-and-set accepted, exactly as it was sealed. */
  readonly acceptedMaster: (planId: string) => Promise<AcceptedSongVideoMaster | null>;
  /**
   * The plan's live attempt (started or sealed), or a new one recorded at the
   * next generation when the last was abandoned or lost. Recorded before any
   * execution, so a stopped worker is always attributable.
   */
  readonly dispatch: (
    input: Readonly<{ planId: string; rendererIdentity: string; rendererPolicyRevision: number }>,
  ) => Promise<SongVideoRenderAttempt>;
  /** The attempt as currently recorded. */
  readonly readAttempt: (attempt: SongVideoRenderAttempt) => Promise<SongVideoRenderAttempt>;
  /**
   * Records the intent to execute, once. False when execution may already have
   * begun: the caller must then observe the attempt and never execute it.
   */
  readonly beginExecution: (attempt: SongVideoRenderAttempt) => Promise<boolean>;
  /** The renderer acknowledged the submission. */
  readonly markSubmitted: (attempt: SongVideoRenderAttempt) => Promise<void>;
  /** An explicit refusal: the attempt is finished and a retry starts a new one. */
  readonly abandon: (attempt: SongVideoRenderAttempt, disposition: string) => Promise<void>;
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

export type SongVideoRenderRequest = Readonly<{
  outputObjectKey: string;
  source: Readonly<{ immutableRef: string; sha256: string; byteLength: number }>;
  song: Readonly<{ assetRef: string; sha256: string; durationSamples: number }>;
  clipStartSamples: number;
  clipDurationSamples: number;
}>;

/**
 * The host's write-once output destination. An attempt's output address is
 * written at most once: a second write reports `occupied` instead of replacing
 * bytes. That is what lets a lost write acknowledgement or a restarted
 * execution reconcile from what the store actually holds, and it keeps a
 * retried or crossed attempt from overwriting the object sealing will read.
 */
export type SongVideoOutputWrite =
  | Readonly<{ status: "written" }>
  | Readonly<{ status: "occupied" }>;

export interface SongVideoOutputWriter {
  /**
   * Writes `bytes` only if the address holds no object. `sha256` is the
   * digest measured over those bytes by the caller, so an implementation may
   * record it with the object and verify the written identity.
   */
  readonly writeOnce: (
    outputObjectKey: string,
    bytes: Uint8Array,
    sha256: string,
  ) => Promise<SongVideoOutputWrite>;
}

export interface SongVideoRenderer {
  readonly identity: string;
  readonly policyRevision: number;
  /**
   * Starts rendering the interval of the canonical song over the capture's
   * picture into `outputObjectKey`. Called at most once per attempt. A refusal
   * is a responsibility failure; nothing is padded, stretched or substituted to
   * avoid one.
   */
  readonly submit: (
    request: SongVideoRenderRequest,
  ) => Promise<Readonly<{ status: "submitted" }> | Readonly<{ status: "refused"; reason: string }>>;
  /**
   * Reports an attempt from durable evidence only: its output exists, it was
   * refused, or neither yet. An absent output is pending, never a refusal.
   */
  readonly observe: (
    input: Readonly<{ outputObjectKey: string }>,
  ) => Promise<
    | Readonly<{ status: "completed" }>
    | Readonly<{ status: "pending" }>
    | Readonly<{ status: "refused"; reason: string }>
  >;
}

export type SongVideoRenderServices = Readonly<{
  store: SongVideoRenderStore;
  renderer: SongVideoRenderer;
}>;

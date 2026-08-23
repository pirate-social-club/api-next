/**
 * Pure Spec 013 song-media persistence machine.
 *
 * Creation input, immutable audio identity, trusted analysis, and publication
 * decisions have independent revision fences. Persistence adapters must call
 * this reducer before writing a projection; provider and transport authority do
 * not belong here.
 */

export type SongType = "original" | "remix";
export type MediaSubmissionStatus =
  | "awaiting_upload"
  | "analyzing"
  | "decision_pending"
  | "ready_to_publish"
  | "manual_review"
  | "published"
  | "blocked"
  | "failed"
  | "abandoned";
export type MediaSubmissionPhase = "upload" | "analysis" | "decision" | "publication" | null;

export type SongTerms = Readonly<{
  licensePreset: "non-commercial" | "commercial-use" | "commercial-remix";
  commercialRemixShareBps: number;
  royaltyAllocations: readonly Readonly<{
    recipientId: string;
    shareBps: number;
  }>[];
  accessMode: "public";
}>;

export type ImmutableAudio = Readonly<{
  audioRevision: number;
  immutableRef: string;
  canonicalSha256: string;
  contentType: string;
  sizeBytes: number;
}>;

export type CoverAnalysis =
  | Readonly<{
      status: "ready";
      artifactRef: string;
      artifactSha256: string;
      mediaType: "image/jpeg" | "image/png" | "image/webp";
      normalizationRevision: string;
      safetyPolicyRevision: string;
    }>
  | Readonly<{ status: "absent"; reasonCode: "not_embedded" }>
  | Readonly<{
      status: "rejected";
      reasonCode: "invalid" | "unsafe" | "limits_exceeded";
    }>;

export type SpeechAnalysis =
  | Readonly<{
      status: "ready";
      transcriptArtifactRef: string;
      transcriptSha256: string;
      explicitness: "not_explicit" | "explicit" | "uncertain";
      primaryLanguageBcp47: string;
      secondaryLanguageBcp47: string | null;
      evidenceRef: string;
      policyRevision: string;
      adapterRevision: string;
    }>
  | Readonly<{
      status: "no_speech";
      explicitness: "no_lyrics";
      evidenceRef: string;
      policyRevision: string;
      adapterRevision: string;
    }>
  | Readonly<{
      status: "unavailable";
      explicitness: "uncertain";
      evidenceRef: string;
      policyRevision: string;
      adapterRevision: string;
    }>;

export type TrustedSongAnalysis = Readonly<{
  analysisRevision: number;
  audioRevision: number;
  canonicalAudioSha256: string;
  finalizedAudioRef: string;
  probeEvidenceRef: string;
  embeddedMetadataEvidenceRef: string;
  embeddedTitle: string | null;
  cover: CoverAnalysis;
  speech: SpeechAnalysis;
  acrDecision: "allow" | "requires_reference" | "inconclusive" | "skipped";
  acrEvidenceRef: string;
  acrPolicyRevision: string;
  acrAdapterRevision: string;
  mediaSafety: "allow" | "draft" | "review_required" | "blocked";
  lyricsSafety: "skipped" | "allow" | "review_required" | "blocked";
}>;

export type PublicationDecision = Readonly<{
  decisionRevision: number;
  outcome: "allow" | "manual_review" | "block";
  creationRevision: number;
  audioRevision: number;
  analysisRevision: number;
  canonicalAudioSha256: string;
  policyRevision: string;
  evidenceRef: string;
}>;

export type MediaSubmissionState = Readonly<{
  submissionId: string;
  operationId: string;
  communityId: string;
  actorId: string;
  title: string;
  songType: SongType;
  reservationId: string;
  creationRevision: number;
  audioRevision: number;
  analysisRevision: number;
  decisionRevision: number;
  workflowRevision: number;
  status: MediaSubmissionStatus;
  phase: MediaSubmissionPhase;
  terms: SongTerms | null;
  audio: ImmutableAudio | null;
  analysis: TrustedSongAnalysis | null;
  decision: PublicationDecision | null;
  postId: string | null;
  failureCode: string | null;
}>;

export type MediaSubmissionCommand =
  | Readonly<{
      event: "submission_created";
      actorId: string;
      expectedCreationRevision: 0;
      submissionId: string;
      operationId: string;
      communityId: string;
      title: string;
      songType: SongType;
      reservationId: string;
    }>
  | Readonly<{
      event: "terms_bound";
      actorId: string;
      expectedCreationRevision: number;
      terms: SongTerms;
    }>
  | Readonly<{
      event: "audio_finalized";
      actorId: string;
      expectedCreationRevision: number;
      expectedAudioRevision: number;
      audio: ImmutableAudio;
    }>
  | Readonly<{
      event: "analysis_accepted";
      actorId: string;
      expectedAudioRevision: number;
      expectedCanonicalAudioSha256: string;
      analysis: TrustedSongAnalysis;
    }>
  | Readonly<{
      event: "decision_recorded";
      actorId: string;
      expectedCreationRevision: number;
      expectedAudioRevision: number;
      expectedAnalysisRevision: number;
      decision: PublicationDecision;
    }>
  | Readonly<{
      event: "publication_committed";
      actorId: string;
      expectedCreationRevision: number;
      expectedAudioRevision: number;
      expectedAnalysisRevision: number;
      expectedDecisionRevision: number;
      communityActive: boolean;
      membershipActive: boolean;
      postId: string;
    }>
  | Readonly<{
      event: "submission_failed" | "submission_abandoned";
      actorId: string;
      expectedCreationRevision: number;
      failureCode: string;
    }>;

export type MediaSubmissionRejection =
  | Readonly<{ tag: "invalid_state"; defect: string }>
  | Readonly<{ tag: "transition_not_allowed"; event: MediaSubmissionCommand["event"] }>
  | Readonly<{ tag: "actor_not_authorized" }>
  | Readonly<{ tag: "inactive_community_effect" }>
  | Readonly<{
      tag: "stale_revision";
      revision: "creation" | "audio" | "analysis" | "decision";
      expected: number;
      actual: number;
    }>
  | Readonly<{ tag: "audio_identity_mismatch" }>
  | Readonly<{ tag: "decision_evidence_incomplete" }>;

export type MediaSubmissionResult =
  | Readonly<{ ok: true; state: MediaSubmissionState }>
  | Readonly<{ ok: false; rejection: MediaSubmissionRejection }>;

const idPattern = /^\S(?:.*\S)?$/u;
const hashPattern = /^[0-9a-f]{64}$/u;

const validId = (value: string): boolean =>
  value.length > 0 && value.length <= 512 && !value.includes("\u0000") && idPattern.test(value);
const validRevision = (value: number, minimum = 0): boolean =>
  Number.isSafeInteger(value) && value >= minimum;
const validHash = (value: string): boolean => hashPattern.test(value);

export const deterministicMediaWorkflowInstanceId = (
  operationId: string,
  workflowRevision: number,
): string => `${operationId}:workflow:${workflowRevision}`;

export function mediaSubmissionInvariant(state: MediaSubmissionState): string | null {
  if (
    !validId(state.submissionId) ||
    !validId(state.operationId) ||
    !validId(state.communityId) ||
    !validId(state.actorId) ||
    !validId(state.title) ||
    !validId(state.reservationId)
  )
    return "identity";
  if (
    !validRevision(state.creationRevision, 1) ||
    !validRevision(state.audioRevision) ||
    !validRevision(state.analysisRevision) ||
    !validRevision(state.decisionRevision) ||
    !validRevision(state.workflowRevision)
  )
    return "revision";
  if ((state.audioRevision === 0) !== (state.audio === null)) return "audio_presence";
  if (state.audio !== null) {
    if (
      state.audio.audioRevision !== state.audioRevision ||
      !validId(state.audio.immutableRef) ||
      !validHash(state.audio.canonicalSha256) ||
      !validId(state.audio.contentType) ||
      !validRevision(state.audio.sizeBytes, 1)
    )
      return "audio_identity";
  }
  if ((state.analysisRevision === 0) !== (state.analysis === null)) return "analysis_presence";
  if (state.analysis !== null) {
    if (
      state.audio === null ||
      state.analysis.analysisRevision !== state.analysisRevision ||
      state.analysis.audioRevision !== state.audioRevision ||
      state.analysis.canonicalAudioSha256 !== state.audio.canonicalSha256 ||
      state.analysis.finalizedAudioRef !== state.audio.immutableRef
    )
      return "analysis_identity";
  }
  if ((state.decisionRevision === 0) !== (state.decision === null)) return "decision_presence";
  if (state.decision !== null) {
    if (
      state.analysis === null ||
      state.audio === null ||
      state.decision.decisionRevision !== state.decisionRevision ||
      state.decision.creationRevision !== state.creationRevision ||
      state.decision.audioRevision !== state.audioRevision ||
      state.decision.analysisRevision !== state.analysisRevision ||
      state.decision.canonicalAudioSha256 !== state.audio.canonicalSha256
    )
      return "decision_identity";
  }
  if (state.status === "awaiting_upload" && state.phase !== "upload") return "upload_phase";
  if (state.status === "analyzing" && state.phase !== "analysis") return "analysis_phase";
  if (state.status === "decision_pending" && state.phase !== "decision") return "decision_phase";
  if (state.status === "ready_to_publish" && state.phase !== "publication")
    return "publication_phase";
  if (
    ["manual_review", "published", "blocked", "failed", "abandoned"].includes(state.status) &&
    state.phase !== null
  )
    return "terminal_phase";
  if (state.status === "ready_to_publish" && state.decision?.outcome !== "allow")
    return "publication_decision";
  if (state.status === "manual_review" && state.decision?.outcome !== "manual_review")
    return "review_decision";
  if (state.status === "blocked" && state.decision?.outcome !== "block") return "block_decision";
  if (
    state.status === "published" &&
    (!validId(state.postId ?? "") || state.decision?.outcome !== "allow")
  )
    return "published_post";
  if (
    (state.status === "failed" || state.status === "abandoned") &&
    !validId(state.failureCode ?? "")
  )
    return "failure_code";
  return null;
}

const rejected = (rejection: MediaSubmissionRejection): MediaSubmissionResult => ({
  ok: false,
  rejection,
});

const stale = (
  revision: "creation" | "audio" | "analysis" | "decision",
  expected: number,
  actual: number,
): MediaSubmissionResult => rejected({ tag: "stale_revision", revision, expected, actual });

const validTerms = (terms: SongTerms): boolean => {
  if (terms.accessMode !== "public") return false;
  if (
    !Number.isInteger(terms.commercialRemixShareBps) ||
    terms.commercialRemixShareBps < 0 ||
    terms.commercialRemixShareBps > 10_000
  )
    return false;
  if (terms.licensePreset !== "commercial-remix" && terms.commercialRemixShareBps !== 0)
    return false;
  if (terms.royaltyAllocations.length === 0) return false;
  const recipients = new Set<string>();
  let total = 0;
  for (const allocation of terms.royaltyAllocations) {
    if (
      !validId(allocation.recipientId) ||
      recipients.has(allocation.recipientId) ||
      !Number.isInteger(allocation.shareBps) ||
      allocation.shareBps < 1
    )
      return false;
    recipients.add(allocation.recipientId);
    total += allocation.shareBps;
  }
  return total === 10_000;
};

const nextDecisionStatus = (
  decision: PublicationDecision,
): Pick<MediaSubmissionState, "status" | "phase"> => {
  if (decision.outcome === "allow") return { status: "ready_to_publish", phase: "publication" };
  if (decision.outcome === "manual_review") return { status: "manual_review", phase: null };
  return { status: "blocked", phase: null };
};

export function transitionMediaSubmission(
  current: MediaSubmissionState | null,
  command: MediaSubmissionCommand,
): MediaSubmissionResult {
  if (!validId(command.actorId)) return rejected({ tag: "actor_not_authorized" });
  if (current === null) {
    if (command.event !== "submission_created")
      return rejected({ tag: "transition_not_allowed", event: command.event });
    const created: MediaSubmissionState = {
      submissionId: command.submissionId,
      operationId: command.operationId,
      communityId: command.communityId,
      actorId: command.actorId,
      title: command.title,
      songType: command.songType,
      reservationId: command.reservationId,
      creationRevision: 1,
      audioRevision: 0,
      analysisRevision: 0,
      decisionRevision: 0,
      workflowRevision: 0,
      status: "awaiting_upload",
      phase: "upload",
      terms: null,
      audio: null,
      analysis: null,
      decision: null,
      postId: null,
      failureCode: null,
    };
    const defect = mediaSubmissionInvariant(created);
    return defect === null
      ? { ok: true, state: created }
      : rejected({ tag: "invalid_state", defect });
  }

  const defect = mediaSubmissionInvariant(current);
  if (defect !== null) return rejected({ tag: "invalid_state", defect });
  if (current.actorId !== command.actorId) return rejected({ tag: "actor_not_authorized" });
  if (["published", "blocked", "abandoned"].includes(current.status))
    return rejected({ tag: "transition_not_allowed", event: command.event });

  let next: MediaSubmissionState;
  switch (command.event) {
    case "submission_created":
      return rejected({ tag: "transition_not_allowed", event: command.event });
    case "terms_bound": {
      if (command.expectedCreationRevision !== current.creationRevision)
        return stale("creation", command.expectedCreationRevision, current.creationRevision);
      if (!validTerms(command.terms)) return rejected({ tag: "invalid_state", defect: "terms" });
      const creationRevision = current.creationRevision + 1;
      next = {
        ...current,
        creationRevision,
        terms: command.terms,
        decisionRevision: 0,
        decision: null,
        status: current.analysis === null ? current.status : "decision_pending",
        phase: current.analysis === null ? current.phase : "decision",
      };
      break;
    }
    case "audio_finalized": {
      if (command.expectedCreationRevision !== current.creationRevision)
        return stale("creation", command.expectedCreationRevision, current.creationRevision);
      if (command.expectedAudioRevision !== current.audioRevision)
        return stale("audio", command.expectedAudioRevision, current.audioRevision);
      if (current.audio !== null || command.audio.audioRevision !== 1)
        return rejected({ tag: "transition_not_allowed", event: command.event });
      next = {
        ...current,
        audioRevision: 1,
        workflowRevision: current.workflowRevision + 1,
        audio: command.audio,
        status: "analyzing",
        phase: "analysis",
      };
      break;
    }
    case "analysis_accepted": {
      if (command.expectedAudioRevision !== current.audioRevision)
        return stale("audio", command.expectedAudioRevision, current.audioRevision);
      if (
        current.audio === null ||
        command.expectedCanonicalAudioSha256 !== current.audio.canonicalSha256 ||
        command.analysis.audioRevision !== current.audioRevision ||
        command.analysis.canonicalAudioSha256 !== current.audio.canonicalSha256 ||
        command.analysis.finalizedAudioRef !== current.audio.immutableRef
      )
        return rejected({ tag: "audio_identity_mismatch" });
      if (command.analysis.analysisRevision <= current.analysisRevision)
        return stale("analysis", command.analysis.analysisRevision, current.analysisRevision);
      next = {
        ...current,
        analysisRevision: command.analysis.analysisRevision,
        decisionRevision: 0,
        analysis: command.analysis,
        decision: null,
        status: "decision_pending",
        phase: "decision",
      };
      break;
    }
    case "decision_recorded": {
      if (command.expectedCreationRevision !== current.creationRevision)
        return stale("creation", command.expectedCreationRevision, current.creationRevision);
      if (command.expectedAudioRevision !== current.audioRevision)
        return stale("audio", command.expectedAudioRevision, current.audioRevision);
      if (command.expectedAnalysisRevision !== current.analysisRevision)
        return stale("analysis", command.expectedAnalysisRevision, current.analysisRevision);
      if (
        current.terms === null ||
        current.audio === null ||
        current.analysis === null ||
        command.decision.decisionRevision !== current.decisionRevision + 1 ||
        command.decision.creationRevision !== current.creationRevision ||
        command.decision.audioRevision !== current.audioRevision ||
        command.decision.analysisRevision !== current.analysisRevision ||
        command.decision.canonicalAudioSha256 !== current.audio.canonicalSha256
      )
        return rejected({ tag: "decision_evidence_incomplete" });
      next = {
        ...current,
        decisionRevision: command.decision.decisionRevision,
        decision: command.decision,
        ...nextDecisionStatus(command.decision),
      };
      break;
    }
    case "publication_committed": {
      if (command.expectedCreationRevision !== current.creationRevision)
        return stale("creation", command.expectedCreationRevision, current.creationRevision);
      if (command.expectedAudioRevision !== current.audioRevision)
        return stale("audio", command.expectedAudioRevision, current.audioRevision);
      if (command.expectedAnalysisRevision !== current.analysisRevision)
        return stale("analysis", command.expectedAnalysisRevision, current.analysisRevision);
      if (command.expectedDecisionRevision !== current.decisionRevision)
        return stale("decision", command.expectedDecisionRevision, current.decisionRevision);
      if (!command.communityActive || !command.membershipActive)
        return rejected({ tag: "inactive_community_effect" });
      if (current.status !== "ready_to_publish" || current.decision?.outcome !== "allow")
        return rejected({ tag: "transition_not_allowed", event: command.event });
      next = {
        ...current,
        workflowRevision: current.workflowRevision + 1,
        status: "published",
        phase: null,
        postId: command.postId,
      };
      break;
    }
    case "submission_failed":
    case "submission_abandoned": {
      if (command.expectedCreationRevision !== current.creationRevision)
        return stale("creation", command.expectedCreationRevision, current.creationRevision);
      next = {
        ...current,
        status: command.event === "submission_failed" ? "failed" : "abandoned",
        phase: null,
        failureCode: command.failureCode,
      };
      break;
    }
  }

  const nextDefect = mediaSubmissionInvariant(next);
  return nextDefect === null
    ? { ok: true, state: next }
    : rejected({ tag: "invalid_state", defect: nextDefect });
}

export const createMediaSubmissionState = (
  input: Extract<MediaSubmissionCommand, { readonly event: "submission_created" }>,
): MediaSubmissionState => {
  const result = transitionMediaSubmission(null, input);
  if (!result.ok) throw new Error(`media_submission_create:${result.rejection.tag}`);
  return result.state;
};

export const assertMediaSubmissionInvariant = (state: MediaSubmissionState): void => {
  const defect = mediaSubmissionInvariant(state);
  if (defect !== null) throw new Error(`media_submission_invariant:${defect}`);
};

export const mediaSubmissionMachine = {
  transition: transitionMediaSubmission,
  assertInvariants: assertMediaSubmissionInvariant,
  workflowInstanceId: deterministicMediaWorkflowInstanceId,
} as const;

export const transition = transitionMediaSubmission;
export const applyMediaSubmissionEvent = transitionMediaSubmission;

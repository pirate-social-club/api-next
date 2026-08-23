/**
 * Pure song creation machine (Spec 013).
 *
 * This module deliberately contains no provider, queue, workflow, clock, or
 * database authority. Adapters persist the returned state only after this
 * reducer accepts the typed event.
 */

export type SongType = "original" | "remix";
export type MediaSubmissionPhase =
  | "reserve"
  | "awaiting_upload"
  | "finalize"
  | "analysis"
  | "decision"
  | "publish"
  | null;
export type MediaSubmissionStatus =
  | "processing"
  | "action_required"
  | "manual_review"
  | "published"
  | "blocked"
  | "processing_failed"
  | "abandoned";

export type SongTerms = Readonly<{
  licensePreset: "non-commercial" | "commercial-use" | "commercial-remix";
  commercialRemixShareBps: number;
  royaltyAllocations: readonly Readonly<{ recipientId: string; shareBps: number }>[];
  accessMode: "public";
}>;

export type ImmutableAudio = Readonly<{
  audioRevision: number;
  immutableRef: string;
  canonicalSha256: string;
  contentType: string;
  sizeBytes: number;
}>;

export type BoundReference = Readonly<{
  assetId: string;
  evidenceAudioRevision: number;
  evidenceAnalysisRevision: number;
  evidenceAudioSha256: string;
  upstreamCommercialRevShareBps: number | null;
}>;

export type CoverAnalysis =
  | Readonly<{
      status: "ready";
      artifactRef: string;
      artifactSha256: string;
      mediaType: "image/jpeg" | "image/png" | "image/webp";
      width: number;
      height: number;
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
  version: "song-trusted-analysis-v1";
  operationId: string;
  analysisRevision: number;
  audioRevision: number;
  canonicalAudioSha256: string;
  finalizedAudioRef: string;
  probeEvidenceRef: string;
  embeddedMetadataEvidenceRef: string;
  embeddedTitle: string | null;
  embeddedTitleProvenance: "embedded" | "absent";
  cover: CoverAnalysis;
  speech: SpeechAnalysis;
  acrDecision: "allow" | "requires_reference" | "inconclusive" | "skipped";
  acrEvidenceRef: string;
  acrPolicyRevision: string;
  acrAdapterRevision: string;
  mediaSafety: "allow" | "draft" | "review_required" | "blocked";
  lyricsSafety: "skipped" | "allow" | "review_required" | "blocked";
  boundReference: BoundReference | null;
}>;

export type MediaOutboxPayload =
  | Readonly<{
      kind: "analysis_launch";
      submission_id: string;
      operation_id: string;
      audio_revision: number;
      analysis_revision: number;
      workflow_revision: number;
      workflow_instance_id: string;
    }>
  | Readonly<{
      kind: "publication";
      submission_id: string;
      operation_id: string;
      post_id: string;
      workflow_revision: number;
      workflow_instance_id: string;
    }>
  | Readonly<{
      kind: "alignment";
      submission_id: string;
      operation_id: string;
      post_id: string;
      workflow_revision: number;
      workflow_instance_id: string;
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

export type ProcessingFailureCode =
  | "invalid_media"
  | "unsupported_media"
  | "probe_failed"
  | "hash_failed"
  | "transform_failed"
  | "publication_failed"
  | "upload_seal_conflict";
export type ProcessingFailure = Readonly<{
  code: ProcessingFailureCode;
  retryable: boolean;
  retryCount: 0 | 1 | 2 | 3;
  lastSafePhase: Exclude<MediaSubmissionPhase, null>;
}>;

export type RequiredAction = Readonly<{
  kind: "reference_required";
  referenceRequestRef: string;
  expiresAt: string;
  heldRevision: number;
}>;
export type ReviewCase = Readonly<{
  reviewRef: string;
  heldRevision: number;
  reasonCode: "review_required" | "moderation_unavailable";
}>;
export type ModeratorApprovalEvidence = Readonly<{
  actionId: string;
  moderatorActorId: string;
  evidenceRef: string;
  reasonCode: "acr_inconclusive" | "acr_exhausted" | "acr_skipped";
  heldRevision: number;
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
  retryCount: number;
  status: MediaSubmissionStatus;
  phase: MediaSubmissionPhase;
  terms: SongTerms | null;
  audio: ImmutableAudio | null;
  analysis: TrustedSongAnalysis | null;
  boundReference: BoundReference | null;
  decision: PublicationDecision | null;
  action: RequiredAction | null;
  review: ReviewCase | null;
  moderatorApproval: ModeratorApprovalEvidence | null;
  failure: ProcessingFailure | null;
  postId: string | null;
}>;

type RevisionCommand = Readonly<{ actorId: string; expectedCreationRevision: number }>;
type AudioFence = Readonly<{
  actorId: string;
  expectedAudioRevision: number;
  expectedCanonicalAudioSha256: string;
}>;

export type MediaSubmissionCommand =
  | Readonly<{
      event: "submission_reserved" | "submission_created";
      actorId: string;
      expectedCreationRevision: 0;
      submissionId: string;
      operationId: string;
      communityId: string;
      title: string;
      songType: SongType;
      reservationId: string;
    }>
  | (RevisionCommand & Readonly<{ event: "terms_bound"; terms: SongTerms }>)
  | (RevisionCommand &
      Readonly<{
        event: "audio_finalized" | "upload_finalized";
        expectedAudioRevision: number;
        audio: ImmutableAudio;
      }>)
  | (AudioFence & Readonly<{ event: "analysis_accepted"; analysis: TrustedSongAnalysis }>)
  | (RevisionCommand &
      Readonly<{
        event: "decision_recorded";
        expectedAudioRevision: number;
        expectedAnalysisRevision: number;
        decision: PublicationDecision;
      }>)
  | (RevisionCommand &
      Readonly<{
        event: "reference_required";
        expectedAudioRevision: number;
        expectedAnalysisRevision: number;
        referenceRequestRef: string;
        actionExpiresAt: string;
      }>)
  | (RevisionCommand &
      Readonly<{ event: "reference_bound"; reference: BoundReference; nowEpochMs: number }>)
  | (RevisionCommand & Readonly<{ event: "review_required"; review: ReviewCase }>)
  | (RevisionCommand &
      Readonly<{
        event: "moderator_approved";
        communityActive: boolean;
        membershipActive: boolean;
        approval: ModeratorApprovalEvidence;
      }>)
  | (RevisionCommand &
      Readonly<{
        event: "moderator_blocked";
        communityActive: boolean;
        membershipActive: boolean;
        actionId: string;
        moderatorActorId: string;
        evidenceRef: string;
      }>)
  | (RevisionCommand &
      Readonly<{
        event: "publication_committed";
        expectedAudioRevision: number;
        expectedAnalysisRevision: number;
        expectedDecisionRevision: number;
        communityActive: boolean;
        membershipActive: boolean;
        postId: string;
      }>)
  | (RevisionCommand &
      Readonly<{ event: "technical_exhaustion_recorded"; failure: ProcessingFailure }>)
  | (RevisionCommand & Readonly<{ event: "retry_authorized" }>)
  | (RevisionCommand & Readonly<{ event: "action_deadline_elapsed"; nowEpochMs: number }>)
  | (RevisionCommand & Readonly<{ event: "author_cancelled" }>)
  | (RevisionCommand & Readonly<{ event: "reservation_expired" }>);

export type MediaSubmissionRejection =
  | Readonly<{ _tag: "action_expired"; submissionId: string }>
  | Readonly<{
      _tag: "actor_not_authorized";
      reasonCode:
        | "active_membership_required"
        | "moderator_role_required"
        | "submission_owner_required";
    }>
  | Readonly<{ _tag: "analysis_evidence_stale"; expectedRevision: number; actualRevision: number }>
  | Readonly<{ _tag: "audio_identity_mismatch" }>
  | Readonly<{ _tag: "decision_evidence_invalid"; reasonCode: string }>
  | Readonly<{
      _tag: "reference_binding_invalid";
      reasonCode:
        | "asset_not_found"
        | "asset_not_referenceable"
        | "content_hash_mismatch"
        | "evidence_revision_mismatch"
        | "reference_kind_mismatch";
    }>
  | Readonly<{
      _tag: "retry_not_allowed";
      reasonCode:
        | "failure_not_retryable"
        | "retry_limit_reached"
        | "revision_superseded"
        | "terminal_status";
    }>
  | Readonly<{ _tag: "stale_revision"; expected: number; actual: number }>
  | Readonly<{
      _tag: "transition_not_allowed";
      state: MediaSubmissionStatus | "none";
      event: MediaSubmissionCommand["event"];
    }>
  | Readonly<{ _tag: "invalid_state"; reasonCode: string }>;
export type MediaSubmissionResult =
  | Readonly<{ ok: true; state: MediaSubmissionState }>
  | Readonly<{ ok: false; rejection: MediaSubmissionRejection }>;

const idPattern = /^\S(?:.*\S)?$/u;
const hashPattern = /^[0-9a-f]{64}$/u;
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !value.includes("\u0000") &&
  idPattern.test(value);
const validRevision = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const validHash = (value: unknown): value is string =>
  typeof value === "string" && hashPattern.test(value);
const reject = (rejection: MediaSubmissionRejection): MediaSubmissionResult => ({
  ok: false,
  rejection,
});
const stale = (expected: number, actual: number): MediaSubmissionResult =>
  reject({ _tag: "stale_revision", expected, actual });

export const deterministicMediaWorkflowInstanceId = (
  operationId: string,
  workflowRevision: number,
): string => `media-${operationId}-r${workflowRevision}`;

function validTerms(terms: SongTerms): boolean {
  if (
    terms.accessMode !== "public" ||
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
}

function validReference(reference: BoundReference, state: MediaSubmissionState): boolean {
  return (
    validId(reference.assetId) &&
    validRevision(reference.evidenceAudioRevision, 1) &&
    validRevision(reference.evidenceAnalysisRevision, 1) &&
    validHash(reference.evidenceAudioSha256) &&
    (reference.upstreamCommercialRevShareBps === null ||
      (Number.isInteger(reference.upstreamCommercialRevShareBps) &&
        reference.upstreamCommercialRevShareBps >= 0 &&
        reference.upstreamCommercialRevShareBps <= 10_000)) &&
    state.audio !== null &&
    reference.evidenceAudioRevision === state.audio.audioRevision &&
    reference.evidenceAudioSha256 === state.audio.canonicalSha256
  );
}

export function mediaSubmissionInvariant(state: MediaSubmissionState): string | null {
  if (
    ![
      state.submissionId,
      state.operationId,
      state.communityId,
      state.actorId,
      state.title,
      state.reservationId,
    ].every(validId)
  )
    return "identity";
  if (
    ![
      state.creationRevision,
      state.audioRevision,
      state.analysisRevision,
      state.decisionRevision,
      state.workflowRevision,
      state.retryCount,
    ].every((revision) => validRevision(revision)) ||
    state.retryCount > 3
  )
    return "revision";
  if ((state.audioRevision === 0) !== (state.audio === null)) return "audio_presence";
  if (
    state.audio !== null &&
    (state.audio.audioRevision !== state.audioRevision ||
      !validId(state.audio.immutableRef) ||
      !validHash(state.audio.canonicalSha256) ||
      !validId(state.audio.contentType) ||
      !validRevision(state.audio.sizeBytes, 1))
  )
    return "audio_identity";
  if ((state.analysisRevision === 0) !== (state.analysis === null)) return "analysis_presence";
  if (state.analysis !== null) {
    if (
      state.analysis.version !== "song-trusted-analysis-v1" ||
      state.analysis.operationId !== state.operationId ||
      state.audio === null ||
      state.analysis.analysisRevision !== state.analysisRevision ||
      state.analysis.audioRevision !== state.audioRevision ||
      state.analysis.canonicalAudioSha256 !== state.audio.canonicalSha256 ||
      state.analysis.finalizedAudioRef !== state.audio.immutableRef
    )
      return "analysis_identity";
    if (
      (state.analysis.embeddedTitleProvenance === "embedded") !==
      (state.analysis.embeddedTitle !== null)
    )
      return "title_provenance";
    if (
      state.analysis.cover.status === "ready" &&
      (!validRevision(state.analysis.cover.width, 1) ||
        !validRevision(state.analysis.cover.height, 1))
    )
      return "cover_dimensions";
    if (
      state.analysis.speech.status === "ready" &&
      state.analysis.speech.secondaryLanguageBcp47 === state.analysis.speech.primaryLanguageBcp47
    )
      return "language_identity";
    if (
      state.analysis.boundReference !== null &&
      !validReference(state.analysis.boundReference, state)
    )
      return "reference_identity";
  }
  if (state.boundReference !== null && !validReference(state.boundReference, state))
    return "reference_identity";
  if ((state.decisionRevision === 0) !== (state.decision === null)) return "decision_presence";
  if (
    state.decision !== null &&
    (state.analysis === null ||
      state.audio === null ||
      state.decision.decisionRevision !== state.decisionRevision ||
      state.decision.creationRevision !== state.creationRevision ||
      state.decision.audioRevision !== state.audioRevision ||
      state.decision.analysisRevision !== state.analysisRevision ||
      state.decision.canonicalAudioSha256 !== state.audio.canonicalSha256)
  )
    return "decision_identity";
  if (state.status === "processing" && !state.phase) return "processing_phase";
  if (
    state.status === "action_required" &&
    (state.phase !== null ||
      state.action === null ||
      state.action.heldRevision !== state.creationRevision)
  )
    return "action_shape";
  if (
    state.status === "manual_review" &&
    (state.phase !== null ||
      state.review === null ||
      state.review.heldRevision !== state.creationRevision)
  )
    return "review_shape";
  if (
    state.status === "published" &&
    (!validId(state.postId ?? "") || state.phase !== null || state.decision?.outcome !== "allow")
  )
    return "published_shape";
  if (state.status === "blocked" && (state.phase !== null || state.postId !== null))
    return "blocked_shape";
  if (
    state.status === "processing_failed" &&
    (state.phase !== null || state.failure === null || state.failure.retryCount > 3)
  )
    return "failure_shape";
  if (state.status === "abandoned" && state.phase !== null) return "abandoned_shape";
  if (state.songType === "remix" && state.status === "published" && state.boundReference === null)
    return "remix_reference";
  return null;
}

function decisionStatus(
  decision: PublicationDecision,
): Pick<MediaSubmissionState, "status" | "phase"> {
  if (decision.outcome === "allow") return { status: "processing", phase: "publish" };
  if (decision.outcome === "manual_review") return { status: "manual_review", phase: null };
  return { status: "blocked", phase: null };
}

export function transitionMediaSubmission(
  current: MediaSubmissionState | null,
  command: MediaSubmissionCommand,
): MediaSubmissionResult {
  if (!validId(command.actorId))
    return reject({ _tag: "actor_not_authorized", reasonCode: "submission_owner_required" });
  if (current === null) {
    if (command.event !== "submission_reserved" && command.event !== "submission_created")
      return reject({ _tag: "transition_not_allowed", state: "none", event: command.event });
    const state: MediaSubmissionState = {
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
      retryCount: 0,
      status: "processing",
      phase: "awaiting_upload",
      terms: null,
      audio: null,
      analysis: null,
      boundReference: null,
      decision: null,
      action: null,
      review: null,
      moderatorApproval: null,
      failure: null,
      postId: null,
    };
    const defect = mediaSubmissionInvariant(state);
    return defect === null
      ? { ok: true, state }
      : reject({ _tag: "invalid_state", reasonCode: defect });
  }
  const defect = mediaSubmissionInvariant(current);
  if (defect !== null) return reject({ _tag: "invalid_state", reasonCode: defect });
  if (current.actorId !== command.actorId)
    return reject({ _tag: "actor_not_authorized", reasonCode: "submission_owner_required" });
  if (
    ["published", "blocked", "abandoned"].includes(current.status) &&
    command.event !== "moderator_blocked"
  )
    return reject({ _tag: "transition_not_allowed", state: current.status, event: command.event });
  let next: MediaSubmissionState;
  switch (command.event) {
    case "submission_created":
    case "submission_reserved":
      return reject({
        _tag: "transition_not_allowed",
        state: current.status,
        event: command.event,
      });
    case "terms_bound": {
      if (command.expectedCreationRevision !== current.creationRevision)
        return stale(command.expectedCreationRevision, current.creationRevision);
      if (
        !validTerms(command.terms) ||
        current.status === "action_required" ||
        current.status === "manual_review"
      )
        return reject({
          _tag: "transition_not_allowed",
          state: current.status,
          event: command.event,
        });
      next = {
        ...current,
        creationRevision: current.creationRevision + 1,
        terms: command.terms,
        decision: null,
        decisionRevision: 0,
        status: current.analysis === null ? current.status : "processing",
        phase: current.analysis === null ? current.phase : "decision",
        action: null,
        review: null,
        moderatorApproval: null,
      };
      break;
    }
    case "audio_finalized":
    case "upload_finalized": {
      if (command.expectedCreationRevision !== current.creationRevision)
        return stale(command.expectedCreationRevision, current.creationRevision);
      if (
        command.expectedAudioRevision !== current.audioRevision ||
        current.audio !== null ||
        command.audio.audioRevision !== 1 ||
        current.phase !== "awaiting_upload"
      )
        return reject({
          _tag: "transition_not_allowed",
          state: current.status,
          event: command.event,
        });
      next = {
        ...current,
        audioRevision: 1,
        audio: command.audio,
        workflowRevision: current.workflowRevision + 1,
        status: "processing",
        phase: "analysis",
      };
      break;
    }
    case "analysis_accepted": {
      if (command.expectedAudioRevision !== current.audioRevision)
        return stale(command.expectedAudioRevision, current.audioRevision);
      if (
        current.audio === null ||
        command.expectedCanonicalAudioSha256 !== current.audio.canonicalSha256 ||
        command.analysis.version !== "song-trusted-analysis-v1" ||
        command.analysis.operationId !== current.operationId ||
        command.analysis.audioRevision !== current.audioRevision ||
        command.analysis.canonicalAudioSha256 !== current.audio.canonicalSha256 ||
        command.analysis.finalizedAudioRef !== current.audio.immutableRef
      )
        return reject({ _tag: "audio_identity_mismatch" });
      if (command.analysis.analysisRevision !== current.analysisRevision + 1)
        return reject({
          _tag: "analysis_evidence_stale",
          expectedRevision: current.analysisRevision + 1,
          actualRevision: command.analysis.analysisRevision,
        });
      next = {
        ...current,
        analysisRevision: command.analysis.analysisRevision,
        analysis: command.analysis,
        decision: null,
        decisionRevision: 0,
        status: "processing",
        phase: current.terms === null ? "analysis" : "decision",
      };
      break;
    }
    case "decision_recorded": {
      if (
        command.expectedCreationRevision !== current.creationRevision ||
        command.expectedAudioRevision !== current.audioRevision ||
        command.expectedAnalysisRevision !== current.analysisRevision
      )
        return reject({ _tag: "decision_evidence_invalid", reasonCode: "revision_mismatch" });
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
        return reject({ _tag: "decision_evidence_invalid", reasonCode: "required_stage_missing" });
      if (
        command.decision.outcome === "allow" &&
        (current.analysis.acrDecision === "inconclusive" ||
          current.analysis.acrDecision === "skipped" ||
          (current.analysis.acrDecision === "requires_reference" &&
            current.boundReference === null) ||
          current.analysis.mediaSafety !== "allow" ||
          current.analysis.lyricsSafety === "review_required" ||
          current.analysis.lyricsSafety === "blocked" ||
          current.analysis.speech.status === "unavailable")
      )
        return reject({ _tag: "decision_evidence_invalid", reasonCode: "required_stage_missing" });
      const projected = decisionStatus(command.decision);
      next = {
        ...current,
        decisionRevision: command.decision.decisionRevision,
        decision: command.decision,
        ...projected,
        action: null,
        review:
          command.decision.outcome === "manual_review"
            ? {
                reviewRef: `review-${command.decision.evidenceRef}`,
                heldRevision: current.creationRevision,
                reasonCode: "review_required",
              }
            : null,
      };
      break;
    }
    case "reference_required": {
      if (
        command.expectedCreationRevision !== current.creationRevision ||
        command.expectedAudioRevision !== current.audioRevision ||
        command.expectedAnalysisRevision !== current.analysisRevision ||
        current.analysis?.acrDecision !== "requires_reference" ||
        !validId(command.referenceRequestRef) ||
        !Number.isFinite(Date.parse(command.actionExpiresAt))
      )
        return reject({ _tag: "decision_evidence_invalid", reasonCode: "required_stage_missing" });
      next = {
        ...current,
        status: "action_required",
        phase: null,
        action: {
          kind: "reference_required",
          referenceRequestRef: command.referenceRequestRef,
          expiresAt: command.actionExpiresAt,
          heldRevision: current.creationRevision,
        },
        review: null,
        decision: null,
        decisionRevision: 0,
      };
      break;
    }
    case "reference_bound": {
      if (command.expectedCreationRevision !== current.creationRevision)
        return stale(command.expectedCreationRevision, current.creationRevision);
      if (
        current.status !== "action_required" ||
        current.action === null ||
        Date.parse(current.action.expiresAt) <= command.nowEpochMs
      )
        return reject({ _tag: "action_expired", submissionId: current.submissionId });
      if (!validReference(command.reference, current))
        return reject({ _tag: "reference_binding_invalid", reasonCode: "content_hash_mismatch" });
      next = {
        ...current,
        creationRevision: current.creationRevision + 1,
        boundReference: command.reference,
        status: "processing",
        phase: "analysis",
        action: null,
        decision: null,
        decisionRevision: 0,
      };
      break;
    }
    case "review_required": {
      if (
        command.expectedCreationRevision !== current.creationRevision ||
        !validId(command.review.reviewRef) ||
        command.review.heldRevision !== current.creationRevision
      )
        return reject({ _tag: "decision_evidence_invalid", reasonCode: "required_stage_missing" });
      next = {
        ...current,
        status: "manual_review",
        phase: null,
        review: command.review,
        action: null,
        decision: null,
        decisionRevision: 0,
      };
      break;
    }
    case "moderator_approved": {
      if (
        command.expectedCreationRevision !== current.creationRevision ||
        !command.communityActive ||
        !command.membershipActive
      )
        return reject({ _tag: "actor_not_authorized", reasonCode: "active_membership_required" });
      if (
        current.status !== "manual_review" ||
        current.review === null ||
        command.approval.heldRevision !== current.creationRevision ||
        !validId(command.approval.actionId) ||
        !validId(command.approval.moderatorActorId)
      )
        return reject({
          _tag: "transition_not_allowed",
          state: current.status,
          event: command.event,
        });
      if (
        (current.analysis?.acrDecision === "inconclusive" ||
          current.analysis?.acrDecision === "skipped") &&
        !["acr_inconclusive", "acr_skipped", "acr_exhausted"].includes(command.approval.reasonCode)
      )
        return reject({ _tag: "decision_evidence_invalid", reasonCode: "acr_override_required" });
      next = {
        ...current,
        status: "processing",
        phase: "publish",
        review: null,
        moderatorApproval: command.approval,
      };
      break;
    }
    case "moderator_blocked": {
      if (
        command.expectedCreationRevision !== current.creationRevision ||
        !command.communityActive ||
        !command.membershipActive ||
        current.status !== "manual_review" ||
        !validId(command.actionId) ||
        !validId(command.moderatorActorId) ||
        !validId(command.evidenceRef)
      )
        return reject({ _tag: "actor_not_authorized", reasonCode: "moderator_role_required" });
      next = { ...current, status: "blocked", phase: null, review: null, moderatorApproval: null };
      break;
    }
    case "publication_committed": {
      if (command.expectedCreationRevision !== current.creationRevision)
        return stale(command.expectedCreationRevision, current.creationRevision);
      if (
        command.expectedAudioRevision !== current.audioRevision ||
        command.expectedAnalysisRevision !== current.analysisRevision ||
        command.expectedDecisionRevision !== current.decisionRevision
      )
        return reject({ _tag: "decision_evidence_invalid", reasonCode: "revision_mismatch" });
      if (!command.communityActive || !command.membershipActive)
        return reject({ _tag: "actor_not_authorized", reasonCode: "active_membership_required" });
      if (
        current.status !== "processing" ||
        current.phase !== "publish" ||
        (current.decision?.outcome !== "allow" && current.moderatorApproval === null) ||
        !validId(command.postId)
      )
        return reject({
          _tag: "transition_not_allowed",
          state: current.status,
          event: command.event,
        });
      next = {
        ...current,
        workflowRevision: current.workflowRevision + 1,
        status: "published",
        phase: null,
        postId: command.postId,
        failure: null,
      };
      break;
    }
    case "technical_exhaustion_recorded": {
      if (
        command.expectedCreationRevision !== current.creationRevision ||
        current.status !== "processing" ||
        command.failure.retryCount > 3
      )
        return reject({
          _tag: "transition_not_allowed",
          state: current.status,
          event: command.event,
        });
      next = {
        ...current,
        status: "processing_failed",
        phase: null,
        failure: command.failure,
        decision: null,
        decisionRevision: 0,
      };
      break;
    }
    case "retry_authorized": {
      if (
        command.expectedCreationRevision !== current.creationRevision ||
        current.status !== "processing_failed" ||
        current.failure === null
      )
        return reject({ _tag: "retry_not_allowed", reasonCode: "failure_not_retryable" });
      if (!current.failure.retryable)
        return reject({ _tag: "retry_not_allowed", reasonCode: "failure_not_retryable" });
      if (current.failure.retryCount >= 3)
        return reject({ _tag: "retry_not_allowed", reasonCode: "retry_limit_reached" });
      next = {
        ...current,
        creationRevision: current.creationRevision + 1,
        retryCount: current.retryCount + 1,
        status: "processing",
        phase: current.failure.lastSafePhase,
        failure: null,
        decision: null,
        decisionRevision: 0,
        action: null,
        review: null,
      };
      break;
    }
    case "action_deadline_elapsed": {
      if (
        current.status !== "action_required" ||
        current.action === null ||
        Date.parse(current.action.expiresAt) > command.nowEpochMs
      )
        return reject({ _tag: "action_expired", submissionId: current.submissionId });
      next = { ...current, status: "abandoned", phase: null, action: null };
      break;
    }
    case "author_cancelled":
    case "reservation_expired": {
      if (
        current.audioRevision > 0 ||
        current.status !== "processing" ||
        !["awaiting_upload", "reserve", "finalize"].includes(current.phase ?? "")
      )
        return reject({
          _tag: "transition_not_allowed",
          state: current.status,
          event: command.event,
        });
      next = { ...current, status: "abandoned", phase: null };
      break;
    }
  }
  const nextDefect = mediaSubmissionInvariant(next);
  return nextDefect === null
    ? { ok: true, state: next }
    : reject({ _tag: "invalid_state", reasonCode: nextDefect });
}

export const createMediaSubmissionState = (
  input: Extract<MediaSubmissionCommand, { event: "submission_created" | "submission_reserved" }>,
): MediaSubmissionState => {
  const result = transitionMediaSubmission(null, input);
  if (!result.ok) throw new Error(`media_submission_create:${result.rejection._tag}`);
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

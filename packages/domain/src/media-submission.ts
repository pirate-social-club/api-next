/** Pure Spec 013 song creation state machine. */

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
  evidenceRef: string;
  inheritedLicensePreset?: "non-commercial" | "commercial-use" | "commercial-remix";
  inheritedCommercialRevShareBps?: number | null;
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
  | Readonly<{ status: "absent"; artifactRef?: null; reasonCode: "not_embedded" }>
  | Readonly<{
      status: "rejected";
      artifactRef?: null;
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
      transcriptArtifactRef?: null;
      transcriptSha256?: null;
      explicitness: "no_lyrics";
      primaryLanguageBcp47?: null;
      secondaryLanguageBcp47?: null;
      evidenceRef: string;
      policyRevision: string;
      adapterRevision: string;
    }>
  | Readonly<{
      status: "unavailable";
      transcriptArtifactRef?: null;
      transcriptSha256?: null;
      explicitness: "uncertain";
      primaryLanguageBcp47?: null;
      secondaryLanguageBcp47?: null;
      evidenceRef: string;
      policyRevision: string;
      adapterRevision: string;
    }>;
export type EmbeddedMetadataAnalysis = Readonly<{
  evidenceRef: string;
  adapterRevision: string;
  trackTitle: string | null;
  cover: CoverAnalysis;
}>;
export type TrustedSongAnalysis = Readonly<{
  version: "song-trusted-analysis-v1";
  operationId: string;
  analysisRevision: number;
  audioRevision: number;
  canonicalAudioSha256: string;
  finalizedAudioRef: string;
  probeEvidenceRef: string;
  embeddedMetadata: EmbeddedMetadataAnalysis;
  speechLyrics: SpeechAnalysis;
  acr: Readonly<{
    decision: "allow" | "requires_reference" | "inconclusive" | "skipped";
    evidenceRef: string;
    policyRevision: string;
    adapterRevision: string;
  }>;
  lyricsSafety: "skipped" | "allow" | "review_required" | "blocked";
  mediaSafety: "allow" | "draft" | "review_required" | "blocked";
  boundReference: BoundReference | null;
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
  evidenceRef?: string;
}>;
export type Abandonment = Readonly<{
  reason:
    | "author_cancelled"
    | "reservation_expired"
    | "action_deadline_elapsed"
    | "upload_expectation_mismatch"
    | "upload_source_changed_before_finalize";
  retentionDisposition: "no_object" | "retain_for_reconciliation" | "retain_until_expiry";
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
  exhaustionCode?: "acr_exhausted";
  exhaustionAttemptId?: string;
}>;
export type ModeratorApprovalEvidence = Readonly<{
  actionId: string;
  moderatorActorId: string;
  evidenceRef: string;
  approvalKind: "standard" | "acr_override";
  reasonCode: "acr_inconclusive" | "acr_exhausted" | "acr_skipped" | null;
  heldRevision: number;
}>;
export type ModeratorBlockEvidence = Readonly<{
  actionId: string;
  moderatorActorId: string;
  evidenceRef: string;
  reasonCode: "policy_violation";
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
  moderatorApproval: ModeratorApprovalEvidence | ModeratorBlockEvidence | null;
  failure: ProcessingFailure | null;
  abandonment: Abandonment | null;
  postId: string | null;
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

export type MediaSubmissionEvent =
  | "submission_reserved"
  | "text_input_bound"
  | "media_reservation_issued"
  | "finalize_requested"
  | "author_cancelled"
  | "reservation_expired"
  | "upload_finalized"
  | "upload_expectation_mismatch_recorded"
  | "upload_source_precondition_failed"
  | "seal_conflict_recorded"
  | "song_terms_bound"
  | "blocking_analysis_completed"
  | "review_exhaustion_recorded"
  | "media_failure_recorded"
  | "publication_allowed"
  | "reference_required"
  | "review_required"
  | "policy_blocked"
  | "reference_bound"
  | "action_deadline_elapsed"
  | "moderator_approved"
  | "moderator_blocked"
  | "publication_committed"
  | "technical_exhaustion_recorded"
  | "retry_authorized";
type RevisionCommand = Readonly<{ actorId: string; expectedCreationRevision: number }>;
type AudioFence = Readonly<{
  actorId: string;
  expectedAudioRevision: number;
  expectedCanonicalAudioSha256: string;
}>;
export type MediaSubmissionCommand =
  | Readonly<{
      event: "submission_reserved";
      actorId: string;
      expectedCreationRevision: 0;
      submissionId: string;
      operationId: string;
      communityId: string;
      title: string;
      songType: SongType;
      reservationId: string;
    }>
  | (RevisionCommand & Readonly<{ event: "song_terms_bound"; terms: SongTerms }>)
  | (RevisionCommand &
      Readonly<{ event: "upload_finalized"; expectedAudioRevision: number; audio: ImmutableAudio }>)
  | (AudioFence & Readonly<{ event: "blocking_analysis_completed"; analysis: TrustedSongAnalysis }>)
  | (RevisionCommand & Readonly<{ event: "review_exhaustion_recorded"; review: ReviewCase }>)
  | (RevisionCommand & Readonly<{ event: "media_failure_recorded"; failure: ProcessingFailure }>)
  | (RevisionCommand &
      Readonly<{
        event: "publication_allowed";
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
      Readonly<{
        event: "review_required";
        expectedAudioRevision: number;
        expectedAnalysisRevision: number;
        review: ReviewCase;
        decision: PublicationDecision;
      }>)
  | (RevisionCommand & Readonly<{ event: "policy_blocked"; evidenceRef: string }>)
  | (RevisionCommand &
      Readonly<{ event: "reference_bound"; reference: BoundReference; nowEpochMs: number }>)
  | (RevisionCommand & Readonly<{ event: "action_deadline_elapsed"; nowEpochMs: number }>)
  | (RevisionCommand &
      Readonly<{
        event: "moderator_approved";
        communityActive: boolean;
        membershipActive: boolean;
        approval: ModeratorApprovalEvidence;
        decision: PublicationDecision;
      }>)
  | (RevisionCommand &
      Readonly<{
        event: "moderator_blocked";
        communityActive: boolean;
        membershipActive: boolean;
        actionId: string;
        moderatorActorId: string;
        evidenceRef: string;
        reasonCode: "policy_violation";
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
  | (RevisionCommand & Readonly<{ event: "author_cancelled" }>)
  | (RevisionCommand & Readonly<{ event: "reservation_expired" }>)
  | (RevisionCommand &
      Readonly<{
        event: "upload_expectation_mismatch_recorded";
        abandonment: Abandonment;
        evidenceRef: string;
      }>)
  | (RevisionCommand &
      Readonly<{
        event: "upload_source_precondition_failed";
        abandonment: Abandonment;
        evidenceRef: string;
      }>)
  | (RevisionCommand & Readonly<{ event: "seal_conflict_recorded"; failure: ProcessingFailure }>);

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
  | Readonly<{
      _tag: "capability_unavailable";
      capability: "track" | "locked_delivery";
      track: "song";
    }>
  | Readonly<{ _tag: "idempotency_conflict"; submissionId: string }>
  | Readonly<{
      _tag: "decision_evidence_invalid";
      reasonCode:
        | "required_stage_missing"
        | "input_hash_mismatch"
        | "policy_revision_mismatch"
        | "adapter_revision_mismatch";
    }>
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
      event: MediaSubmissionEvent;
    }>
  | Readonly<{
      _tag: "upload_not_finalized";
      reservationId: string;
      reasonCode: "object_missing" | "ownership_mismatch";
    }>;
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
const bcp47Pattern =
  /^(?:[a-z]{2,3})(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-[a-z0-9]{5,8}|-[0-9][a-z0-9]{3})*$/u;
const validLanguage = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 35 && bcp47Pattern.test(value);
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
  return terms.royaltyAllocations.length > 0 && total === 10_000;
}
function validReference(reference: BoundReference, state: MediaSubmissionState): boolean {
  return (
    validId(reference.assetId) &&
    validId(reference.evidenceRef) &&
    validRevision(reference.evidenceAudioRevision, 1) &&
    validRevision(reference.evidenceAnalysisRevision, 1) &&
    validHash(reference.evidenceAudioSha256) &&
    (reference.upstreamCommercialRevShareBps === null ||
      (Number.isInteger(reference.upstreamCommercialRevShareBps) &&
        reference.upstreamCommercialRevShareBps >= 0 &&
        reference.upstreamCommercialRevShareBps <= 10_000)) &&
    state.audio !== null &&
    reference.evidenceAudioRevision === state.audio.audioRevision &&
    reference.evidenceAudioSha256 === state.audio.canonicalSha256 &&
    (state.analysis === null ||
      reference.evidenceAnalysisRevision <= state.analysis.analysisRevision)
  );
}
function validAnalysis(analysis: TrustedSongAnalysis, state: MediaSubmissionState): boolean {
  const speech = analysis.speechLyrics;
  const cover = analysis.embeddedMetadata.cover;
  if (
    analysis.version !== "song-trusted-analysis-v1" ||
    analysis.operationId !== state.operationId ||
    state.audio === null ||
    analysis.audioRevision !== state.audioRevision ||
    analysis.canonicalAudioSha256 !== state.audio.canonicalSha256 ||
    analysis.finalizedAudioRef !== state.audio.immutableRef ||
    !validId(analysis.probeEvidenceRef) ||
    !validId(analysis.embeddedMetadata.evidenceRef) ||
    !validId(analysis.embeddedMetadata.adapterRevision) ||
    (analysis.embeddedMetadata.trackTitle !== null &&
      (!validId(analysis.embeddedMetadata.trackTitle) ||
        analysis.embeddedMetadata.trackTitle.length > 200))
  )
    return false;
  if (
    cover.status === "ready" &&
    (!validId(cover.artifactRef) ||
      !validHash(cover.artifactSha256) ||
      !validRevision(cover.width, 1) ||
      !validRevision(cover.height, 1) ||
      !validId(cover.normalizationRevision) ||
      !validId(cover.safetyPolicyRevision))
  )
    return false;
  if (
    cover.status === "absent" &&
    (cover.reasonCode !== "not_embedded" ||
      (cover.artifactRef !== undefined && cover.artifactRef !== null))
  )
    return false;
  if (
    cover.status === "rejected" &&
    (!["invalid", "unsafe", "limits_exceeded"].includes(cover.reasonCode) ||
      (cover.artifactRef !== undefined && cover.artifactRef !== null))
  )
    return false;
  if (speech.status === "ready") {
    if (
      !validId(speech.transcriptArtifactRef) ||
      !validHash(speech.transcriptSha256) ||
      !validLanguage(speech.primaryLanguageBcp47) ||
      (speech.secondaryLanguageBcp47 !== null &&
        (!validLanguage(speech.secondaryLanguageBcp47) ||
          speech.secondaryLanguageBcp47 === speech.primaryLanguageBcp47))
    )
      return false;
  } else if (
    speech.status === "no_speech" &&
    (analysis.lyricsSafety !== "skipped" ||
      (speech.transcriptArtifactRef !== undefined && speech.transcriptArtifactRef !== null) ||
      (speech.transcriptSha256 !== undefined && speech.transcriptSha256 !== null) ||
      (speech.primaryLanguageBcp47 !== undefined && speech.primaryLanguageBcp47 !== null) ||
      (speech.secondaryLanguageBcp47 !== undefined && speech.secondaryLanguageBcp47 !== null) ||
      speech.explicitness !== "no_lyrics")
  )
    return false;
  else if (
    speech.status === "unavailable" &&
    (analysis.lyricsSafety !== "review_required" ||
      (speech.transcriptArtifactRef !== undefined && speech.transcriptArtifactRef !== null) ||
      (speech.transcriptSha256 !== undefined && speech.transcriptSha256 !== null) ||
      (speech.primaryLanguageBcp47 !== undefined && speech.primaryLanguageBcp47 !== null) ||
      (speech.secondaryLanguageBcp47 !== undefined && speech.secondaryLanguageBcp47 !== null) ||
      speech.explicitness !== "uncertain")
  )
    return false;
  if (
    !validId(speech.evidenceRef) ||
    !validId(speech.policyRevision) ||
    !validId(speech.adapterRevision) ||
    !validId(analysis.acr.evidenceRef) ||
    !validId(analysis.acr.policyRevision) ||
    !validId(analysis.acr.adapterRevision)
  )
    return false;
  return (
    sameReference(analysis.boundReference, state.boundReference) &&
    (analysis.boundReference === null || validReference(analysis.boundReference, state))
  );
}
function sameReference(left: BoundReference | null, right: BoundReference | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
    ].every(validId) ||
    state.title.length > 200
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
  if (state.analysis !== null && !validAnalysis(state.analysis, state)) return "analysis_identity";
  if (state.boundReference !== null && !validReference(state.boundReference, state))
    return "reference_identity";
  if (
    state.analysis !== null &&
    state.analysis.boundReference !== null &&
    !sameReference(state.analysis.boundReference, state.boundReference)
  )
    return "reference_projection";
  if ((state.decisionRevision === 0) !== (state.decision === null)) return "decision_presence";
  if (
    state.decision !== null &&
    (state.decision.decisionRevision !== state.decisionRevision ||
      state.decision.creationRevision !== state.creationRevision ||
      state.decision.audioRevision !== state.audioRevision ||
      state.decision.analysisRevision !== state.analysisRevision ||
      state.audio === null ||
      state.decision.canonicalAudioSha256 !== state.audio.canonicalSha256)
  )
    return "decision_identity";
  if (state.status === "processing" && state.phase === null) return "processing_phase";
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
      state.review.heldRevision !== state.creationRevision ||
      (state.review.exhaustionCode === "acr_exhausted" &&
        !validId(state.review.exhaustionAttemptId)) ||
      (state.review.exhaustionCode === undefined && state.review.exhaustionAttemptId !== undefined))
  )
    return "review_shape";
  if (
    state.status === "published" &&
    (!validId(state.postId ?? "") || state.phase !== null || state.decision?.outcome !== "allow")
  )
    return "published_shape";
  if (
    state.status === "blocked" &&
    (state.phase !== null || state.postId !== null || state.review !== null)
  )
    return "blocked_shape";
  if (
    state.status === "processing_failed" &&
    (state.phase !== null || state.failure === null || state.failure.retryCount > 3)
  )
    return "failure_shape";
  if (
    state.status === "abandoned" &&
    (state.phase !== null || state.abandonment === null || state.postId !== null)
  )
    return "abandoned_shape";
  if (state.songType === "remix" && state.status === "published" && state.boundReference === null)
    return "remix_reference";
  return null;
}
function done(current: MediaSubmissionState, next: MediaSubmissionState): MediaSubmissionResult {
  const defect = mediaSubmissionInvariant(next);
  return defect === null
    ? { ok: true, state: next }
    : reject({
        _tag: "transition_not_allowed",
        state: current.status,
        event: "publication_committed",
      });
}
export function transitionMediaSubmission(
  current: MediaSubmissionState | null,
  command: MediaSubmissionCommand,
): MediaSubmissionResult {
  if (!validId(command.actorId))
    return reject({ _tag: "actor_not_authorized", reasonCode: "submission_owner_required" });
  if (current === null) {
    if (command.event !== "submission_reserved")
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
      abandonment: null,
      postId: null,
    };
    return mediaSubmissionInvariant(state) === null
      ? { ok: true, state }
      : reject({ _tag: "transition_not_allowed", state: "none", event: command.event });
  }
  if (mediaSubmissionInvariant(current) !== null)
    return reject({ _tag: "transition_not_allowed", state: current.status, event: command.event });
  if (current.actorId !== command.actorId)
    return reject({ _tag: "actor_not_authorized", reasonCode: "submission_owner_required" });
  if (["published", "blocked", "abandoned"].includes(current.status))
    return reject({ _tag: "transition_not_allowed", state: current.status, event: command.event });
  let next: MediaSubmissionState = current;
  switch (command.event) {
    case "song_terms_bound": {
      if (command.expectedCreationRevision !== current.creationRevision)
        return stale(command.expectedCreationRevision, current.creationRevision);
      if (
        !validTerms(command.terms) ||
        (!["awaiting_upload", "finalize", "analysis", "decision"].includes(current.phase ?? "") &&
          !["action_required", "manual_review"].includes(current.status))
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
        status: "processing",
        phase: current.audio === null ? "awaiting_upload" : "analysis",
        action: null,
        review: null,
        moderatorApproval: null,
        failure: null,
        abandonment: null,
      };
      break;
    }
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
        abandonment: null,
      };
      break;
    }
    case "blocking_analysis_completed": {
      if (command.expectedAudioRevision !== current.audioRevision)
        return stale(command.expectedAudioRevision, current.audioRevision);
      if (command.analysis.analysisRevision !== current.analysisRevision + 1)
        return reject({
          _tag: "analysis_evidence_stale",
          expectedRevision: current.analysisRevision + 1,
          actualRevision: command.analysis.analysisRevision,
        });
      if (
        current.audio === null ||
        command.expectedCanonicalAudioSha256 !== current.audio.canonicalSha256 ||
        command.analysis.analysisRevision !== current.analysisRevision + 1 ||
        !validAnalysis(command.analysis, current)
      )
        return reject({ _tag: "decision_evidence_invalid", reasonCode: "input_hash_mismatch" });
      next = {
        ...current,
        analysisRevision: command.analysis.analysisRevision,
        analysis: command.analysis,
        boundReference: command.analysis.boundReference ?? current.boundReference,
        decision: null,
        decisionRevision: 0,
        status: "processing",
        phase:
          command.analysis.acr.decision === "inconclusive"
            ? "analysis"
            : current.terms === null
              ? "analysis"
              : "decision",
        failure: null,
      };
      break;
    }
    case "review_exhaustion_recorded": {
      if (
        command.expectedCreationRevision !== current.creationRevision ||
        current.status !== "processing" ||
        current.phase !== "analysis" ||
        current.terms === null ||
        current.analysis === null ||
        current.analysis.acr.decision !== "inconclusive" ||
        !validId(command.review.reviewRef) ||
        command.review.heldRevision !== current.creationRevision ||
        command.review.exhaustionCode !== "acr_exhausted" ||
        !validId(command.review.exhaustionAttemptId)
      )
        return reject({
          _tag: "transition_not_allowed",
          state: current.status,
          event: command.event,
        });
      next = {
        ...current,
        status: "manual_review",
        phase: null,
        review: command.review,
        action: null,
        moderatorApproval: null,
      };
      break;
    }
    case "review_required": {
      if (
        command.expectedCreationRevision !== current.creationRevision ||
        command.expectedAudioRevision !== current.audioRevision ||
        command.expectedAnalysisRevision !== current.analysisRevision ||
        current.status !== "processing" ||
        !["analysis", "decision"].includes(current.phase ?? "") ||
        !validId(command.review.reviewRef) ||
        command.review.heldRevision !== current.creationRevision ||
        command.review.exhaustionCode !== undefined ||
        command.review.exhaustionAttemptId !== undefined ||
        command.decision.outcome !== "manual_review" ||
        command.decision.decisionRevision !== current.decisionRevision + 1 ||
        command.decision.creationRevision !== current.creationRevision ||
        command.decision.audioRevision !== current.audioRevision ||
        command.decision.analysisRevision !== current.analysisRevision ||
        current.audio === null ||
        command.decision.canonicalAudioSha256 !== current.audio.canonicalSha256
      )
        return reject({ _tag: "decision_evidence_invalid", reasonCode: "required_stage_missing" });
      next = {
        ...current,
        decisionRevision: command.decision.decisionRevision,
        decision: command.decision,
        status: "manual_review",
        phase: null,
        review: command.review,
        action: null,
        moderatorApproval: null,
      };
      break;
    }
    case "media_failure_recorded":
    case "technical_exhaustion_recorded":
    case "seal_conflict_recorded": {
      if (
        command.expectedCreationRevision !== current.creationRevision ||
        current.status !== "processing" ||
        command.failure.retryCount > 3 ||
        (command.event === "seal_conflict_recorded" &&
          (current.phase !== "finalize" ||
            command.failure.code !== "upload_seal_conflict" ||
            command.failure.retryable ||
            !validId(command.failure.evidenceRef)))
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
        review: null,
        action: null,
        abandonment: null,
      };
      break;
    }
    case "publication_allowed": {
      if (
        command.expectedCreationRevision !== current.creationRevision ||
        command.expectedAudioRevision !== current.audioRevision ||
        command.expectedAnalysisRevision !== current.analysisRevision ||
        current.status !== "processing" ||
        current.phase !== "decision" ||
        current.terms === null ||
        current.analysis === null ||
        current.audio === null ||
        command.decision.outcome !== "allow" ||
        command.decision.decisionRevision !== current.decisionRevision + 1 ||
        command.decision.creationRevision !== current.creationRevision ||
        command.decision.audioRevision !== current.audioRevision ||
        command.decision.analysisRevision !== current.analysisRevision ||
        command.decision.canonicalAudioSha256 !== current.audio.canonicalSha256 ||
        current.analysis.acr.decision === "inconclusive" ||
        current.analysis.acr.decision === "skipped" ||
        (current.analysis.acr.decision === "requires_reference" &&
          current.boundReference === null) ||
        current.analysis.mediaSafety !== "allow" ||
        !["skipped", "allow"].includes(current.analysis.lyricsSafety) ||
        current.analysis.speechLyrics.status === "unavailable" ||
        !["not_explicit", "no_lyrics"].includes(current.analysis.speechLyrics.explicitness)
      )
        return reject({ _tag: "decision_evidence_invalid", reasonCode: "required_stage_missing" });
      next = {
        ...current,
        decisionRevision: command.decision.decisionRevision,
        decision: command.decision,
        status: "processing",
        phase: "publish",
        action: null,
        review: null,
      };
      break;
    }
    case "reference_required": {
      if (
        command.expectedCreationRevision !== current.creationRevision ||
        command.expectedAudioRevision !== current.audioRevision ||
        command.expectedAnalysisRevision !== current.analysisRevision ||
        current.status !== "processing" ||
        current.phase !== "decision" ||
        current.analysis?.acr.decision !== "requires_reference" ||
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
        abandonment: null,
      };
      break;
    }
    case "policy_blocked": {
      if (
        command.expectedCreationRevision !== current.creationRevision ||
        current.status !== "processing" ||
        current.phase !== "decision" ||
        !validId(command.evidenceRef)
      )
        return reject({ _tag: "decision_evidence_invalid", reasonCode: "required_stage_missing" });
      next = {
        ...current,
        status: "blocked",
        phase: null,
        review: null,
        action: null,
        moderatorApproval: null,
        abandonment: null,
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
      const analysis =
        current.analysis === null
          ? null
          : { ...current.analysis, boundReference: command.reference };
      next = {
        ...current,
        creationRevision: current.creationRevision + 1,
        boundReference: command.reference,
        analysis,
        status: "processing",
        phase: "analysis",
        action: null,
        decision: null,
        decisionRevision: 0,
        abandonment: null,
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
      next = {
        ...current,
        status: "abandoned",
        phase: null,
        action: null,
        abandonment: {
          reason: "action_deadline_elapsed",
          retentionDisposition: current.audio === null ? "no_object" : "retain_until_expiry",
        },
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
        current.analysis === null ||
        current.audio === null ||
        command.approval.heldRevision !== current.creationRevision ||
        !validId(command.approval.actionId) ||
        !validId(command.approval.moderatorActorId) ||
        !validId(command.approval.evidenceRef) ||
        command.decision.outcome !== "allow" ||
        command.decision.creationRevision !== current.creationRevision ||
        command.decision.audioRevision !== current.audioRevision ||
        command.decision.analysisRevision !== current.analysisRevision ||
        command.decision.canonicalAudioSha256 !== current.audio.canonicalSha256 ||
        command.decision.decisionRevision !== current.decisionRevision + 1 ||
        current.analysis.mediaSafety !== "allow" ||
        !["skipped", "allow"].includes(current.analysis.lyricsSafety) ||
        current.analysis.speechLyrics.status === "unavailable" ||
        !["not_explicit", "no_lyrics"].includes(current.analysis.speechLyrics.explicitness) ||
        (current.analysis.acr.decision === "requires_reference" &&
          current.boundReference === null) ||
        (current.review.exhaustionCode === "acr_exhausted" &&
          (command.approval.approvalKind !== "acr_override" ||
            command.approval.reasonCode !== "acr_exhausted"))
      )
        return reject({ _tag: "decision_evidence_invalid", reasonCode: "required_stage_missing" });
      if (
        command.approval.approvalKind === "acr_override" &&
        !["acr_inconclusive", "acr_exhausted", "acr_skipped"].includes(
          command.approval.reasonCode ?? "",
        )
      )
        return reject({ _tag: "decision_evidence_invalid", reasonCode: "required_stage_missing" });
      if (command.approval.approvalKind === "standard" && command.approval.reasonCode !== null)
        return reject({ _tag: "decision_evidence_invalid", reasonCode: "required_stage_missing" });
      if (
        (current.analysis.acr.decision === "inconclusive" &&
          (command.approval.approvalKind !== "acr_override" ||
            command.approval.reasonCode !==
              (current.review.exhaustionCode === "acr_exhausted"
                ? "acr_exhausted"
                : "acr_inconclusive"))) ||
        (current.analysis.acr.decision === "skipped" &&
          (command.approval.approvalKind !== "acr_override" ||
            command.approval.reasonCode !== "acr_skipped")) ||
        (current.analysis.acr.decision === "allow" &&
          command.approval.approvalKind === "acr_override")
      )
        return reject({ _tag: "decision_evidence_invalid", reasonCode: "required_stage_missing" });
      next = {
        ...current,
        decisionRevision: command.decision.decisionRevision,
        decision: command.decision,
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
        !validId(command.evidenceRef) ||
        command.reasonCode !== "policy_violation"
      )
        return reject({ _tag: "actor_not_authorized", reasonCode: "moderator_role_required" });
      next = {
        ...current,
        status: "blocked",
        phase: null,
        review: null,
        action: null,
        moderatorApproval: {
          actionId: command.actionId,
          moderatorActorId: command.moderatorActorId,
          evidenceRef: command.evidenceRef,
          reasonCode: command.reasonCode,
          heldRevision: current.creationRevision,
        },
      };
      break;
    }
    case "publication_committed": {
      if (!command.communityActive || !command.membershipActive)
        return reject({ _tag: "actor_not_authorized", reasonCode: "active_membership_required" });
      if (command.expectedCreationRevision !== current.creationRevision)
        return stale(command.expectedCreationRevision, current.creationRevision);
      if (
        command.expectedAudioRevision !== current.audioRevision ||
        command.expectedAnalysisRevision !== current.analysisRevision ||
        command.expectedDecisionRevision !== current.decisionRevision ||
        current.status !== "processing" ||
        current.phase !== "publish" ||
        current.decision?.outcome !== "allow" ||
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
    case "retry_authorized": {
      if (
        command.expectedCreationRevision !== current.creationRevision ||
        current.status !== "processing_failed" ||
        current.failure === null
      )
        return reject({ _tag: "retry_not_allowed", reasonCode: "failure_not_retryable" });
      if (!current.failure.retryable)
        return reject({ _tag: "retry_not_allowed", reasonCode: "failure_not_retryable" });
      if (current.failure.retryCount >= 3 || current.retryCount >= 3)
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
        abandonment: null,
      };
      break;
    }
    case "author_cancelled":
    case "reservation_expired": {
      if (
        command.expectedCreationRevision !== current.creationRevision ||
        current.audioRevision > 0 ||
        current.status !== "processing" ||
        (command.event === "author_cancelled"
          ? !["reserve", "awaiting_upload"].includes(current.phase ?? "")
          : current.phase !== "awaiting_upload")
      )
        return reject({
          _tag: "transition_not_allowed",
          state: current.status,
          event: command.event,
        });
      next = {
        ...current,
        status: "abandoned",
        phase: null,
        action: null,
        review: null,
        moderatorApproval: null,
        failure: null,
        abandonment: { reason: command.event, retentionDisposition: "no_object" },
      };
      break;
    }
    case "upload_expectation_mismatch_recorded":
    case "upload_source_precondition_failed": {
      if (
        command.expectedCreationRevision !== current.creationRevision ||
        current.audioRevision > 0 ||
        (command.event === "upload_expectation_mismatch_recorded"
          ? !["awaiting_upload", "finalize"].includes(current.phase ?? "")
          : current.phase !== "finalize") ||
        !validId(command.evidenceRef)
      )
        return reject({
          _tag: "transition_not_allowed",
          state: current.status,
          event: command.event,
        });
      next = {
        ...current,
        status: "abandoned",
        phase: null,
        abandonment: command.abandonment,
        action: null,
        review: null,
        moderatorApproval: null,
        failure: null,
      };
      break;
    }
  }
  return done(current, next);
}
export const createMediaSubmissionState = (
  input: Extract<MediaSubmissionCommand, { event: "submission_reserved" }>,
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

import { describe, expect, test } from "bun:test";

import {
  createMediaSubmissionState,
  deterministicMediaWorkflowInstanceId,
  type ImmutableAudio,
  type PublicationDecision,
  type SongTerms,
  type TrustedSongAnalysis,
  transitionMediaSubmission,
} from "./media-submission.ts";

const actorId = "media_actor";
const operationId = "media_operation";
const audioHash = "a".repeat(64);
const audio: ImmutableAudio = {
  audioRevision: 1,
  immutableRef: "immutable_audio",
  canonicalSha256: audioHash,
  contentType: "audio/mpeg",
  sizeBytes: 1024,
};
const terms: SongTerms = {
  licensePreset: "non-commercial",
  commercialRemixShareBps: 0,
  royaltyAllocations: [{ recipientId: actorId, shareBps: 10_000 }],
  accessMode: "public",
};
const analysis = (
  acrDecision: TrustedSongAnalysis["acr"]["decision"] = "allow",
): TrustedSongAnalysis => ({
  version: "song-trusted-analysis-v1",
  operationId,
  analysisRevision: 1,
  audioRevision: 1,
  canonicalAudioSha256: audioHash,
  finalizedAudioRef: audio.immutableRef,
  probeEvidenceRef: "probe",
  embeddedMetadata: {
    evidenceRef: "metadata",
    adapterRevision: "metadata-adapter-v1",
    trackTitle: null,
    cover: { status: "absent", reasonCode: "not_embedded" },
  },
  speechLyrics: {
    status: "no_speech",
    explicitness: "no_lyrics",
    evidenceRef: "speech",
    policyRevision: "speech-v1",
    adapterRevision: "speech-adapter-v1",
  },
  acr: {
    decision: acrDecision,
    evidenceRef: "acr",
    policyRevision: "acr-policy-v1",
    adapterRevision: "acr-adapter-v1",
  },
  mediaSafety: "allow",
  lyricsSafety: "skipped",
  boundReference: null,
});

const created = createMediaSubmissionState({
  event: "submission_reserved",
  actorId,
  expectedCreationRevision: 0,
  submissionId: "media_submission",
  operationId,
  communityId: "media_community",
  title: "Author title",
  songType: "original",
  reservationId: "media_reservation",
});

function ok<A extends ReturnType<typeof transitionMediaSubmission>>(result: A) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.rejection._tag);
  return result.state;
}

function analyzed(acrDecision: TrustedSongAnalysis["acr"]["decision"] = "allow") {
  const withTerms = ok(
    transitionMediaSubmission(created, {
      event: "song_terms_bound",
      actorId,
      expectedCreationRevision: 1,
      terms,
    }),
  );
  const finalized = ok(
    transitionMediaSubmission(withTerms, {
      event: "upload_finalized",
      actorId,
      expectedCreationRevision: 2,
      expectedAudioRevision: 0,
      audio,
    }),
  );
  return ok(
    transitionMediaSubmission(finalized, {
      event: "blocking_analysis_completed",
      actorId,
      expectedAudioRevision: 1,
      expectedCanonicalAudioSha256: audioHash,
      analysis: analysis(acrDecision),
    }),
  );
}

describe("song media Spec 013 machine", () => {
  test("starts form-light and uses the exact workflow identity", () => {
    expect(created).toMatchObject({
      status: "processing",
      phase: "awaiting_upload",
      creationRevision: 1,
      audioRevision: 0,
    });
    expect(deterministicMediaWorkflowInstanceId(operationId, 1)).toBe("media-media_operation-r1");
  });

  test("binds terms separately and accepts the correct initial analysis revision", () => {
    const state = analyzed();
    expect(state).toMatchObject({
      status: "processing",
      phase: "decision",
      creationRevision: 2,
      audioRevision: 1,
      analysisRevision: 1,
    });
    expect(
      transitionMediaSubmission(state, {
        event: "blocking_analysis_completed",
        actorId,
        expectedAudioRevision: 1,
        expectedCanonicalAudioSha256: audioHash,
        analysis: { ...analysis(), analysisRevision: 3 },
      }),
    ).toMatchObject({ ok: false, rejection: { _tag: "analysis_evidence_stale" } });
  });

  test("requires exact reference evidence before remix publication", () => {
    const remix = createMediaSubmissionState({
      event: "submission_reserved",
      actorId,
      expectedCreationRevision: 0,
      submissionId: "media_submission",
      operationId,
      communityId: "media_community",
      title: "Fixture",
      songType: "remix",
      reservationId: "media_reservation",
    });
    const withTerms = ok(
      transitionMediaSubmission(remix, {
        event: "song_terms_bound",
        actorId,
        expectedCreationRevision: 1,
        terms,
      }),
    );
    const finalized = ok(
      transitionMediaSubmission(withTerms, {
        event: "upload_finalized",
        actorId,
        expectedCreationRevision: 2,
        expectedAudioRevision: 0,
        audio,
      }),
    );
    const match = ok(
      transitionMediaSubmission(finalized, {
        event: "blocking_analysis_completed",
        actorId,
        expectedAudioRevision: 1,
        expectedCanonicalAudioSha256: audioHash,
        analysis: analysis("requires_reference"),
      }),
    );
    const action = ok(
      transitionMediaSubmission(match, {
        event: "reference_required",
        actorId,
        expectedCreationRevision: 2,
        expectedAudioRevision: 1,
        expectedAnalysisRevision: 1,
        referenceRequestRef: "ref-request",
        actionExpiresAt: "2999-01-01T00:00:00.000Z",
      }),
    );
    expect(action.status).toBe("action_required");
    const bound = ok(
      transitionMediaSubmission(action, {
        event: "reference_bound",
        actorId,
        expectedCreationRevision: 2,
        nowEpochMs: Date.parse("2998-01-01T00:00:00.000Z"),
        reference: {
          assetId: "upstream",
          evidenceRef: "reference-evidence",
          evidenceAudioRevision: 1,
          evidenceAnalysisRevision: 1,
          evidenceAudioSha256: audioHash,
          upstreamCommercialRevShareBps: 1000,
        },
      }),
    );
    expect(bound).toMatchObject({
      status: "processing",
      phase: "analysis",
      creationRevision: 3,
      boundReference: { assetId: "upstream" },
    });
  });

  test("records review and moderator evidence, and bounds technical retries at three", () => {
    const state = analyzed();
    const review = ok(
      transitionMediaSubmission(state, {
        event: "review_required",
        actorId,
        expectedCreationRevision: 2,
        expectedAudioRevision: 1,
        expectedAnalysisRevision: 1,
        review: { reviewRef: "review", heldRevision: 2, reasonCode: "moderation_unavailable" },
        decision: {
          decisionRevision: 1,
          outcome: "manual_review",
          creationRevision: 2,
          audioRevision: 1,
          analysisRevision: 1,
          canonicalAudioSha256: audioHash,
          policyRevision: "review-policy",
          evidenceRef: "review-decision",
        },
      }),
    );
    const approved = ok(
      transitionMediaSubmission(review, {
        event: "moderator_approved",
        actorId,
        expectedCreationRevision: 2,
        communityActive: true,
        membershipActive: true,
        approval: {
          actionId: "moderator-action",
          moderatorActorId: "moderator",
          evidenceRef: "review-evidence",
          approvalKind: "standard",
          reasonCode: null,
          heldRevision: 2,
        },
        decision: {
          decisionRevision: 2,
          outcome: "allow",
          creationRevision: 2,
          audioRevision: 1,
          analysisRevision: 1,
          canonicalAudioSha256: audioHash,
          policyRevision: "publication-v1",
          evidenceRef: "moderator-decision",
        },
      }),
    );
    expect(approved).toMatchObject({ status: "processing", phase: "publish" });
    let failed = ok(
      transitionMediaSubmission(state, {
        event: "technical_exhaustion_recorded",
        actorId,
        expectedCreationRevision: 2,
        failure: {
          code: "probe_failed",
          retryable: true,
          retryCount: 0,
          lastSafePhase: "analysis",
        },
      }),
    );
    for (const retryCount of [1, 2, 3] as const) {
      const retried = ok(
        transitionMediaSubmission(failed, {
          event: "retry_authorized",
          actorId,
          expectedCreationRevision: failed.creationRevision,
        }),
      );
      failed = ok(
        transitionMediaSubmission(retried, {
          event: "technical_exhaustion_recorded",
          actorId,
          expectedCreationRevision: retried.creationRevision,
          failure: {
            code: "probe_failed",
            retryable: retryCount < 3,
            retryCount,
            lastSafePhase: "analysis",
          },
        }),
      );
    }
    expect(
      transitionMediaSubmission(failed, {
        event: "retry_authorized",
        actorId,
        expectedCreationRevision: failed.creationRevision,
      }),
    ).toMatchObject({
      ok: false,
      rejection: { _tag: "retry_not_allowed", reasonCode: "failure_not_retryable" },
    });
  });

  test("requires the private ACR exhaustion hold for the exhausted override", () => {
    for (const acrDecision of ["inconclusive", "skipped"] as const) {
      const held = ok(
        transitionMediaSubmission(analyzed(acrDecision), {
          event: "review_required",
          actorId,
          expectedCreationRevision: 2,
          expectedAudioRevision: 1,
          expectedAnalysisRevision: 1,
          review: { reviewRef: "ordinary-review", heldRevision: 2, reasonCode: "review_required" },
          decision: {
            decisionRevision: 1,
            outcome: "manual_review",
            creationRevision: 2,
            audioRevision: 1,
            analysisRevision: 1,
            canonicalAudioSha256: audioHash,
            policyRevision: "review-policy",
            evidenceRef: "ordinary-review-evidence",
          },
        }),
      );
      expect(
        transitionMediaSubmission(held, {
          event: "moderator_approved",
          actorId,
          expectedCreationRevision: 2,
          communityActive: true,
          membershipActive: true,
          approval: {
            actionId: "ordinary-acr-action",
            moderatorActorId: "moderator",
            evidenceRef: "ordinary-acr-evidence",
            approvalKind: "acr_override",
            reasonCode: "acr_exhausted",
            heldRevision: 2,
          },
          decision: {
            decisionRevision: 1,
            outcome: "allow",
            creationRevision: 2,
            audioRevision: 1,
            analysisRevision: 1,
            canonicalAudioSha256: audioHash,
            policyRevision: "publication-v1",
            evidenceRef: "ordinary-acr-decision",
          },
        }),
      ).toMatchObject({ ok: false, rejection: { _tag: "decision_evidence_invalid" } });
    }
    const exhausted = ok(
      transitionMediaSubmission(analyzed("inconclusive"), {
        event: "review_exhaustion_recorded",
        actorId,
        expectedCreationRevision: 2,
        review: {
          reviewRef: "acr-exhausted-review",
          heldRevision: 2,
          reasonCode: "review_required",
          exhaustionCode: "acr_exhausted",
          exhaustionAttemptId: "acr-attempt-3",
        },
      }),
    );
    expect(
      ok(
        transitionMediaSubmission(exhausted, {
          event: "moderator_approved",
          actorId,
          expectedCreationRevision: 2,
          communityActive: true,
          membershipActive: true,
          approval: {
            actionId: "acr-exhausted-action",
            moderatorActorId: "moderator",
            evidenceRef: "acr-exhausted-evidence",
            approvalKind: "acr_override",
            reasonCode: "acr_exhausted",
            heldRevision: 2,
          },
          decision: {
            decisionRevision: 1,
            outcome: "allow",
            creationRevision: 2,
            audioRevision: 1,
            analysisRevision: 1,
            canonicalAudioSha256: audioHash,
            policyRevision: "publication-v1",
            evidenceRef: "acr-exhausted-decision",
          },
        }),
      ).status,
    ).toBe("processing");
  });

  test("supersedes held review terms with a new creation revision", () => {
    const held = ok(
      transitionMediaSubmission(analyzed(), {
        event: "review_required",
        actorId,
        expectedCreationRevision: 2,
        expectedAudioRevision: 1,
        expectedAnalysisRevision: 1,
        review: { reviewRef: "held-review", heldRevision: 2, reasonCode: "review_required" },
        decision: {
          decisionRevision: 1,
          outcome: "manual_review",
          creationRevision: 2,
          audioRevision: 1,
          analysisRevision: 1,
          canonicalAudioSha256: audioHash,
          policyRevision: "review-policy",
          evidenceRef: "held-decision",
        },
      }),
    );
    const replaced = ok(
      transitionMediaSubmission(held, {
        event: "song_terms_bound",
        actorId,
        expectedCreationRevision: 2,
        terms,
      }),
    );
    expect(replaced).toMatchObject({
      creationRevision: 3,
      status: "processing",
      phase: "analysis",
      review: null,
      action: null,
    });
  });

  test("requires active community membership at publication", () => {
    const state = analyzed();
    const decision: PublicationDecision = {
      decisionRevision: 1,
      outcome: "allow",
      creationRevision: 2,
      audioRevision: 1,
      analysisRevision: 1,
      canonicalAudioSha256: audioHash,
      policyRevision: "publication-v1",
      evidenceRef: "decision-evidence",
    };
    const ready = ok(
      transitionMediaSubmission(state, {
        event: "publication_allowed",
        actorId,
        expectedCreationRevision: 2,
        expectedAudioRevision: 1,
        expectedAnalysisRevision: 1,
        decision,
      }),
    );
    expect(
      transitionMediaSubmission(ready, {
        event: "publication_committed",
        actorId,
        expectedCreationRevision: 2,
        expectedAudioRevision: 1,
        expectedAnalysisRevision: 1,
        expectedDecisionRevision: 1,
        communityActive: true,
        membershipActive: false,
        postId: "media-post-media_operation",
      }),
    ).toMatchObject({ ok: false, rejection: { _tag: "actor_not_authorized" } });
    expect(
      ok(
        transitionMediaSubmission(ready, {
          event: "publication_committed",
          actorId,
          expectedCreationRevision: 2,
          expectedAudioRevision: 1,
          expectedAnalysisRevision: 1,
          expectedDecisionRevision: 1,
          communityActive: true,
          membershipActive: true,
          postId: "media-post-media_operation",
        }),
      ).status,
    ).toBe("published");
  });

  test("keeps abandonment phases and seal conflicts typed", () => {
    const withTerms = ok(
      transitionMediaSubmission(created, {
        event: "song_terms_bound",
        actorId,
        expectedCreationRevision: 1,
        terms,
      }),
    );
    expect(
      transitionMediaSubmission(withTerms, {
        event: "upload_source_precondition_failed",
        actorId,
        expectedCreationRevision: 2,
        abandonment: {
          reason: "upload_source_changed_before_finalize",
          retentionDisposition: "retain_for_reconciliation",
        },
        evidenceRef: "source-precondition-evidence",
      }),
    ).toMatchObject({ ok: false, rejection: { _tag: "transition_not_allowed" } });
    for (const phase of ["awaiting_upload", "analysis", "decision", "publish"] as const) {
      expect(
        transitionMediaSubmission(
          { ...analyzed(), phase },
          {
            event: "seal_conflict_recorded",
            actorId,
            expectedCreationRevision: 2,
            failure: {
              code: "upload_seal_conflict",
              retryable: false,
              retryCount: 0,
              lastSafePhase: "finalize",
              evidenceRef: "seal-conflict-evidence",
            },
          },
        ),
      ).toMatchObject({ ok: false, rejection: { _tag: "transition_not_allowed" } });
    }
    expect(
      ok(
        transitionMediaSubmission(withTerms, {
          event: "upload_expectation_mismatch_recorded",
          actorId,
          expectedCreationRevision: 2,
          abandonment: {
            reason: "upload_expectation_mismatch",
            retentionDisposition: "retain_for_reconciliation",
          },
          evidenceRef: "upload-mismatch-evidence",
        }),
      ),
    ).toMatchObject({
      status: "abandoned",
      abandonment: { retentionDisposition: "retain_for_reconciliation" },
    });
    const analyzedState = { ...analyzed(), phase: "finalize" as const };
    expect(
      ok(
        transitionMediaSubmission(analyzedState, {
          event: "seal_conflict_recorded",
          actorId,
          expectedCreationRevision: 2,
          failure: {
            code: "upload_seal_conflict",
            retryable: false,
            retryCount: 0,
            lastSafePhase: "finalize",
            evidenceRef: "seal-conflict-evidence",
          },
        }),
      ),
    ).toMatchObject({
      status: "processing_failed",
      failure: { code: "upload_seal_conflict", retryable: false },
    });
  });
});

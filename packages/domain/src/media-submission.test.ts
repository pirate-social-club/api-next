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

function analyzed() {
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
      analysis: analysis(),
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
        event: "review_exhaustion_recorded",
        actorId,
        expectedCreationRevision: 2,
        review: { reviewRef: "review", heldRevision: 2, reasonCode: "moderation_unavailable" },
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
          decisionRevision: 1,
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

  test("supersedes held review terms with a new creation revision", () => {
    const held = ok(
      transitionMediaSubmission(analyzed(), {
        event: "review_exhaustion_recorded",
        actorId,
        expectedCreationRevision: 2,
        review: { reviewRef: "held-review", heldRevision: 2, reasonCode: "review_required" },
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
});

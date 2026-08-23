import { describe, expect, test } from "bun:test";

import {
  createMediaSubmissionState,
  deterministicMediaWorkflowInstanceId,
  type ImmutableAudio,
  mediaSubmissionInvariant,
  type PublicationDecision,
  type SongTerms,
  type TrustedSongAnalysis,
  transitionMediaSubmission,
} from "./media-submission.ts";

const actorId = "media_actor";
const canonicalAudioSha256 = "a".repeat(64);
const artifactSha256 = "b".repeat(64);
const transcriptSha256 = "c".repeat(64);

const created = createMediaSubmissionState({
  event: "submission_created",
  actorId,
  expectedCreationRevision: 0,
  submissionId: "media_submission",
  operationId: "media_operation",
  communityId: "media_community",
  title: "Author title",
  songType: "original",
  reservationId: "media_reservation",
});

const terms: SongTerms = {
  licensePreset: "commercial-remix",
  commercialRemixShareBps: 0,
  royaltyAllocations: [{ recipientId: actorId, shareBps: 10_000 }],
  accessMode: "public",
};

const audio: ImmutableAudio = {
  audioRevision: 1,
  immutableRef: "media_immutable_audio",
  canonicalSha256: canonicalAudioSha256,
  contentType: "audio/mpeg",
  sizeBytes: 1234,
};

const analysis = (analysisRevision = 1): TrustedSongAnalysis => ({
  analysisRevision,
  audioRevision: 1,
  canonicalAudioSha256,
  finalizedAudioRef: audio.immutableRef,
  probeEvidenceRef: "probe_evidence",
  embeddedMetadataEvidenceRef: "embedded_metadata_evidence",
  embeddedTitle: "Embedded title",
  cover: {
    status: "ready",
    artifactRef: "cover_artifact",
    artifactSha256,
    mediaType: "image/jpeg",
    normalizationRevision: "cover_normalization_v1",
    safetyPolicyRevision: "cover_safety_v1",
  },
  speech: {
    status: "ready",
    transcriptArtifactRef: "transcript_artifact",
    transcriptSha256,
    explicitness: "not_explicit",
    primaryLanguageBcp47: "en-US",
    secondaryLanguageBcp47: null,
    evidenceRef: "speech_evidence",
    policyRevision: "speech_policy_v1",
    adapterRevision: "speech_adapter_v1",
  },
  acrDecision: "allow",
  acrEvidenceRef: "acr_evidence",
  acrPolicyRevision: "acr_policy_v1",
  acrAdapterRevision: "acr_adapter_v1",
  mediaSafety: "allow",
  lyricsSafety: "allow",
});

function expectState(
  result: ReturnType<typeof transitionMediaSubmission>,
): Extract<typeof result, { readonly ok: true }>["state"] {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.rejection.tag);
  expect(mediaSubmissionInvariant(result.state)).toBeNull();
  return result.state;
}

function analyzedState() {
  const withTerms = expectState(
    transitionMediaSubmission(created, {
      event: "terms_bound",
      actorId,
      expectedCreationRevision: 1,
      terms,
    }),
  );
  const finalized = expectState(
    transitionMediaSubmission(withTerms, {
      event: "audio_finalized",
      actorId,
      expectedCreationRevision: 2,
      expectedAudioRevision: 0,
      audio,
    }),
  );
  return expectState(
    transitionMediaSubmission(finalized, {
      event: "analysis_accepted",
      actorId,
      expectedAudioRevision: 1,
      expectedCanonicalAudioSha256: canonicalAudioSha256,
      analysis: analysis(),
    }),
  );
}

describe("song media submission persistence machine", () => {
  test("starts with only form-light author facts", () => {
    expect(created).toMatchObject({
      creationRevision: 1,
      audioRevision: 0,
      analysisRevision: 0,
      decisionRevision: 0,
      workflowRevision: 0,
      status: "awaiting_upload",
      terms: null,
      audio: null,
    });
    expect(created).not.toHaveProperty("lyrics");
    expect(created).not.toHaveProperty("language");
    expect(created).not.toHaveProperty("commentary");
  });

  test("separates mutable terms from immutable audio and analysis revisions", () => {
    const analyzed = analyzedState();
    expect(analyzed).toMatchObject({
      creationRevision: 2,
      audioRevision: 1,
      analysisRevision: 1,
      workflowRevision: 1,
      status: "decision_pending",
    });

    const changedTerms = expectState(
      transitionMediaSubmission(analyzed, {
        event: "terms_bound",
        actorId,
        expectedCreationRevision: 2,
        terms: { ...terms, commercialRemixShareBps: 1000 },
      }),
    );
    expect(changedTerms).toMatchObject({
      creationRevision: 3,
      audioRevision: 1,
      analysisRevision: 1,
      decisionRevision: 0,
      analysis: { canonicalAudioSha256 },
    });
  });

  test("rejects analysis copied across audio revision or hash identity", () => {
    const finalized = expectState(
      transitionMediaSubmission(created, {
        event: "audio_finalized",
        actorId,
        expectedCreationRevision: 1,
        expectedAudioRevision: 0,
        audio,
      }),
    );
    expect(
      transitionMediaSubmission(finalized, {
        event: "analysis_accepted",
        actorId,
        expectedAudioRevision: 1,
        expectedCanonicalAudioSha256: "d".repeat(64),
        analysis: analysis(),
      }),
    ).toEqual({ ok: false, rejection: { tag: "audio_identity_mismatch" } });
    expect(
      transitionMediaSubmission(finalized, {
        event: "analysis_accepted",
        actorId,
        expectedAudioRevision: 1,
        expectedCanonicalAudioSha256: canonicalAudioSha256,
        analysis: { ...analysis(), audioRevision: 2 },
      }),
    ).toEqual({ ok: false, rejection: { tag: "audio_identity_mismatch" } });
  });

  test("allows a later stage-analysis revision without rerunning unchanged audio", () => {
    const first = analyzedState();
    const second = expectState(
      transitionMediaSubmission(first, {
        event: "analysis_accepted",
        actorId,
        expectedAudioRevision: 1,
        expectedCanonicalAudioSha256: canonicalAudioSha256,
        analysis: analysis(2),
      }),
    );
    expect(second).toMatchObject({
      creationRevision: 2,
      audioRevision: 1,
      analysisRevision: 2,
      workflowRevision: 1,
    });
  });

  test("binds decisions to exact current terms and evidence revisions", () => {
    const analyzed = analyzedState();
    const decision: PublicationDecision = {
      decisionRevision: 1,
      outcome: "allow",
      creationRevision: 2,
      audioRevision: 1,
      analysisRevision: 1,
      canonicalAudioSha256,
      policyRevision: "publication_policy_v1",
      evidenceRef: "publication_decision_evidence",
    };
    expect(
      transitionMediaSubmission(analyzed, {
        event: "decision_recorded",
        actorId,
        expectedCreationRevision: 2,
        expectedAudioRevision: 1,
        expectedAnalysisRevision: 1,
        decision: { ...decision, creationRevision: 1 },
      }),
    ).toEqual({ ok: false, rejection: { tag: "decision_evidence_incomplete" } });
    const decided = expectState(
      transitionMediaSubmission(analyzed, {
        event: "decision_recorded",
        actorId,
        expectedCreationRevision: 2,
        expectedAudioRevision: 1,
        expectedAnalysisRevision: 1,
        decision,
      }),
    );
    expect(decided).toMatchObject({ status: "ready_to_publish", decisionRevision: 1 });
  });

  test("rechecks active community effect before publication", () => {
    const analyzed = analyzedState();
    const decided = expectState(
      transitionMediaSubmission(analyzed, {
        event: "decision_recorded",
        actorId,
        expectedCreationRevision: 2,
        expectedAudioRevision: 1,
        expectedAnalysisRevision: 1,
        decision: {
          decisionRevision: 1,
          outcome: "allow",
          creationRevision: 2,
          audioRevision: 1,
          analysisRevision: 1,
          canonicalAudioSha256,
          policyRevision: "publication_policy_v1",
          evidenceRef: "publication_decision_evidence",
        },
      }),
    );
    expect(
      transitionMediaSubmission(decided, {
        event: "publication_committed",
        actorId,
        expectedCreationRevision: 2,
        expectedAudioRevision: 1,
        expectedAnalysisRevision: 1,
        expectedDecisionRevision: 1,
        communityActive: true,
        membershipActive: false,
        postId: "media_post",
      }),
    ).toEqual({ ok: false, rejection: { tag: "inactive_community_effect" } });
    const published = expectState(
      transitionMediaSubmission(decided, {
        event: "publication_committed",
        actorId,
        expectedCreationRevision: 2,
        expectedAudioRevision: 1,
        expectedAnalysisRevision: 1,
        expectedDecisionRevision: 1,
        communityActive: true,
        membershipActive: true,
        postId: "media_post",
      }),
    );
    expect(published).toMatchObject({
      status: "published",
      workflowRevision: 2,
      postId: "media_post",
    });
  });

  test("derives deterministic workflow identity from operation and revision", () => {
    expect(deterministicMediaWorkflowInstanceId("media_operation", 1)).toBe(
      "media_operation:workflow:1",
    );
  });
});

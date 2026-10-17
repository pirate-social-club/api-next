import { expect, test } from "bun:test";
import { ControlPlaneDb, type ControlPlaneStatement } from "@pirate/application";
import { Effect, Layer } from "effect";
import {
  acceptTrustedVideoAnalysis,
  attachSongVideoMasterAndPublish,
  moderateVideoSubmission,
  type VideoPublicationCommitServices,
  type VideoSubmissionRecord,
} from "../../application/src/video/publication.ts";
import { videoPublicationPostId } from "../../application/src/video/publication-identity.ts";
import {
  attachAcceptedSongVideoMaster,
  attachImmutableVideo,
  attachVideoDecision,
  createOriginalVideoSubmission,
  createSongReferenceVideoSubmission,
  decideOriginalAudioVideo,
  decideSongReferenceVideo,
  type VideoSubmissionState,
  type VideoTrustedAnalysis,
} from "../../domain/src/video-submission.ts";
import {
  notificationsVideoPublicationServicesFixture,
  notificationsVideoPublicationStoreFixture,
} from "./notifications-video-publication-test-fixture.ts";
import { operationId, submissionId, trustedAnalysis } from "./video-publication.pg-fixture.ts";
import { makeControlPlaneVideoPublicationStore } from "./video-publication-repository.ts";

function prepared(intent: "original_audio" | "song_reference"): VideoSubmissionRecord {
  const base = {
    submissionId,
    operationId,
    communityId: "community",
    actorAccountId: "actor",
    authorPersonaId: "persona",
    reservationId: "reservation",
    caption: null,
    authorDeclaredRating: "general" as const,
  };
  let state =
    intent === "original_audio"
      ? createOriginalVideoSubmission(base)
      : createSongReferenceVideoSubmission({
          ...base,
          songPlan: {
            planId: "plan",
            songPostId: "song",
            songAssetId: "asset",
            audioRevision: 1,
            canonicalAudioSha256: "c".repeat(64),
            songDurationSamples: 960000,
            clipStartSamples: 0,
            clipDurationSamples: 480000,
            intervalPolicyRevision: 1,
          },
        });
  const analysis: VideoTrustedAnalysis =
    intent === "original_audio"
      ? trustedAnalysis()
      : { ...trustedAnalysis(), audio: { intent: "song_reference" } };
  state = attachImmutableVideo(
    { ...state, posterTimestampMs: 1000 },
    {
      videoRevision: 1,
      immutableRef: analysis.finalizedVideoRef,
      canonicalSha256: analysis.canonicalVideoSha256,
      sizeBytes: analysis.byteLength,
      contentType: "video/mp4",
    },
  );
  const input = {
    state,
    analysis,
    canonicalCaptionSha256: null,
    decidedAt: "2026-10-16T00:00:00Z",
  };
  state = attachVideoDecision(
    state,
    analysis,
    intent === "original_audio"
      ? decideOriginalAudioVideo(input)
      : decideSongReferenceVideo({ ...input, song: { permitted: true, contentRating: "general" } }),
  );
  if (intent === "song_reference")
    state = attachAcceptedSongVideoMaster(state, {
      masterRevisionId: "master",
      attemptId: "attempt",
      masterRef: "media://master",
      masterSha256: "d".repeat(64),
      masterByteLength: 2048,
      soundtrackSha256: "e".repeat(64),
    });
  return {
    state,
    eventSequence: 1,
    updatedAt: "2026-10-16T00:00:00Z",
    authorPersona: {
      persona_id: state.authorPersonaId,
      object: "persona",
      display_name: null,
      avatar_ref: null,
      primary_public_handle: null,
    },
  };
}

for (const intent of ["original_audio", "song_reference"] as const) {
  test(`${intent}: definite alias rollback keeps the same ID, revision/approval and concurrent attempts cannot rotate it`, async () => {
    let record = prepared(intent);
    const ids: string[] = [];
    const publish = async (input: { state: VideoSubmissionState }) => {
      if (input.state.postId === null) throw new Error("Publication identity required");
      ids.push(input.state.postId);
      throw new Error("exact alias collision: rollback");
    };
    const services: VideoPublicationCommitServices = {
      nowIso: () => record.updatedAt,
      randomUuid: () => {
        throw new Error("publication must not allocate random ID");
      },
      store: notificationsVideoPublicationStoreFixture({
        getSubmissionByOperation: async () => record,
        publish,
        publishSongReference: publish,
      }),
    };
    const analysis = record.state.analysis;
    if (analysis === null) throw new Error("Prepared analysis required");
    const input = { submissionId, analysis };
    await expect(acceptTrustedVideoAnalysis(input, services)).rejects.toThrow(
      "exact alias collision",
    );
    record = {
      ...record,
      state: { ...record.state, creationRevision: 4, approvedHolds: ["safety"] },
    };
    const results = await Promise.allSettled([
      acceptTrustedVideoAnalysis(input, services),
      acceptTrustedVideoAnalysis(input, services),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    const expected = await videoPublicationPostId(record.state);
    expect(ids).toEqual([expected, expected, expected]);
    expect(record.state.postId).toBeNull();
  });
  test(`${intent}: a committed publication with lost acknowledgement replays its unchanged href without publishing again`, async () => {
    let record = prepared(intent);
    let calls = 0;
    const publish = async (input: { state: VideoSubmissionState }) => {
      calls++;
      record = { ...record, state: input.state };
      throw new Error("commit acknowledgement lost");
    };
    const services: VideoPublicationCommitServices = {
      nowIso: () => record.updatedAt,
      randomUuid: () => {
        throw new Error("random ID forbidden");
      },
      store: notificationsVideoPublicationStoreFixture({
        getSubmissionByOperation: async () => record,
        publish,
        publishSongReference: publish,
      }),
    };
    const analysis = record.state.analysis;
    if (analysis === null) throw new Error("Prepared analysis required");
    const input = { submissionId, analysis };
    await expect(acceptTrustedVideoAnalysis(input, services)).rejects.toThrow(
      "acknowledgement lost",
    );
    const result = await acceptTrustedVideoAnalysis(input, services);
    const postId = record.state.postId;
    if (postId === null) throw new Error("Committed publication identity required");
    expect(result).toMatchObject({
      status: "published",
      published_resource: {
        post_id: postId,
        href: `/posts/${encodeURIComponent(postId)}`,
      },
    });
    expect(calls).toBe(1);
  });
}

test("real owner-approval application entry retains the source key and uses the same later publication identity", async () => {
  let record = prepared("original_audio");
  const ready = record.state;
  if (ready.decision === null || ready.analysis === null)
    throw new Error("Prepared decision required");
  record = {
    ...record,
    state: {
      ...ready,
      status: "manual_review",
      phase: null,
      reviewReasons: ["media_review_required"],
      decision: {
        ...ready.decision,
        outcome: { kind: "review", reasonCodes: ["media_review_required"] },
      },
    },
  };
  const selected: { postId: string | null } = { postId: null };
  const store = notificationsVideoPublicationStoreFixture({
    getSubmissionForModerator: async () => record,
    getSubmissionByOperation: async () => record,
    moderate: async () => {
      record = { ...record, state: { ...ready, approvedHolds: ["safety"] } };
      return { kind: "none" as const };
    },
    publish: async (input) => {
      selected.postId = input.state.postId;
      return { ...record, state: input.state };
    },
  });
  const services = notificationsVideoPublicationServicesFixture({
    store,
    nowIso: () => record.updatedAt,
  });
  await moderateVideoSubmission(
    {
      submissionId,
      actor: { kind: "user", userId: "owner" },
      body: {
        action: "approve",
        approval_kind: "standard",
        hold: "safety",
        expected_creation_revision: 1,
        idempotency_key: "approval",
      },
    },
    services,
  );
  const result = await acceptTrustedVideoAnalysis(
    { submissionId, analysis: ready.analysis },
    services,
  );
  if (selected.postId === null) throw new Error("Approved publication identity required");
  expect(selected.postId).toBe(await videoPublicationPostId(ready));
  expect(result).toMatchObject({
    status: "published",
    published_resource: { post_id: selected.postId },
  });
});

test("actual publication store reconciles persisted Post/projection/alias ownership on published reload without writes", async () => {
  const record = prepared("original_audio");
  const state = {
    ...record.state,
    status: "published" as const,
    phase: null,
    postId: await videoPublicationPostId(record.state),
  };
  for (const owned of [true, false]) {
    const calls: ControlPlaneStatement[] = [];
    const execute: ControlPlaneDb["Service"]["execute"] = (statement) => {
      calls.push(statement);
      const rows = statement.label.endsWith("identity.reconcile")
        ? [{ owned }]
        : [
            {
              submission_id: state.submissionId,
              operation_id: state.operationId,
              author_persona_id: state.authorPersonaId,
              video_intent: state.intent,
              video_state_snapshot: state,
              event_sequence: 2,
              updated_at: record.updatedAt,
              author_persona: record.authorPersona,
            },
          ];
      return Effect.succeed({ rows: rows as never, rowCount: 1 });
    };
    const store = makeControlPlaneVideoPublicationStore(
      Layer.succeed(ControlPlaneDb, { execute, withTransaction: (use) => use({ execute }) }),
    );
    const result = store.getSubmissionByOperation({ submissionId, operationId });
    if (owned) expect((await result)?.state.postId).toBe(state.postId);
    else await expect(result).rejects.toThrow("requires reconciliation");
    expect(calls.map((c) => c.label)).toEqual([
      "video-publication.submission-read",
      "video-publication.identity.reconcile",
    ]);
    expect(calls.every((c) => c.readonly)).toBe(true);
  }
});

test("owner-approved song-reference render completion uses the same fixed publication identity", async () => {
  let record = prepared("song_reference");
  const ready = record.state;
  if (ready.decision === null || ready.master === null)
    throw new Error("Prepared song master required");
  record = {
    ...record,
    state: {
      ...ready,
      master: null,
      status: "manual_review",
      phase: null,
      reviewReasons: ["media_review_required"],
      decision: {
        ...ready.decision,
        outcome: { kind: "review", reasonCodes: ["media_review_required"] },
      },
    },
  };
  const ids: string[] = [];
  const store = notificationsVideoPublicationStoreFixture({
    getSubmissionForModerator: async () => record,
    getSubmissionByOperation: async () => record,
    moderate: async () => {
      record = {
        ...record,
        state: { ...ready, master: null, phase: "render", approvedHolds: ["safety"] },
      };
      return { kind: "none" as const };
    },
    attachSongVideoMaster: async (input) => {
      record = { ...record, state: input.nextState };
      return record;
    },
    publishSongReference: async (input) => {
      if (input.state.postId === null) throw new Error("Rendered publication identity required");
      ids.push(input.state.postId);
      record = { ...record, state: input.state };
      return record;
    },
  });
  const services = notificationsVideoPublicationServicesFixture({
    store,
    nowIso: () => record.updatedAt,
  });
  await moderateVideoSubmission(
    {
      submissionId,
      actor: { kind: "user", userId: "owner" },
      body: {
        action: "approve",
        approval_kind: "standard",
        hold: "safety",
        expected_creation_revision: 1,
        idempotency_key: "song-approval",
      },
    },
    services,
  );
  const input = { submissionId, operationId, master: ready.master };
  const result = await attachSongVideoMasterAndPublish(input, services);
  expect(ids).toEqual([await videoPublicationPostId(ready)]);
  expect(await attachSongVideoMasterAndPublish(input, services)).toEqual(result);
  expect(ids).toHaveLength(1);
});

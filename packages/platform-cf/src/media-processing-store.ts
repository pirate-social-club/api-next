import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type {
  MediaProcessingAnalysis,
  MediaProcessingAttemptLease,
  MediaProcessingAttemptResult,
  MediaProcessingAttemptStage,
  MediaProcessingAuthority,
  MediaProcessingCommit,
  MediaProcessingDecision,
  MediaProcessingOutboxRecord,
  MediaProcessingStore,
} from "@pirate/application/media/processing-contracts";
import type { TextModerationPolicySnapshotV2 } from "@pirate/application/text-moderation-runtime";
import {
  MODERATION_POLICY_CATEGORIES_V1,
  type ModerationPolicyDecisionV1,
  type ModerationPolicyTableV1,
} from "@pirate/contracts";
import { canonicalJson } from "@pirate/domain";
import { Data, Effect, type Layer, Option, Schema } from "effect";
import type {
  MediaSubmissionState,
  PublicationDecision,
  TrustedSongAnalysis,
} from "../../domain/src/media-submission.ts";
import {
  type MediaOutboxRecord,
  makeControlPlaneMediaOutboxRepository,
} from "./media-outbox-repository.ts";
import {
  MediaSubmissionRepositoryError,
  makeControlPlaneMediaSubmissionRepository,
  type ProcessingAttemptRecord,
} from "./media-submission-repository.ts";

type Row = Readonly<Record<string, unknown>>;
type AuthorityLocation = Readonly<{
  communityId: string;
  actorAccountId: string;
  actorUserId: string;
  authorPersonaId: string;
  termsRevision: number | null;
  replacementSequence: number;
  publishedLyricsRevision: number | null;
  title: string;
  authorDeclaredRating: "general" | "adult_18";
}>;

const AttemptResultEnvelope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("probe"), value: Schema.Json }),
  Schema.Struct({ kind: Schema.Literal("sample"), value: Schema.Json }),
  Schema.Struct({ kind: Schema.Literal("acr"), value: Schema.Json }),
  Schema.Struct({ kind: Schema.Literal("classifier"), value: Schema.Json }),
  Schema.Struct({ kind: Schema.Literal("metadata"), value: Schema.Json }),
  Schema.Struct({ kind: Schema.Literal("publication"), postId: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("alignment"),
    status: Schema.Literal("ready"),
    artifactRef: Schema.String,
    artifactSha256: Schema.String,
    artifact: Schema.Record(Schema.String, Schema.Json),
  }),
  Schema.Struct({
    kind: Schema.Literal("alignment"),
    status: Schema.Literal("unavailable"),
    failureCode: Schema.String,
  }),
]);

export class MediaProcessingStoreError extends Data.TaggedError("MediaProcessingStoreError")<{
  readonly operation:
    | "authority"
    | "outbox"
    | "attempt"
    | "analysis"
    | "decision"
    | "publication"
    | "alignment"
    | "failure"
    | "workflow";
  readonly reason: "invalid-row" | "invalid-result" | "stale" | "unavailable";
}> {}

export type MediaProcessingStoreOptions = Readonly<{
  readonly attemptLeaseSeconds?: number;
  readonly outboxLeaseSeconds?: number;
  readonly retryBaseMs?: number;
  readonly referenceTtlMs?: number;
  readonly workflowCandidateLimit?: number;
  readonly now?: () => number;
  readonly dataRegistrationChainId?: bigint;
}>;

const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  value === value.trim() &&
  !value.includes("\u0000");

const integer = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const policyTable = (rows: readonly Row[]): ModerationPolicyTableV1 | null => {
  if (rows.length !== MODERATION_POLICY_CATEGORIES_V1.length) return null;
  const table: Partial<
    Record<(typeof MODERATION_POLICY_CATEGORIES_V1)[number], ModerationPolicyDecisionV1>
  > = {};
  for (const row of rows) {
    const category = typeof row.category === "string" ? row.category : null;
    const decision = typeof row.decision === "string" ? row.decision : null;
    if (
      category === null ||
      !MODERATION_POLICY_CATEGORIES_V1.includes(
        category as (typeof MODERATION_POLICY_CATEGORIES_V1)[number],
      ) ||
      (decision !== "permit" && decision !== "review" && decision !== "block") ||
      category in table
    )
      return null;
    table[category as (typeof MODERATION_POLICY_CATEGORIES_V1)[number]] = decision;
  }
  return table as ModerationPolicyTableV1;
};

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const commandSnapshot = async (
  authority: MediaProcessingAuthority,
  operation: string,
  body: unknown,
) => {
  const requestBytes = new TextEncoder().encode(
    canonicalJson({ operation, operation_id: authority.operationId, body }),
  );
  const responseBytes = new TextEncoder().encode(
    canonicalJson({ operation, operation_id: authority.operationId, outcome: "committed" }),
  );
  return {
    communityId: authority.communityId,
    submissionId: authority.submissionId,
    actorUserId: authority.actorAccountId,
    personaId: authority.authorPersonaId,
    endpointTemplate: `/internal/media-processing/${operation}`,
    idempotencyKey: `media-processing-${operation}-${authority.operationId}-c${authority.creationRevision}`,
    requestHash: await sha256(requestBytes),
    responseBytes,
    responseSha256: await sha256(responseBytes),
  };
};

const outboxRecord = (record: MediaOutboxRecord): MediaProcessingOutboxRecord => ({
  outboxId: record.outboxEventId,
  eventType: record.eventType,
  submissionId: record.submissionId,
  operationId: record.operationId,
  workflowRevision: record.workflowRevision,
  workflowInstanceId: record.workflowInstanceId,
  deliveryAttempts: record.deliveryAttempts,
  state: record.state,
  claimFence: record.claimFence,
  claimOwner: record.claimOwner,
});

const processingAnalysis = (
  analysis: TrustedSongAnalysis | null,
): MediaProcessingAnalysis | null =>
  analysis === null
    ? null
    : {
        audioRevision: analysis.audioRevision,
        analysisRevision: analysis.analysisRevision,
        canonicalAudioSha256: analysis.canonicalAudioSha256,
        probeEvidenceRef: analysis.probeEvidenceRef,
        embeddedMetadata: analysis.embeddedMetadata,
        lyricsAnalysis:
          analysis.lyricsAnalysis.status === "unavailable"
            ? {
                status: "unavailable",
                lyricsRevision: analysis.lyricsAnalysis.lyricsRevision,
                evidenceRef: analysis.lyricsAnalysis.evidenceRef,
                policyRevision: analysis.lyricsAnalysis.policyRevision,
                adapterRevision: analysis.lyricsAnalysis.adapterRevision,
              }
            : analysis.lyricsAnalysis,
        acr: analysis.acr,
        lyricsSafety: analysis.lyricsSafety,
        mediaSafety: analysis.mediaSafety,
        coverModeration: analysis.coverModeration ?? {
          decision:
            analysis.embeddedMetadata.cover.status === "absent" ? "not_applicable" : "withheld",
          reason:
            analysis.embeddedMetadata.cover.status === "absent"
              ? "not_embedded"
              : "provider_unavailable",
          providerId: null,
          requestedModel: null,
          returnedModel: null,
          inputSha256:
            analysis.embeddedMetadata.cover.status === "ready"
              ? analysis.embeddedMetadata.cover.artifactSha256
              : null,
          matchedCategories: [],
          evidenceRef: analysis.embeddedMetadata.evidenceRef,
          evidence: null,
        },
        contentModeration: analysis.contentModeration ?? {
          decision: "manual_review",
          resultingContentRating: "general",
          inputSha256: "legacy-unmoderated",
          matchedCategories: [],
          policyRevision: "legacy-unmoderated",
          platformPolicyRevision: "legacy-unmoderated",
          communityPolicyRevision: "legacy-unmoderated",
          evidenceRef: null,
          providerEvidence: null,
        },
      };

const processingDecision = (
  decision: PublicationDecision | null,
): MediaProcessingDecision | null =>
  decision === null ? null : { ...decision, contentRating: decision.contentRating ?? "general" };

const decodeAttemptResult = (value: unknown): MediaProcessingAttemptResult => {
  const decoded = Schema.decodeUnknownOption(AttemptResultEnvelope, {
    onExcessProperty: "error",
  })(value);
  if (Option.isNone(decoded)) {
    throw new MediaProcessingStoreError({ operation: "attempt", reason: "invalid-result" });
  }
  return decoded.value as MediaProcessingAttemptResult;
};

const attemptInputKind = (
  stage: MediaProcessingAttemptStage,
): "audio" | "lyrics" | "publication" =>
  stage === "classifier"
    ? "lyrics"
    : stage === "publication" || stage === "alignment"
      ? "publication"
      : "audio";

export function makeMediaProcessingStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  options: MediaProcessingStoreOptions = {},
): MediaProcessingStore {
  const submissions = makeControlPlaneMediaSubmissionRepository({
    ...(options.dataRegistrationChainId === undefined
      ? {}
      : { dataRegistrationChainId: options.dataRegistrationChainId }),
  });
  const outbox = makeControlPlaneMediaOutboxRepository();
  const attemptLeaseSeconds = options.attemptLeaseSeconds ?? 300;
  const outboxLeaseSeconds = options.outboxLeaseSeconds ?? 60;
  const retryBaseMs = options.retryBaseMs ?? 15_000;
  const referenceTtlMs = options.referenceTtlMs ?? 7 * 24 * 60 * 60 * 1_000;
  const workflowCandidateLimit = options.workflowCandidateLimit ?? 100;
  const now = options.now ?? Date.now;

  const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>): Promise<A> =>
    Effect.runPromise(Effect.provide(runtime)(effect));

  const locator = (
    submissionId: string,
    operationId: string,
  ): Effect.Effect<
    AuthorityLocation | null,
    MediaProcessingStoreError | ControlPlaneError,
    ControlPlaneDb
  > =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<Row>({
        label: "media-processing.authority-locator",
        text: "SELECT s.community_id,s.actor_account_id,s.actor_user_id,s.author_persona_id,s.current_terms_revision,s.workflow_replacement_sequence,s.title,s.author_declared_rating,p.lyrics_revision AS published_lyrics_revision FROM media_post_submissions s LEFT JOIN media_publication_projections p ON p.submission_id=s.submission_id AND p.operation_id=s.operation_id WHERE s.submission_id=$1 AND s.operation_id=$2",
        values: [submissionId, operationId],
        readonly: true,
      });
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      if (
        result.rows.length !== 1 ||
        row === undefined ||
        !validId(row.community_id) ||
        !validId(row.actor_account_id) ||
        !validId(row.actor_user_id) ||
        !validId(row.author_persona_id) ||
        !validId(row.title) ||
        (row.author_declared_rating !== "general" && row.author_declared_rating !== "adult_18")
      ) {
        return yield* Effect.fail(
          new MediaProcessingStoreError({ operation: "authority", reason: "invalid-row" }),
        );
      }
      const termsRevision =
        row.current_terms_revision === null ? null : integer(row.current_terms_revision);
      const replacementSequence = integer(row.workflow_replacement_sequence);
      const publishedLyricsRevision =
        row.published_lyrics_revision === null ? null : integer(row.published_lyrics_revision);
      if (
        (row.current_terms_revision !== null && termsRevision === null) ||
        replacementSequence === null ||
        (row.published_lyrics_revision !== null && publishedLyricsRevision === null)
      ) {
        return yield* Effect.fail(
          new MediaProcessingStoreError({ operation: "authority", reason: "invalid-row" }),
        );
      }
      return {
        communityId: row.community_id,
        actorAccountId: row.actor_account_id,
        actorUserId: row.actor_user_id,
        authorPersonaId: row.author_persona_id,
        termsRevision,
        replacementSequence,
        publishedLyricsRevision,
        title: row.title,
        authorDeclaredRating: row.author_declared_rating,
      };
    });

  const loadState = async (
    submissionId: string,
    operationId: string,
  ): Promise<Readonly<{ state: MediaSubmissionState; location: AuthorityLocation }>> => {
    const location = await run(locator(submissionId, operationId));
    if (location === null) {
      throw new MediaProcessingStoreError({ operation: "authority", reason: "stale" });
    }
    const state = await run(
      submissions.getForAuthor({
        communityId: location.communityId,
        submissionId,
        actorUserId: location.actorUserId,
        personaId: location.authorPersonaId,
      }),
    );
    if (state === null) {
      throw new MediaProcessingStoreError({ operation: "authority", reason: "stale" });
    }
    return { state, location };
  };

  const loadAuthority: MediaProcessingStore["loadAuthority"] = async (
    submissionId,
    operationId,
  ) => {
    let loaded: Awaited<ReturnType<typeof loadState>>;
    try {
      loaded = await loadState(submissionId, operationId);
    } catch (error) {
      if (error instanceof MediaProcessingStoreError && error.reason === "stale") return null;
      throw error;
    }
    const { state, location } = loaded;
    if (
      state.audio === null ||
      state.audioRevision < 1 ||
      state.workflowRevision < 1 ||
      (state.status === "processing" &&
        !["analysis", "decision", "publish"].includes(state.phase ?? ""))
    ) {
      return null;
    }
    return {
      communityId: state.communityId,
      actorAccountId: location.actorAccountId,
      authorPersonaId: state.personaId,
      submissionId: state.submissionId,
      operationId: state.operationId,
      songType: state.songType,
      title: location.title,
      authorDeclaredRating: location.authorDeclaredRating,
      creationRevision: state.creationRevision,
      audioRevision: state.audioRevision,
      analysisRevision:
        state.analysis === null ? state.analysisRevision + 1 : state.analysisRevision,
      decisionRevision: state.decisionRevision,
      workflowRevision: state.workflowRevision,
      retryCount: state.retryCount,
      status: state.status,
      phase:
        state.phase === "analysis" || state.phase === "decision" || state.phase === "publish"
          ? state.phase
          : null,
      audio: state.audio,
      termsRevision: location.termsRevision,
      lyrics:
        state.lyrics === null
          ? null
          : {
              lyricsRevision: state.lyrics.lyricsRevision,
              audioRevision: state.lyrics.audioRevision,
              canonicalAudioSha256: state.lyrics.canonicalAudioSha256,
              text: state.lyrics.text,
            },
      analysis: processingAnalysis(state.analysis),
      decision: processingDecision(state.decision),
      boundReferenceAssetId: state.boundReference?.assetId ?? null,
      postId: state.postId,
      publishedLyricsRevision: location.publishedLyricsRevision,
    };
  };

  const getOutbox: MediaProcessingStore["getOutbox"] = async (outboxId) => {
    const record = await run(outbox.get(outboxId));
    return record === null ? null : outboxRecord(record);
  };

  const claimOutbox: MediaProcessingStore["claimOutbox"] = async (outboxId, workerId) => {
    const current = await run(outbox.get(outboxId));
    if (current === null) return null;
    const claimed = await run(
      outbox.claim({
        outboxEventId: outboxId,
        workflowRevision: current.workflowRevision,
        workerId,
        leaseSeconds: outboxLeaseSeconds,
      }),
    );
    return claimed === null ? null : outboxRecord(claimed);
  };

  const completeOutbox: MediaProcessingStore["completeOutbox"] = (record) =>
    run(
      outbox.markDelivered({
        outboxEventId: record.outboxId,
        workflowRevision: record.workflowRevision,
        workflowInstanceId: record.workflowInstanceId,
        workerId: record.claimOwner ?? "",
        claimFence: record.claimFence,
      }),
    );

  const failOutbox: MediaProcessingStore["failOutbox"] = (record, failure) =>
    run(
      outbox.markFailed({
        outboxEventId: record.outboxId,
        workflowRevision: record.workflowRevision,
        workflowInstanceId: record.workflowInstanceId,
        workerId: record.claimOwner ?? "",
        claimFence: record.claimFence,
        failureCode: failure,
        nextEligibleAt: new Date(now() + retryBaseMs * 2 ** record.deliveryAttempts).toISOString(),
      }),
    );

  const attemptsFor = (input: Parameters<MediaProcessingStore["startAttempt"]>[0]) =>
    run(
      submissions.listProcessingAttempts({
        submissionId: input.authority.submissionId,
        operationId: input.authority.operationId,
        audioRevision: input.authority.audioRevision,
        analysisRevision: input.authority.analysisRevision,
        stage: input.stage,
        inputRevision: input.inputRevision,
        inputHash: input.inputHash,
        policyRevision: input.policyRevision,
        adapterRevision: input.adapterRevision,
      }),
    );

  const leaseFrom = (
    record: ProcessingAttemptRecord,
    workerId: string,
  ): MediaProcessingAttemptLease => ({
    attemptId: record.attemptId,
    attemptNumber: record.attemptNumber,
    stage: record.stage,
    claimOwner: workerId,
    claimFence: record.claimFence,
    ...(record.result === null ? {} : { priorResult: decodeAttemptResult(record.result) }),
  });

  const claimAttempt = async (
    input: Parameters<MediaProcessingStore["startAttempt"]>[0],
    record: ProcessingAttemptRecord,
  ) => {
    const claimed = await run(
      submissions.claimProcessingAttempt({
        attemptId: record.attemptId,
        workerId: input.workerId,
        leaseSeconds: attemptLeaseSeconds,
      }),
    );
    if (!claimed) return { kind: "busy" } as const;
    const refreshed = (await attemptsFor(input)).find(
      (candidate) => candidate.attemptId === record.attemptId,
    );
    if (
      refreshed === undefined ||
      refreshed.state !== "running" ||
      refreshed.claimOwner !== input.workerId
    ) {
      return { kind: "busy" } as const;
    }
    return { kind: "run", lease: leaseFrom(refreshed, input.workerId) } as const;
  };

  const startAttempt: MediaProcessingStore["startAttempt"] = async (input) => {
    const attempts = await attemptsFor(input);
    const latest = attempts.at(-1);
    if (latest?.state === "succeeded") {
      if (latest.result === null) {
        throw new MediaProcessingStoreError({ operation: "attempt", reason: "invalid-row" });
      }
      return { kind: "replay", result: decodeAttemptResult(latest.result) };
    }
    if (latest?.state === "exhausted") return { kind: "exhausted" };
    if (latest?.state === "failed") {
      if (latest.nextEligibleAt === null || Date.parse(latest.nextEligibleAt) > now()) {
        return { kind: "busy" };
      }
    } else if (latest !== undefined) {
      return claimAttempt(input, latest);
    }

    const attemptNumber = (latest?.attemptNumber ?? 0) + 1;
    if (attemptNumber > 3) return { kind: "exhausted" };
    const attemptId = `${input.attemptId}-n${attemptNumber}`;
    await run(
      submissions.recordProcessingAttempt({
        attemptId,
        communityId: input.authority.communityId,
        submissionId: input.authority.submissionId,
        actorUserId: input.authority.actorAccountId,
        personaId: input.authority.authorPersonaId,
        operationId: input.authority.operationId,
        audioRevision: input.authority.audioRevision,
        analysisRevision: input.authority.analysisRevision,
        stage: input.stage,
        inputKind: attemptInputKind(input.stage),
        inputRevision: input.inputRevision,
        policyRevision: input.policyRevision,
        adapterRevision: input.adapterRevision,
        inputHash: input.inputHash,
        providerIdempotencyKey: `media-provider-${attemptId}`,
        attemptNumber,
      }),
    );
    const created = (await attemptsFor(input)).find(
      (candidate) => candidate.attemptId === attemptId,
    );
    if (created === undefined) {
      throw new MediaProcessingStoreError({ operation: "attempt", reason: "invalid-row" });
    }
    return claimAttempt(input, created);
  };

  const resultEvidence = async (lease: MediaProcessingAttemptLease, result: unknown) =>
    `media-attempt-evidence-${lease.attemptId}-${(await sha256(new TextEncoder().encode(canonicalJson(result)))).slice(0, 24)}`;

  const completeAttempt: MediaProcessingStore["completeAttempt"] = async (lease, result) =>
    run(
      submissions.completeProcessingAttempt({
        attemptId: lease.attemptId,
        workerId: lease.claimOwner,
        claimFence: lease.claimFence,
        evidenceRef: await resultEvidence(lease, result),
        result: result as Readonly<Record<string, unknown>>,
      }),
    );

  const deferAttempt: MediaProcessingStore["deferAttempt"] = async (lease, result, retryAfterMs) =>
    run(
      submissions.deferProcessingAttempt({
        attemptId: lease.attemptId,
        workerId: lease.claimOwner,
        claimFence: lease.claimFence,
        evidenceRef: await resultEvidence(lease, result),
        result: result as Readonly<Record<string, unknown>>,
        retryAfterMs,
      }),
    );

  const failAttempt: MediaProcessingStore["failAttempt"] = (lease, failure, retryable) =>
    run(
      submissions.failProcessingAttempt({
        attemptId: lease.attemptId,
        workerId: lease.claimOwner,
        claimFence: lease.claimFence,
        failureCode: failure,
        retryable,
        ...(retryable
          ? {
              nextEligibleAt: new Date(
                now() + retryBaseMs * 2 ** (lease.attemptNumber - 1),
              ).toISOString(),
            }
          : {}),
      }),
    );

  const committed = async <A extends { readonly kind: string }>(
    effect: Effect.Effect<A, unknown, ControlPlaneDb>,
  ): Promise<MediaProcessingCommit> => {
    try {
      const result = await run(effect);
      if (result.kind === "committed") return "committed";
      if (result.kind === "replay") return "replay";
      return "stale";
    } catch (error) {
      if (error instanceof MediaSubmissionRepositoryError && error.reason === "stale-revision") {
        return "stale";
      }
      throw error;
    }
  };

  const commitAnalysis: MediaProcessingStore["commitAnalysis"] = async (authority, analysis) => {
    const { state } = await loadState(authority.submissionId, authority.operationId);
    if (state.analysis?.analysisRevision === analysis.analysisRevision) return "replay";
    const snapshot = await commandSnapshot(authority, "analysis", analysis);
    const trusted: TrustedSongAnalysis = {
      version: "song-trusted-analysis-v1",
      operationId: authority.operationId,
      analysisRevision: analysis.analysisRevision,
      audioRevision: analysis.audioRevision,
      canonicalAudioSha256: analysis.canonicalAudioSha256,
      finalizedAudioRef: authority.audio?.immutableRef ?? "",
      probeEvidenceRef: analysis.probeEvidenceRef,
      embeddedMetadata: analysis.embeddedMetadata,
      lyricsAnalysis:
        analysis.lyricsAnalysis.status === "unavailable"
          ? { ...analysis.lyricsAnalysis, explicitness: "uncertain" }
          : analysis.lyricsAnalysis,
      acr: analysis.acr,
      lyricsSafety: analysis.lyricsSafety,
      mediaSafety: analysis.mediaSafety,
      coverModeration: analysis.coverModeration,
      contentModeration: analysis.contentModeration,
      boundReference: state.boundReference,
    };
    return committed(
      submissions.acceptAnalysis({
        ...snapshot,
        expectedAudioRevision: authority.audioRevision,
        expectedCanonicalAudioSha256: analysis.canonicalAudioSha256,
        analysis: trusted,
      }),
    );
  };

  const commitDecision: MediaProcessingStore["commitDecision"] = async (authority, decision) => {
    const snapshot = await commandSnapshot(authority, "decision", decision);
    if (decision.outcome === "reference_required") {
      return committed(
        submissions.requireReference({
          ...snapshot,
          expectedCreationRevision: authority.creationRevision,
          expectedAudioRevision: authority.audioRevision,
          expectedAnalysisRevision: authority.analysisRevision,
          referenceRequestRef: `media-reference-request-${authority.operationId}-c${authority.creationRevision}`,
          actionExpiresAt: new Date(now() + referenceTtlMs).toISOString(),
        }),
      );
    }
    return committed(
      submissions.recordDecision({
        ...snapshot,
        expectedCreationRevision: authority.creationRevision,
        expectedAudioRevision: authority.audioRevision,
        expectedAnalysisRevision: authority.analysisRevision,
        decision: decision as PublicationDecision,
      }),
    );
  };

  const commitPublication: MediaProcessingStore["commitPublication"] = async (authority) => {
    const snapshot = await commandSnapshot(authority, "publication", {
      decision_revision: authority.decisionRevision,
      lyrics_revision: authority.lyrics?.lyricsRevision ?? null,
    });
    const postId = `media-post-${authority.operationId}`;
    const nextWorkflowRevision = authority.workflowRevision + 1;
    const alignmentOutbox =
      authority.lyrics === null
        ? undefined
        : {
            outboxEventId: `media-alignment-outbox-${authority.operationId}-r${nextWorkflowRevision}`,
            effectIdentity: `media-alignment-${authority.operationId}-r${nextWorkflowRevision}`,
            payload: {
              kind: "alignment" as const,
              submission_id: authority.submissionId,
              operation_id: authority.operationId,
              post_id: postId,
              lyrics_revision: authority.lyrics.lyricsRevision,
              workflow_revision: nextWorkflowRevision,
              workflow_instance_id: `media-${authority.operationId}-r${nextWorkflowRevision}`,
            },
          };
    return committed(
      submissions.publish({
        ...snapshot,
        expectedCreationRevision: authority.creationRevision,
        expectedAudioRevision: authority.audioRevision,
        expectedAnalysisRevision: authority.analysisRevision,
        expectedDecisionRevision: authority.decisionRevision,
        postId,
        ...(alignmentOutbox === undefined ? {} : { outbox: alignmentOutbox }),
      }),
    );
  };

  const commitAlignment: MediaProcessingStore["commitAlignment"] = async (authority, result) => {
    if (authority.postId === null || authority.audio === null) return "stale";
    const current = await run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.execute<Row>({
          label: "media-processing.alignment-current",
          text: "SELECT status,current_artifact_ref,failure_code FROM media_alignment_projections WHERE submission_id=$1 AND operation_id=$2 AND post_id=$3 AND audio_revision=$4 AND analysis_revision=$5 AND lyrics_revision IS NOT DISTINCT FROM $6",
          values: [
            authority.submissionId,
            authority.operationId,
            authority.postId,
            authority.audioRevision,
            authority.analysisRevision,
            authority.publishedLyricsRevision,
          ],
          readonly: true,
        });
      }),
    );
    if (current.rows.length !== 1) return "stale";
    const row = current.rows[0];
    if (
      row?.status === result.status &&
      (result.status === "ready"
        ? row.current_artifact_ref === result.artifactRef
        : row.failure_code === result.failureCode)
    ) {
      return "replay";
    }
    if (row?.status !== "pending") return "stale";
    try {
      await run(
        submissions.recordAlignment({
          communityId: authority.communityId,
          submissionId: authority.submissionId,
          actorUserId: authority.actorAccountId,
          personaId: authority.authorPersonaId,
          postId: authority.postId,
          audioRevision: authority.audioRevision,
          analysisRevision: authority.analysisRevision,
          lyricsRevision: authority.publishedLyricsRevision,
          canonicalAudioSha256: authority.audio.canonicalSha256,
          outcome: result.status,
          ...(result.status === "ready"
            ? {
                artifact: {
                  artifactRef: result.artifactRef,
                  artifactSha256: result.artifactSha256,
                  artifact: result.artifact,
                },
              }
            : { failureCode: result.failureCode }),
        }),
      );
      return "committed";
    } catch (error) {
      if (error instanceof MediaSubmissionRepositoryError && error.reason === "stale-revision") {
        return "stale";
      }
      throw error;
    }
  };

  const commitProcessingFailure: MediaProcessingStore["commitProcessingFailure"] = async (
    authority,
    reason,
  ) => {
    const snapshot = await commandSnapshot(authority, "failure", { reason });
    return committed(
      submissions.recordMediaFailure({
        ...snapshot,
        expectedCreationRevision: authority.creationRevision,
        failure: {
          code: reason,
          retryable: reason !== "invalid_media",
          retryCount: Math.min(3, authority.retryCount) as 0 | 1 | 2 | 3,
          lastSafePhase: authority.phase ?? "analysis",
          evidenceRef: `media-processing-failure-${authority.operationId}-${reason}`,
        },
      }),
    );
  };

  const commitProviderUnavailableReview: MediaProcessingStore["commitProviderUnavailableReview"] =
    async (authority, reason) => {
      const snapshot = await commandSnapshot(authority, "provider-review", { reason });
      return committed(
        submissions.requireReview({
          ...snapshot,
          expectedCreationRevision: authority.creationRevision,
          review: {
            reviewRef: `media-provider-review-${authority.operationId}-${reason}`,
            heldRevision: authority.creationRevision,
            reasonCode: "moderation_unavailable",
          },
        }),
      );
    };

  const replaceMissingWorkflow: MediaProcessingStore["replaceMissingWorkflow"] = async (
    authority,
  ) => {
    const location = await run(locator(authority.submissionId, authority.operationId));
    if (location === null) return "stale";
    const nextRevision = authority.workflowRevision + 1;
    const nextSequence = location.replacementSequence + 1;
    const snapshot = await commandSnapshot(authority, "workflow-replacement", {
      workflow_revision: nextRevision,
      replacement_sequence: nextSequence,
    });
    return committed(
      submissions.replaceLostWorkflow({
        ...snapshot,
        expectedWorkflowRevision: authority.workflowRevision,
        outbox: {
          outboxEventId: `media-workflow-replacement-outbox-${authority.operationId}-r${nextRevision}`,
          effectIdentity: `media-workflow-replacement-${authority.operationId}-r${nextRevision}`,
          payload: {
            kind: "workflow_replacement",
            submission_id: authority.submissionId,
            operation_id: authority.operationId,
            replacement_sequence: nextSequence,
            workflow_revision: nextRevision,
            workflow_instance_id: `media-${authority.operationId}-r${nextRevision}`,
          },
        },
      }),
    );
  };

  const listWorkflowCandidates: MediaProcessingStore["listWorkflowCandidates"] = async () => {
    if (
      !Number.isSafeInteger(workflowCandidateLimit) ||
      workflowCandidateLimit < 1 ||
      workflowCandidateLimit > 100
    ) {
      throw new MediaProcessingStoreError({ operation: "workflow", reason: "unavailable" });
    }
    const identities = await run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.execute<Row>({
          label: "media-processing.workflow-candidates",
          text: "SELECT submission_id,operation_id FROM media_post_submissions WHERE workflow_revision>0 AND status IN ('processing','action_required','manual_review') ORDER BY updated_at,submission_id LIMIT $1",
          values: [workflowCandidateLimit],
          readonly: true,
        });
      }),
    );
    const candidates: MediaProcessingAuthority[] = [];
    for (const row of identities.rows) {
      if (!validId(row.submission_id) || !validId(row.operation_id)) {
        throw new MediaProcessingStoreError({ operation: "workflow", reason: "invalid-row" });
      }
      const authority = await loadAuthority(row.submission_id, row.operation_id);
      if (authority !== null) candidates.push(authority);
    }
    return candidates;
  };

  const readModerationPolicy: MediaProcessingStore["readModerationPolicy"] = async (communityId) =>
    run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const provider = yield* db.execute<Row>({
          label: "media-processing.moderation-policy.provider",
          text: "SELECT pointer.policy_revision_id,revision.policy_hash FROM text_moderation_policy_current pointer JOIN text_moderation_policy_revisions revision ON revision.policy_revision_id=pointer.policy_revision_id WHERE pointer.singleton=TRUE",
          values: [],
          readonly: true,
        });
        const floor = yield* db.execute<Row>({
          label: "media-processing.moderation-policy.floor",
          text: "SELECT pointer.policy_revision_id,pointer.policy_hash,category.category,category.decision FROM moderation_platform_floor_current pointer JOIN moderation_platform_floor_category_decisions category ON category.policy_revision_id=pointer.policy_revision_id WHERE pointer.singleton=TRUE ORDER BY moderation_policy_category_ordinal_v1(category.category)",
          values: [],
          readonly: true,
        });
        const community = yield* db.execute<Row>({
          label: "media-processing.moderation-policy.community",
          text: "SELECT pointer.policy_revision_id,pointer.policy_hash,category.category,category.decision FROM community_moderation_policy_current pointer JOIN community_moderation_policy_category_decisions category ON category.community_id=pointer.community_id AND category.policy_revision_id=pointer.policy_revision_id WHERE pointer.community_id=$1 ORDER BY moderation_policy_category_ordinal_v1(category.category)",
          values: [communityId],
          readonly: true,
        });
        const providerRow = provider.rows[0];
        const floorRow = floor.rows[0];
        const communityRow = community.rows[0];
        const platformPolicy = policyTable(floor.rows);
        const communityPolicy = policyTable(community.rows);
        if (
          provider.rows.length !== 1 ||
          providerRow === undefined ||
          !validId(providerRow.policy_revision_id) ||
          typeof providerRow.policy_hash !== "string" ||
          floorRow === undefined ||
          !validId(floorRow.policy_revision_id) ||
          typeof floorRow.policy_hash !== "string" ||
          communityRow === undefined ||
          !validId(communityRow.policy_revision_id) ||
          typeof communityRow.policy_hash !== "string" ||
          platformPolicy === null ||
          communityPolicy === null
        )
          throw new MediaProcessingStoreError({ operation: "authority", reason: "invalid-row" });
        return {
          policy_revision: providerRow.policy_revision_id,
          policy_hash: providerRow.policy_hash,
          platform_policy_revision: floorRow.policy_revision_id,
          platform_policy_hash: floorRow.policy_hash,
          platform_policy: platformPolicy,
          community_policy_revision: communityRow.policy_revision_id,
          community_policy_hash: communityRow.policy_hash,
          community_policy: communityPolicy,
        } satisfies TextModerationPolicySnapshotV2;
      }),
    );

  return {
    getOutbox,
    claimOutbox,
    completeOutbox,
    failOutbox,
    loadAuthority,
    startAttempt,
    completeAttempt,
    deferAttempt,
    failAttempt,
    commitAnalysis,
    commitDecision,
    commitPublication,
    commitAlignment,
    commitProcessingFailure,
    commitProviderUnavailableReview,
    replaceMissingWorkflow,
    listWorkflowCandidates,
    readModerationPolicy,
  };
}

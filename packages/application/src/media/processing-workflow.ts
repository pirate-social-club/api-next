import { canonicalTextModerationInput, resolveCommunityModerationPolicy } from "@pirate/domain";
import { Cause, Effect } from "effect";
import {
  MEDIA_TRANSFORM_MAX_AUDIO_DURATION_MS,
  type MediaTransformAttempt,
  type MediaTransformAudioSampleOutcome,
  type MediaTransformProbeOutcome,
  type MediaTransformSampleArtifact,
} from "../media/transform.ts";
import type { MediaIdentificationOutcome } from "../media-identification-provider.ts";
import {
  isMediaClassifierResultBoundToInputs,
  type MediaAcceptedLyrics,
  type MediaExplicitnessClassifierInput,
} from "../media-provider-contracts.ts";
import {
  decodeMediaProcessingWorkflowPayload,
  type MediaProcessingAnalysis,
  type MediaProcessingAttemptLease,
  type MediaProcessingAttemptResult,
  type MediaProcessingAttemptStage,
  type MediaProcessingAuthority,
  type MediaProcessingDecision,
  type MediaProcessingEventType,
  type MediaProcessingObservation,
  type MediaProcessingObserver,
  type MediaProcessingProviders,
  type MediaProcessingStore,
} from "./processing-contracts.ts";

export type MediaProcessingWorkflowResult =
  | Readonly<{ readonly outcome: "waiting_for_terms" }>
  | Readonly<{
      readonly outcome: "waiting_for_provider";
      readonly reason?: "acr_transport" | "acr_provider" | "acr_throttled" | "acr_preflight";
    }>
  | Readonly<{
      readonly outcome:
        | "published"
        | "published_without_alignment"
        | "manual_review"
        | "blocked"
        | "action_required"
        | "processing_failed"
        | "alignment_recorded"
        | "inert";
    }>;

type MediaProcessingWorkflowOptions = Readonly<{
  readonly enabled: boolean;
  readonly workerId: string;
  readonly now: () => number;
  readonly policyRevision: string;
  readonly transformAdapterRevision: string;
  readonly metadataAdapterRevision: string;
  readonly classifierTimeoutMs: number;
  readonly transformRuntimeMs: number;
  readonly maximumSampleBytes: number;
  readonly observe?: MediaProcessingObserver;
}>;

export type MediaProcessingWorkflowDependencies = Readonly<{
  readonly store: MediaProcessingStore;
  readonly providers: MediaProcessingProviders | null;
  readonly options: MediaProcessingWorkflowOptions;
}>;

class DeferredAttempt extends Error {
  constructor(
    readonly reason:
      | "busy"
      | "exhausted"
      | "provider_progress"
      | "stale_fence"
      | "acr_transport"
      | "acr_provider"
      | "acr_throttled"
      | "acr_preflight",
  ) {
    super(reason);
    this.name = "DeferredAttempt";
  }
}

class CoverReadFailure extends Error {}

const TRANSFORM_POLL_DELAY_MS = 10_000;

type WorkflowEffect<A> = Effect.Effect<A, unknown>;
type ClassifierResult = Extract<
  MediaProcessingAttemptResult,
  { readonly kind: "classifier" }
>["value"];
type MetadataResult = Extract<MediaProcessingAttemptResult, { readonly kind: "metadata" }>["value"];

const promiseEffect = <A>(run: () => Promise<A>): WorkflowEffect<A> =>
  Effect.tryPromise({ try: run, catch: (error) => error });

const storeWrite = <A>(run: () => Promise<A>): WorkflowEffect<A> =>
  Effect.yieldNow.pipe(Effect.andThen(Effect.uninterruptible(promiseEffect(run))));

const abortablePromise = <A>(run: (signal: AbortSignal) => Promise<A>): WorkflowEffect<A> =>
  Effect.acquireUseRelease(
    Effect.sync(() => new AbortController()),
    (controller) => promiseEffect(() => run(controller.signal)),
    (controller) => Effect.sync(() => controller.abort()),
  );

const deferredAttemptFromCause = (cause: Cause.Cause<unknown>): DeferredAttempt | undefined => {
  const error = Cause.findErrorOption(cause);
  return error._tag === "Some" && error.value instanceof DeferredAttempt ? error.value : undefined;
};

const catchStageFailure = <A>(
  effect: WorkflowEffect<A>,
  authority: MediaProcessingAuthority,
  lease: MediaProcessingAttemptLease,
  dependencies: MediaProcessingWorkflowDependencies,
  mapFailure?: () => unknown,
): WorkflowEffect<A> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause) || deferredAttemptFromCause(cause) !== undefined) {
        return Effect.failCause(cause);
      }
      return failAttempt(authority, lease, dependencies).pipe(
        Effect.andThen(() =>
          mapFailure === undefined ? Effect.failCause(cause) : Effect.fail(mapFailure()),
        ),
      );
    }),
  );

const attemptId = (
  authority: MediaProcessingAuthority,
  stage: MediaProcessingAttemptStage,
): string => {
  const lyricsBinding =
    (stage === "classifier" || stage === "alignment") && authority.lyrics !== null
      ? `-l${authority.lyrics.lyricsRevision}`
      : "";
  return `media-attempt-${authority.operationId}-a${authority.audioRevision}-n${authority.analysisRevision}-${stage}${lyricsBinding}`;
};

const observation = (
  authority: MediaProcessingAuthority,
  event: MediaProcessingObservation["event"],
  stage?: MediaProcessingAttemptStage,
): MediaProcessingObservation => ({
  event,
  operationId: authority.operationId,
  submissionId: authority.submissionId,
  workflowRevision: authority.workflowRevision,
  ...(stage === undefined ? {} : { stage }),
});

function startAttempt(
  authority: MediaProcessingAuthority,
  stage: MediaProcessingAttemptStage,
  inputRevision: number,
  adapterRevision: string,
  dependencies: MediaProcessingWorkflowDependencies,
): WorkflowEffect<
  | Readonly<{ readonly kind: "run"; readonly lease: MediaProcessingAttemptLease }>
  | Readonly<{ readonly kind: "replay"; readonly result: MediaProcessingAttemptResult }>
> {
  return Effect.gen(function* () {
    if (authority.audio === null)
      return yield* Effect.die(new TypeError("attempt requires authoritative audio"));
    const audio = authority.audio;
    const started = yield* storeWrite(() =>
      dependencies.store.startAttempt({
        authority,
        stage,
        attemptId: attemptId(authority, stage),
        workerId: dependencies.options.workerId,
        inputRevision,
        inputHash: audio.canonicalSha256,
        policyRevision: dependencies.options.policyRevision,
        adapterRevision,
      }),
    );
    if (started.kind === "run") {
      dependencies.options.observe?.(observation(authority, "attempt_started", stage));
      return started;
    }
    if (started.kind === "replay") {
      dependencies.options.observe?.(observation(authority, "attempt_replayed", stage));
      return started;
    }
    return yield* Effect.fail(new DeferredAttempt(started.kind));
  });
}

function completeAttempt(
  authority: MediaProcessingAuthority,
  lease: MediaProcessingAttemptLease,
  result: MediaProcessingAttemptResult,
  dependencies: MediaProcessingWorkflowDependencies,
): WorkflowEffect<void> {
  return Effect.gen(function* () {
    if (!(yield* storeWrite(() => dependencies.store.completeAttempt(lease, result)))) {
      return yield* Effect.fail(new DeferredAttempt("stale_fence"));
    }
    dependencies.options.observe?.(observation(authority, "attempt_completed", lease.stage));
  });
}

function deferAttempt(
  authority: MediaProcessingAuthority,
  lease: MediaProcessingAttemptLease,
  result: MediaProcessingAttemptResult,
  retryAfterMs: number,
  dependencies: MediaProcessingWorkflowDependencies,
): WorkflowEffect<never> {
  return Effect.gen(function* () {
    if (!(yield* storeWrite(() => dependencies.store.deferAttempt(lease, result, retryAfterMs)))) {
      return yield* Effect.fail(new DeferredAttempt("stale_fence"));
    }
    dependencies.options.observe?.(observation(authority, "attempt_completed", lease.stage));
    return yield* Effect.fail(new DeferredAttempt("provider_progress"));
  });
}

function failAttempt(
  authority: MediaProcessingAuthority,
  lease: MediaProcessingAttemptLease,
  dependencies: MediaProcessingWorkflowDependencies,
): WorkflowEffect<void> {
  return Effect.gen(function* () {
    if (
      !(yield* storeWrite(() =>
        dependencies.store.failAttempt(lease, "provider_unavailable", true),
      ))
    ) {
      return yield* Effect.fail(new DeferredAttempt("stale_fence"));
    }
    dependencies.options.observe?.(observation(authority, "attempt_failed", lease.stage));
  });
}

function authoritativeReload(
  authority: Pick<MediaProcessingAuthority, "submissionId" | "operationId">,
  dependencies: MediaProcessingWorkflowDependencies,
): WorkflowEffect<MediaProcessingAuthority> {
  return Effect.gen(function* () {
    const current = yield* promiseEffect(() =>
      dependencies.store.loadAuthority(authority.submissionId, authority.operationId),
    );
    if (current === null)
      return yield* Effect.die(new TypeError("authoritative media operation is missing"));
    return current;
  });
}

function requireAttemptKind<K extends MediaProcessingAttemptResult["kind"]>(
  result: MediaProcessingAttemptResult,
  kind: K,
): Extract<MediaProcessingAttemptResult, { readonly kind: K }> {
  if (result.kind !== kind) throw new TypeError(`attempt replay kind mismatch: ${kind}`);
  return result as Extract<MediaProcessingAttemptResult, { readonly kind: K }>;
}

function runProbe(
  authority: MediaProcessingAuthority,
  providers: MediaProcessingProviders,
  dependencies: MediaProcessingWorkflowDependencies,
): WorkflowEffect<MediaTransformProbeOutcome> {
  return Effect.gen(function* () {
    if (authority.audio === null)
      return yield* Effect.die(new TypeError("probe requires authoritative audio"));
    const audio = authority.audio;
    const started = yield* startAttempt(
      authority,
      "probe",
      authority.audioRevision,
      dependencies.options.transformAdapterRevision,
      dependencies,
    );
    if (started.kind === "replay") return requireAttemptKind(started.result, "probe").value;
    const prior = started.lease.priorResult;
    const submittedAtMs = dependencies.options.now();
    const attempt: MediaTransformAttempt =
      prior === undefined
        ? {
            version: "media-transform-attempt-v1",
            runtimeFence: {
              submittedAtMs,
              runtimeDeadlineMs: submittedAtMs + dependencies.options.transformRuntimeMs,
            },
          }
        : requireAttemptKind(prior, "probe").value.attempt;
    return yield* catchStageFailure(
      Effect.gen(function* () {
        const value = yield* Effect.suspend(() =>
          providers.transform.probe({
            version: "media-transform-probe-input-v1",
            binding: {
              operationId: authority.operationId,
              audioRevision: authority.audioRevision,
              analysisRevision: authority.analysisRevision,
              canonicalAudioSha256: audio.canonicalSha256,
              requestId: started.lease.attemptId,
            },
            source: { objectKey: audio.immutableRef },
            attempt,
          }),
        );
        if (value.status === "submitted" || value.status === "processing") {
          return yield* deferAttempt(
            authority,
            started.lease,
            { kind: "probe", value },
            TRANSFORM_POLL_DELAY_MS,
            dependencies,
          );
        }
        if (value.status === "retryable_failure") {
          yield* failAttempt(authority, started.lease, dependencies);
          return yield* Effect.fail(new DeferredAttempt("provider_progress"));
        }
        yield* completeAttempt(authority, started.lease, { kind: "probe", value }, dependencies);
        return value;
      }),
      authority,
      started.lease,
      dependencies,
    );
  });
}

function runSample(
  authority: MediaProcessingAuthority,
  providers: MediaProcessingProviders,
  durationMs: number,
  variant: "primary" | "alternate",
  dependencies: MediaProcessingWorkflowDependencies,
): WorkflowEffect<MediaTransformAudioSampleOutcome> {
  return Effect.gen(function* () {
    if (authority.audio === null)
      return yield* Effect.die(new TypeError("sample requires authoritative audio"));
    const audio = authority.audio;
    const stage = variant === "primary" ? "sample_primary" : "sample_alternate";
    const started = yield* startAttempt(
      authority,
      stage,
      authority.audioRevision,
      dependencies.options.transformAdapterRevision,
      dependencies,
    );
    if (started.kind === "replay") return requireAttemptKind(started.result, "sample").value;
    const prior = started.lease.priorResult;
    const submittedAtMs = dependencies.options.now();
    const attempt: MediaTransformAttempt =
      prior === undefined
        ? {
            version: "media-transform-attempt-v1",
            runtimeFence: {
              submittedAtMs,
              runtimeDeadlineMs: submittedAtMs + dependencies.options.transformRuntimeMs,
            },
          }
        : requireAttemptKind(prior, "sample").value.attempt;
    return yield* catchStageFailure(
      Effect.gen(function* () {
        const value = yield* Effect.suspend(() =>
          providers.transform.extractAudioSample({
            version: "media-transform-audio-sample-input-v1",
            binding: {
              operationId: authority.operationId,
              audioRevision: authority.audioRevision,
              analysisRevision: authority.analysisRevision,
              canonicalAudioSha256: audio.canonicalSha256,
              requestId: started.lease.attemptId,
            },
            source: { objectKey: audio.immutableRef },
            sourceDurationMs: durationMs,
            variant,
            attempt,
          }),
        );
        if (value.status === "submitted" || value.status === "processing") {
          return yield* deferAttempt(
            authority,
            started.lease,
            { kind: "sample", value },
            TRANSFORM_POLL_DELAY_MS,
            dependencies,
          );
        }
        if (value.status === "retryable_failure") {
          yield* failAttempt(authority, started.lease, dependencies);
          return yield* Effect.fail(new DeferredAttempt("provider_progress"));
        }
        yield* completeAttempt(authority, started.lease, { kind: "sample", value }, dependencies);
        return value;
      }),
      authority,
      started.lease,
      dependencies,
    );
  });
}

function runAcr(
  authority: MediaProcessingAuthority,
  providers: MediaProcessingProviders,
  artifact: MediaTransformSampleArtifact,
  variant: "primary" | "alternate",
  dependencies: MediaProcessingWorkflowDependencies,
): WorkflowEffect<MediaIdentificationOutcome> {
  return Effect.gen(function* () {
    if (authority.audio === null) {
      return yield* Effect.die(new TypeError("identification requires authoritative audio"));
    }
    const audio = authority.audio;
    const stage = variant === "primary" ? "acr_primary" : "acr_alternate";
    const started = yield* startAttempt(
      authority,
      stage,
      authority.audioRevision,
      "identification-port-v1",
      dependencies,
    );
    if (started.kind === "replay") return requireAttemptKind(started.result, "acr").value;
    return yield* catchStageFailure(
      Effect.acquireUseRelease(
        Effect.sync(() => new AbortController()),
        (abort) =>
          Effect.gen(function* () {
            const bytes = yield* promiseEffect(() =>
              providers.artifactReader.readAudioSample(
                artifact,
                dependencies.options.maximumSampleBytes,
                abort.signal,
              ),
            );
            const value = yield* Effect.suspend(() =>
              providers.identification.identify({
                version: "media-identification-request-v1",
                operationId: authority.operationId,
                audioRevision: authority.audioRevision,
                analysisRevision: authority.analysisRevision,
                canonicalAudioSha256: audio.canonicalSha256,
                requestId: started.lease.attemptId,
                signal: abort.signal,
                sample: {
                  bytes,
                  filename: `${variant}.${artifact.contentType === "audio/mpeg" ? "mp3" : "wav"}`,
                  contentType: artifact.contentType,
                },
              }),
            );
            if (value.outcome === "retryable_failure") {
              yield* failAttempt(authority, started.lease, dependencies);
              return yield* Effect.fail(
                new DeferredAttempt(
                  value.reason === "transport"
                    ? "acr_transport"
                    : value.reason === "throttled"
                      ? "acr_throttled"
                      : "acr_provider",
                ),
              );
            }
            yield* completeAttempt(authority, started.lease, { kind: "acr", value }, dependencies);
            return value;
          }),
        (abort) => Effect.sync(() => abort.abort()),
      ),
      authority,
      started.lease,
      dependencies,
      () => new DeferredAttempt("acr_preflight"),
    );
  });
}

function runClassifier(
  authority: MediaProcessingAuthority,
  providers: MediaProcessingProviders,
  dependencies: MediaProcessingWorkflowDependencies,
): WorkflowEffect<ClassifierResult> {
  return Effect.gen(function* () {
    if (authority.audio === null || authority.lyrics === null) {
      return yield* Effect.die(new TypeError("classifier requires current accepted lyrics"));
    }
    const audio = authority.audio;
    const lyrics = authority.lyrics;
    const started = yield* startAttempt(
      authority,
      "classifier",
      lyrics.lyricsRevision,
      "classifier-port-v1",
      dependencies,
    );
    if (started.kind === "replay") {
      return requireAttemptKind(started.result, "classifier").value;
    }
    const acceptedLyrics: MediaAcceptedLyrics = {
      version: "media-accepted-lyrics-v1",
      operation_id: authority.operationId,
      audio_revision: authority.audioRevision,
      lyrics_revision: lyrics.lyricsRevision,
      canonical_audio_sha256: audio.canonicalSha256,
      lyrics: lyrics.text,
    };
    const input: MediaExplicitnessClassifierInput = {
      version: "media-explicitness-classifier-input-v1",
      accepted_lyrics: acceptedLyrics,
      attempt: {
        version: "media-provider-attempt-v1",
        attempt_id: started.lease.attemptId,
        attempt_number: started.lease.attemptNumber,
        request_id: started.lease.attemptId,
        timeout_ms: dependencies.options.classifierTimeoutMs,
      },
    };
    return yield* catchStageFailure(
      Effect.acquireUseRelease(
        Effect.sync(() => new AbortController()),
        (abort) =>
          Effect.gen(function* () {
            const value = yield* Effect.suspend(() =>
              providers.classifier.classify(input, { signal: abort.signal }),
            );
            if (!isMediaClassifierResultBoundToInputs(input, value)) {
              return yield* Effect.die(
                new TypeError("classifier result crossed accepted lyrics lineage"),
              );
            }
            yield* completeAttempt(
              authority,
              started.lease,
              { kind: "classifier", value },
              dependencies,
            );
            return value;
          }),
        (abort) => Effect.sync(() => abort.abort()),
      ),
      authority,
      started.lease,
      dependencies,
    );
  });
}

function runMetadata(
  authority: MediaProcessingAuthority,
  providers: MediaProcessingProviders,
  dependencies: MediaProcessingWorkflowDependencies,
): WorkflowEffect<MetadataResult> {
  return Effect.gen(function* () {
    const started = yield* startAttempt(
      authority,
      "metadata",
      authority.audioRevision,
      dependencies.options.metadataAdapterRevision,
      dependencies,
    );
    if (started.kind === "replay") return requireAttemptKind(started.result, "metadata").value;
    return yield* catchStageFailure(
      Effect.acquireUseRelease(
        Effect.sync(() => new AbortController()),
        (abort) =>
          Effect.gen(function* () {
            const value = yield* promiseEffect(() =>
              providers.metadata.extract(authority, abort.signal),
            );
            yield* completeAttempt(
              authority,
              started.lease,
              { kind: "metadata", value },
              dependencies,
            );
            return value;
          }),
        (abort) => Effect.sync(() => abort.abort()),
      ),
      authority,
      started.lease,
      dependencies,
    );
  });
}

function acrDecision(
  authority: MediaProcessingAuthority,
  outcome: MediaIdentificationOutcome,
): MediaProcessingAnalysis["acr"] {
  const decision =
    outcome.outcome === "retained_reference_match"
      ? "requires_reference"
      : outcome.outcome === "no_match"
        ? authority.songType === "original"
          ? "allow"
          : "requires_reference"
        : outcome.outcome === "inconclusive_fingerprint" ||
            outcome.outcome === "retryable_failure" ||
            outcome.outcome === "permanent_provider_rejection" ||
            outcome.outcome === "malformed_or_unsupported_response"
          ? "inconclusive"
          : "skipped";
  return {
    decision,
    evidenceRef: `acr-evidence-${authority.operationId}-a${authority.analysisRevision}`,
    policyRevision: "acr-decision-v1",
    adapterRevision: outcome.context.adapterRevision,
  };
}

function moderateSongText(
  authority: MediaProcessingAuthority,
  providers: MediaProcessingProviders,
  dependencies: MediaProcessingWorkflowDependencies,
): WorkflowEffect<MediaProcessingAnalysis["contentModeration"]> {
  const moderationInput = {
    version: "text-moderation-input-v1" as const,
    surface: "text_post" as const,
    community_id: authority.communityId,
    title: authority.title,
    body: authority.lyrics?.text ?? null,
  };
  const canonical = canonicalTextModerationInput(moderationInput);
  return Effect.gen(function* () {
    const policy = yield* promiseEffect(() =>
      dependencies.store.readModerationPolicy(authority.communityId),
    );
    const fallback = (inputSha256: string) => ({
      decision: "manual_review" as const,
      resultingContentRating: authority.authorDeclaredRating,
      inputSha256,
      matchedCategories: [],
      policyRevision: policy.policy_revision,
      platformPolicyRevision: policy.platform_policy_revision,
      communityPolicyRevision: policy.community_policy_revision,
      evidenceRef: null,
      providerEvidence: null,
    });
    if (canonical.kind !== "accepted") return fallback("invalid");
    return yield* Effect.gen(function* () {
      const provider = yield* Effect.suspend(() =>
        providers.textModeration.evaluate(moderationInput),
      );
      if (provider.input_sha256 !== canonical.sha256) {
        return yield* Effect.die(new TypeError("moderation input mismatch"));
      }
      const resolution = resolveCommunityModerationPolicy({
        platform_floor: policy.platform_policy,
        community_policy: policy.community_policy,
        matched_categories: provider.matched_categories,
        author_declared_rating: authority.authorDeclaredRating,
      });
      const evidencePreimage = JSON.stringify([
        "song-text-moderation-evidence-v1",
        authority.communityId,
        authority.submissionId,
        canonical.sha256,
        policy.policy_revision,
        policy.platform_policy_revision,
        policy.community_policy_revision,
        provider.inputs,
      ]);
      const digest = yield* promiseEffect(() =>
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(evidencePreimage)),
      );
      const evidenceHash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      return {
        decision:
          resolution.effective_policy_decision === "permit"
            ? ("allow" as const)
            : resolution.effective_policy_decision === "review"
              ? ("manual_review" as const)
              : ("blocked" as const),
        resultingContentRating: resolution.resulting_content_rating,
        inputSha256: canonical.sha256,
        matchedCategories: resolution.matched_categories,
        policyRevision: policy.policy_revision,
        platformPolicyRevision: policy.platform_policy_revision,
        communityPolicyRevision: policy.community_policy_revision,
        evidenceRef: `evidence_${evidenceHash}`,
        providerEvidence: {
          providerId: provider.provider_id,
          requestedModel: provider.requested_model,
          returnedModel: provider.returned_model,
          inputs: provider.inputs,
        },
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.succeed(fallback(canonical.sha256)),
      ),
    );
  });
}

function moderateCover(
  metadata: MediaProcessingAnalysis["embeddedMetadata"],
  providers: MediaProcessingProviders,
): WorkflowEffect<MediaProcessingAnalysis["coverModeration"]> {
  const cover = metadata.cover;
  if (cover.status === "absent") {
    return Effect.succeed({
      decision: "not_applicable",
      reason: "not_embedded",
      providerId: null,
      requestedModel: null,
      returnedModel: null,
      inputSha256: null,
      matchedCategories: [],
      evidenceRef: null,
      evidence: null,
    });
  }
  if (cover.status === "rejected") {
    return Effect.succeed({
      decision: "withheld",
      reason: cover.reasonCode === "limits_exceeded" ? "limits_exceeded" : "invalid_image",
      providerId: null,
      requestedModel: null,
      returnedModel: null,
      inputSha256: null,
      matchedCategories: [],
      evidenceRef: metadata.evidenceRef,
      evidence: null,
    });
  }
  const invalidImage = {
    decision: "withheld",
    reason: "invalid_image",
    providerId: null,
    requestedModel: null,
    returnedModel: null,
    inputSha256: cover.artifactSha256,
    matchedCategories: [],
    evidenceRef: metadata.evidenceRef,
    evidence: null,
  } as const;
  const providerUnavailable = {
    decision: "withheld",
    reason: "provider_unavailable",
    providerId: "openai",
    requestedModel: "omni-moderation-2024-09-26",
    returnedModel: null,
    inputSha256: cover.artifactSha256,
    matchedCategories: [],
    evidenceRef: metadata.evidenceRef,
    evidence: null,
  } as const;
  return Effect.gen(function* () {
    const bytes = yield* abortablePromise((signal) =>
      providers.artifactReader.readCoverArtifact(cover, 700_000, signal),
    ).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.fail(new CoverReadFailure()),
      ),
    );
    return yield* Effect.gen(function* () {
      const result = yield* Effect.suspend(() =>
        providers.imageModeration.evaluateImage({
          bytes,
          mediaType: cover.mediaType,
          sha256: cover.artifactSha256,
        }),
      );
      const preimage = JSON.stringify([
        "song-cover-moderation-evidence-v1",
        result.provider_id,
        result.requested_model,
        result.returned_model,
        result.input_sha256,
        result.evidence,
      ]);
      const digest = yield* promiseEffect(() =>
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(preimage)),
      );
      const evidenceHash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      return {
        decision:
          result.matched_categories.length === 0 ? ("allow" as const) : ("withheld" as const),
        reason:
          result.matched_categories.length === 0
            ? ("clean" as const)
            : ("matched_category" as const),
        providerId: result.provider_id,
        requestedModel: result.requested_model,
        returnedModel: result.returned_model,
        inputSha256: result.input_sha256,
        matchedCategories: result.matched_categories,
        evidenceRef: `evidence_${evidenceHash}`,
        evidence: result.evidence,
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(providerUnavailable),
      ),
    );
  }).pipe(
    Effect.catchCause((cause) => {
      const error = Cause.findErrorOption(cause);
      return Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : error._tag === "Some" && error.value instanceof CoverReadFailure
          ? Effect.succeed(invalidImage)
          : Effect.failCause(cause);
    }),
  );
}

function buildAnalysis(
  firstAuthority: MediaProcessingAuthority,
  providers: MediaProcessingProviders,
  dependencies: MediaProcessingWorkflowDependencies,
): WorkflowEffect<MediaProcessingAnalysis | "processing_failed"> {
  return Effect.gen(function* () {
    let authority = yield* authoritativeReload(firstAuthority, dependencies);
    if (authority.audio === null) return "processing_failed" as const;
    const sealedHash = authority.audio.canonicalSha256;

    const probeOutcome = yield* runProbe(authority, providers, dependencies);
    if (probeOutcome.status !== "completed") {
      yield* storeWrite(() =>
        dependencies.store.commitProcessingFailure(authority, "probe_failed"),
      );
      return "processing_failed" as const;
    }
    if (probeOutcome.probe.durationMs > MEDIA_TRANSFORM_MAX_AUDIO_DURATION_MS) {
      yield* storeWrite(() =>
        dependencies.store.commitProcessingFailure(authority, "invalid_media"),
      );
      return "processing_failed" as const;
    }
    if (
      probeOutcome.probe.container !== "mp3" ||
      probeOutcome.probe.mimeType !== "audio/mpeg" ||
      probeOutcome.probe.tracks[0].codec !== "mp3"
    ) {
      yield* storeWrite(() =>
        dependencies.store.commitProcessingFailure(authority, "invalid_media"),
      );
      return "processing_failed" as const;
    }

    authority = yield* authoritativeReload(authority, dependencies);
    if (authority.audio?.canonicalSha256 !== sealedHash) return "processing_failed" as const;
    const primarySample = yield* runSample(
      authority,
      providers,
      probeOutcome.probe.durationMs,
      "primary",
      dependencies,
    );
    if (primarySample.status !== "completed") {
      yield* storeWrite(() =>
        dependencies.store.commitProcessingFailure(authority, "transform_failed"),
      );
      return "processing_failed" as const;
    }
    let acrOutcome = yield* runAcr(
      authority,
      providers,
      primarySample.artifact,
      "primary",
      dependencies,
    );
    if (acrOutcome.outcome === "inconclusive_fingerprint") {
      authority = yield* authoritativeReload(authority, dependencies);
      if (authority.audio?.canonicalSha256 !== sealedHash) return "processing_failed" as const;
      const alternate = yield* runSample(
        authority,
        providers,
        probeOutcome.probe.durationMs,
        "alternate",
        dependencies,
      );
      if (alternate.status !== "completed") {
        yield* storeWrite(() =>
          dependencies.store.commitProcessingFailure(authority, "transform_failed"),
        );
        return "processing_failed" as const;
      }
      acrOutcome = yield* runAcr(
        authority,
        providers,
        alternate.artifact,
        "alternate",
        dependencies,
      );
    }

    authority = yield* authoritativeReload(authority, dependencies);
    const metadata = yield* runMetadata(authority, providers, dependencies);
    const contentModeration = yield* moderateSongText(authority, providers, dependencies);
    const coverModeration = yield* moderateCover(metadata, providers);
    authority = yield* authoritativeReload(authority, dependencies);
    const mediaSafety: MediaProcessingAnalysis["mediaSafety"] =
      coverModeration.decision === "not_applicable"
        ? "not_applicable"
        : coverModeration.decision === "allow"
          ? "allow"
          : "cover_withheld";
    if (authority.audio?.canonicalSha256 !== sealedHash) return "processing_failed" as const;

    let lyricsAnalysis: MediaProcessingAnalysis["lyricsAnalysis"];
    let lyricsSafety: MediaProcessingAnalysis["lyricsSafety"];
    if (authority.lyrics === null) {
      lyricsAnalysis = { status: "not_applicable" };
      lyricsSafety = "not_applicable";
    } else {
      if (
        authority.lyrics.audioRevision !== authority.audioRevision ||
        authority.lyrics.canonicalAudioSha256 !== sealedHash
      )
        return "processing_failed" as const;
      const classified = yield* runClassifier(authority, providers, dependencies);
      if (classified.status === "classified") {
        lyricsAnalysis = {
          status: "ready",
          lyricsRevision: authority.lyrics.lyricsRevision,
          explicitness: classified.explicitness,
          primaryLanguageBcp47: classified.primary_language_bcp47,
          secondaryLanguageBcp47: classified.secondary_language_bcp47,
          evidenceRef: `classifier-evidence-${authority.operationId}-l${authority.lyrics.lyricsRevision}`,
          policyRevision: classified.policy_revision,
          adapterRevision: classified.adapter_revision,
        };
        lyricsSafety = classified.explicitness === "uncertain" ? "review_required" : "allow";
      } else {
        lyricsAnalysis = {
          status: "unavailable",
          lyricsRevision: authority.lyrics.lyricsRevision,
          evidenceRef: `classifier-unavailable-${authority.operationId}`,
          policyRevision: classified.policy_revision,
          adapterRevision: classified.adapter_revision,
        };
        lyricsSafety = "review_required";
      }
    }

    return {
      audioRevision: authority.audioRevision,
      analysisRevision: authority.analysisRevision,
      canonicalAudioSha256: sealedHash,
      probeEvidenceRef: `probe-evidence-${authority.operationId}-a${authority.analysisRevision}`,
      embeddedMetadata: metadata,
      lyricsAnalysis,
      acr: acrDecision(authority, acrOutcome),
      lyricsSafety,
      mediaSafety,
      coverModeration,
      contentModeration,
    };
  });
}

function decideMediaPublication(
  authority: MediaProcessingAuthority,
): MediaProcessingDecision | "waiting_for_terms" {
  if (authority.audio === null || authority.analysis === null || authority.termsRevision === null) {
    return "waiting_for_terms";
  }
  const analysis = authority.analysis;
  const outcome =
    analysis.mediaSafety === "blocked" ||
    analysis.lyricsSafety === "blocked" ||
    analysis.contentModeration.decision === "blocked"
      ? "block"
      : analysis.acr.decision === "requires_reference" && authority.boundReferenceAssetId === null
        ? "reference_required"
        : analysis.acr.decision === "inconclusive" ||
            analysis.acr.decision === "skipped" ||
            analysis.mediaSafety === "draft" ||
            analysis.mediaSafety === "review_required" ||
            analysis.lyricsSafety === "review_required" ||
            analysis.contentModeration.decision === "manual_review" ||
            analysis.lyricsAnalysis.status === "unavailable" ||
            (analysis.lyricsAnalysis.status === "ready" &&
              analysis.lyricsAnalysis.explicitness === "uncertain")
          ? "manual_review"
          : "allow";
  return {
    decisionRevision: authority.decisionRevision + 1,
    creationRevision: authority.creationRevision,
    audioRevision: authority.audioRevision,
    analysisRevision: authority.analysisRevision,
    lyricsRevision: authority.lyrics?.lyricsRevision ?? null,
    canonicalAudioSha256: authority.audio.canonicalSha256,
    outcome,
    evidenceRef: `decision-evidence-${authority.operationId}-c${authority.creationRevision}`,
    policyRevision: "song-publication-decision-v1",
    contentRating: analysis.contentModeration.resultingContentRating,
  };
}

function refreshLyricsClassification(
  authority: MediaProcessingAuthority,
  providers: MediaProcessingProviders,
  dependencies: MediaProcessingWorkflowDependencies,
): WorkflowEffect<MediaProcessingAnalysis | null> {
  return Effect.gen(function* () {
    const analysis = authority.analysis;
    const lyrics = authority.lyrics;
    if (
      analysis === null ||
      lyrics === null ||
      (analysis.lyricsAnalysis.status !== "not_applicable" &&
        analysis.lyricsAnalysis.lyricsRevision === lyrics.lyricsRevision)
    ) {
      return null;
    }
    const classified = yield* runClassifier(authority, providers, dependencies);
    const lyricsAnalysis: MediaProcessingAnalysis["lyricsAnalysis"] =
      classified.status === "classified"
        ? {
            status: "ready",
            lyricsRevision: lyrics.lyricsRevision,
            explicitness: classified.explicitness,
            primaryLanguageBcp47: classified.primary_language_bcp47,
            secondaryLanguageBcp47: classified.secondary_language_bcp47,
            evidenceRef: `classifier-evidence-${authority.operationId}-l${lyrics.lyricsRevision}`,
            policyRevision: classified.policy_revision,
            adapterRevision: classified.adapter_revision,
          }
        : {
            status: "unavailable",
            lyricsRevision: lyrics.lyricsRevision,
            evidenceRef: `classifier-unavailable-${authority.operationId}-l${lyrics.lyricsRevision}`,
            policyRevision: classified.policy_revision,
            adapterRevision: classified.adapter_revision,
          };
    const lyricsSafety =
      classified.status !== "classified" || classified.explicitness === "uncertain"
        ? ("review_required" as const)
        : ("allow" as const);
    const contentModeration = yield* moderateSongText(authority, providers, dependencies);
    return { ...analysis, lyricsAnalysis, lyricsSafety, contentModeration };
  });
}

function publish(
  authority: MediaProcessingAuthority,
  dependencies: MediaProcessingWorkflowDependencies,
): WorkflowEffect<MediaProcessingWorkflowResult> {
  return Effect.gen(function* () {
    const current = yield* authoritativeReload(authority, dependencies);
    if (current.status === "published") {
      return {
        outcome:
          current.publishedLyricsRevision === null ? "published_without_alignment" : "published",
      } as const;
    }
    if (current.status !== "processing" || current.phase !== "publish" || current.audio === null) {
      return { outcome: "inert" } as const;
    }
    const started = yield* startAttempt(
      current,
      "publication",
      current.decisionRevision,
      "postgres-publication-v1",
      dependencies,
    );
    if (started.kind === "replay") return { outcome: "published" } as const;
    const committed = yield* storeWrite(() => dependencies.store.commitPublication(current));
    if (committed === "stale") return yield* Effect.fail(new DeferredAttempt("stale_fence"));
    const after = yield* authoritativeReload(current, dependencies);
    if (after.status !== "published" || after.postId === null) {
      return yield* Effect.fail(new DeferredAttempt("stale_fence"));
    }
    yield* completeAttempt(
      after,
      started.lease,
      { kind: "publication", postId: after.postId },
      dependencies,
    );
    return {
      outcome: after.publishedLyricsRevision === null ? "published_without_alignment" : "published",
    } as const;
  });
}

function align(
  authority: MediaProcessingAuthority,
  dependencies: MediaProcessingWorkflowDependencies,
): WorkflowEffect<MediaProcessingWorkflowResult> {
  return Effect.gen(function* () {
    const current = yield* authoritativeReload(authority, dependencies);
    if (current.status !== "published" || current.postId === null || current.audio === null) {
      return { outcome: "inert" } as const;
    }
    if (current.publishedLyricsRevision !== (current.lyrics?.lyricsRevision ?? null)) {
      return { outcome: "inert" } as const;
    }
    const started = yield* startAttempt(
      current,
      "alignment",
      current.publishedLyricsRevision ?? current.analysisRevision,
      "alignment-port-v1",
      dependencies,
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
        const deferred = deferredAttemptFromCause(cause);
        if (deferred?.reason === "exhausted") return Effect.succeed({ kind: "exhausted" } as const);
        return Effect.failCause(cause);
      }),
    );
    if (started.kind === "exhausted") {
      const exhaustedResult = {
        kind: "alignment",
        status: "unavailable",
        failureCode: "provider_unavailable",
      } as const;
      const committed = yield* storeWrite(() =>
        dependencies.store.commitAlignment(current, exhaustedResult),
      );
      if (committed === "stale") return yield* Effect.fail(new DeferredAttempt("stale_fence"));
      return { outcome: "alignment_recorded" } as const;
    }
    if (started.kind === "replay") return { outcome: "alignment_recorded" } as const;
    let result: Extract<MediaProcessingAttemptResult, { readonly kind: "alignment" }>;
    if (current.lyrics === null) {
      result = { kind: "alignment", status: "unavailable", failureCode: "lyrics_missing" };
    } else if (dependencies.providers === null || !dependencies.options.enabled) {
      result = {
        kind: "alignment",
        status: "unavailable",
        failureCode: "provider_unavailable",
      };
    } else {
      const provider = dependencies.providers;
      const audio = current.audio;
      const lyrics = current.lyrics;
      const postId = current.postId;
      const aligned = yield* catchStageFailure(
        abortablePromise((signal) =>
          provider.alignment.align({
            operationId: current.operationId,
            postId,
            audioRevision: current.audioRevision,
            analysisRevision: current.analysisRevision,
            lyricsRevision: lyrics.lyricsRevision,
            canonicalAudioSha256: audio.canonicalSha256,
            audioArtifactRef: audio.immutableRef,
            lyrics: lyrics.text,
            signal,
          }),
        ).pipe(
          Effect.andThen((value) => {
            if (
              value.status === "unavailable" &&
              ["rate_limited", "provider_unavailable", "timeout"].includes(value.failureCode)
            ) {
              return failAttempt(current, started.lease, dependencies).pipe(
                Effect.andThen(Effect.fail(new DeferredAttempt("provider_progress"))),
              );
            }
            return Effect.succeed(value);
          }),
        ),
        current,
        started.lease,
        dependencies,
        () => new DeferredAttempt("provider_progress"),
      );
      result =
        aligned.status === "ready"
          ? {
              kind: "alignment",
              status: "ready",
              artifactRef: aligned.artifactRef,
              artifactSha256: aligned.artifactSha256,
              artifact: aligned.artifact,
            }
          : {
              kind: "alignment",
              status: "unavailable",
              failureCode: aligned.failureCode,
            };
    }
    const committed = yield* storeWrite(() => dependencies.store.commitAlignment(current, result));
    if (committed === "stale") return yield* Effect.fail(new DeferredAttempt("stale_fence"));
    yield* completeAttempt(current, started.lease, result, dependencies);
    return { outcome: "alignment_recorded" } as const;
  });
}

/** Durable interpreter. Every effectful phase begins from a fresh authority reload. */
function runMediaProcessingWorkflowOnce(
  rawPayload: unknown,
  eventType: MediaProcessingEventType,
  dependencies: MediaProcessingWorkflowDependencies,
): WorkflowEffect<MediaProcessingWorkflowResult> {
  return Effect.gen(function* () {
    const payload = decodeMediaProcessingWorkflowPayload(rawPayload);
    const outbox = yield* promiseEffect(() => dependencies.store.getOutbox(payload.outboxId));
    if (
      outbox === null ||
      outbox.eventType !== eventType ||
      outbox.submissionId !== payload.submissionId ||
      outbox.operationId !== payload.operationId ||
      outbox.workflowRevision !== payload.workflowRevision
    ) {
      return { outcome: "inert" } as const;
    }
    const loadedAuthority = yield* promiseEffect(() =>
      dependencies.store.loadAuthority(payload.submissionId, payload.operationId),
    );
    if (loadedAuthority === null || loadedAuthority.workflowRevision !== payload.workflowRevision) {
      return { outcome: "inert" } as const;
    }
    let authority = loadedAuthority;
    if (["blocked", "processing_failed", "abandoned"].includes(authority.status)) {
      dependencies.options.observe?.(observation(authority, "workflow_terminal"));
      return {
        outcome:
          authority.status === "blocked"
            ? "blocked"
            : authority.status === "processing_failed"
              ? "processing_failed"
              : "inert",
      } as const;
    }
    if (eventType === "alignment") return yield* align(authority, dependencies);
    if (eventType === "publication") return yield* publish(authority, dependencies);
    if (authority.status === "published") {
      return {
        outcome:
          eventType !== "analysis_launch"
            ? "inert"
            : authority.publishedLyricsRevision === null
              ? "published_without_alignment"
              : "published",
      } as const;
    }

    if (!dependencies.options.enabled || dependencies.providers === null) {
      yield* storeWrite(() =>
        dependencies.store.commitProviderUnavailableReview(
          authority,
          dependencies.options.enabled ? "missing_provider" : "disabled",
        ),
      );
      return { outcome: "manual_review" } as const;
    }

    if (authority.analysis === null) {
      const built = yield* buildAnalysis(authority, dependencies.providers, dependencies);
      if (built === "processing_failed") return { outcome: "processing_failed" } as const;
      authority = yield* authoritativeReload(authority, dependencies);
      if (authority.analysis === null) {
        const commitAuthority = authority;
        const committed = yield* storeWrite(() =>
          dependencies.store.commitAnalysis(commitAuthority, built),
        );
        if (committed === "stale") return yield* Effect.fail(new DeferredAttempt("stale_fence"));
      }
    } else {
      const refreshed = yield* refreshLyricsClassification(
        authority,
        dependencies.providers,
        dependencies,
      );
      if (refreshed !== null) {
        authority = yield* authoritativeReload(authority, dependencies);
        const commitAuthority = authority;
        const committed = yield* storeWrite(() =>
          dependencies.store.commitAnalysis(commitAuthority, refreshed),
        );
        if (committed === "stale") return yield* Effect.fail(new DeferredAttempt("stale_fence"));
      }
    }

    authority = yield* authoritativeReload(authority, dependencies);
    if (authority.analysis === null) return yield* Effect.fail(new DeferredAttempt("stale_fence"));
    if (
      authority.lyrics !== null &&
      (authority.lyrics.audioRevision !== authority.audioRevision ||
        authority.lyrics.canonicalAudioSha256 !== authority.audio?.canonicalSha256)
    ) {
      return yield* Effect.die(new TypeError("accepted lyrics crossed immutable audio lineage"));
    }
    const decision = decideMediaPublication(authority);
    if (decision === "waiting_for_terms") {
      dependencies.options.observe?.(observation(authority, "workflow_waiting"));
      return { outcome: decision } as const;
    }
    const commitAuthority = authority;
    const decisionCommit = yield* storeWrite(() =>
      dependencies.store.commitDecision(commitAuthority, decision),
    );
    if (decisionCommit === "stale") return yield* Effect.fail(new DeferredAttempt("stale_fence"));
    authority = yield* authoritativeReload(authority, dependencies);
    if (decision.outcome === "manual_review") return { outcome: "manual_review" } as const;
    if (decision.outcome === "block") return { outcome: "blocked" } as const;
    if (decision.outcome === "reference_required") return { outcome: "action_required" } as const;
    return yield* publish(authority, dependencies);
  });
}

export function runMediaProcessingWorkflow(
  rawPayload: unknown,
  eventType: MediaProcessingEventType,
  dependencies: MediaProcessingWorkflowDependencies,
): WorkflowEffect<MediaProcessingWorkflowResult> {
  return runMediaProcessingWorkflowOnce(rawPayload, eventType, dependencies).pipe(
    Effect.catchCause((cause): WorkflowEffect<MediaProcessingWorkflowResult> => {
      if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
      const error = deferredAttemptFromCause(cause);
      if (error === undefined) return Effect.failCause(cause);
      if (error.reason === "exhausted") {
        return Effect.gen(function* () {
          const payload = decodeMediaProcessingWorkflowPayload(rawPayload);
          const authority = yield* promiseEffect(() =>
            dependencies.store.loadAuthority(payload.submissionId, payload.operationId),
          );
          if (authority !== null) {
            yield* storeWrite(() =>
              dependencies.store.commitProviderUnavailableReview(authority, "provider_exhausted"),
            );
          }
          return { outcome: "manual_review" } as const;
        });
      }
      return Effect.succeed(
        error.reason.startsWith("acr_")
          ? {
              outcome: "waiting_for_provider" as const,
              reason: error.reason as NonNullable<
                Extract<
                  MediaProcessingWorkflowResult,
                  { outcome: "waiting_for_provider" }
                >["reason"]
              >,
            }
          : { outcome: "waiting_for_provider" as const },
      );
    }),
  );
}

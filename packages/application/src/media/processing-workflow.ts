import { Effect } from "effect";
import {
  MEDIA_TRANSFORM_MAX_AUDIO_DURATION_MS,
  type MediaTransformAttempt,
  type MediaTransformSampleArtifact,
} from "../media/transform.ts";
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

export type MediaProcessingWorkflowOptions = Readonly<{
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

const TRANSFORM_POLL_DELAY_MS = 10_000;

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

async function startAttempt(
  authority: MediaProcessingAuthority,
  stage: MediaProcessingAttemptStage,
  inputRevision: number,
  adapterRevision: string,
  dependencies: MediaProcessingWorkflowDependencies,
): Promise<
  | Readonly<{ readonly kind: "run"; readonly lease: MediaProcessingAttemptLease }>
  | Readonly<{ readonly kind: "replay"; readonly result: MediaProcessingAttemptResult }>
> {
  if (authority.audio === null) throw new TypeError("attempt requires authoritative audio");
  const started = await dependencies.store.startAttempt({
    authority,
    stage,
    attemptId: attemptId(authority, stage),
    workerId: dependencies.options.workerId,
    inputRevision,
    inputHash: authority.audio.canonicalSha256,
    policyRevision: dependencies.options.policyRevision,
    adapterRevision,
  });
  if (started.kind === "run") {
    dependencies.options.observe?.(observation(authority, "attempt_started", stage));
    return started;
  }
  if (started.kind === "replay") {
    dependencies.options.observe?.(observation(authority, "attempt_replayed", stage));
    return started;
  }
  throw new DeferredAttempt(started.kind);
}

async function completeAttempt(
  authority: MediaProcessingAuthority,
  lease: MediaProcessingAttemptLease,
  result: MediaProcessingAttemptResult,
  dependencies: MediaProcessingWorkflowDependencies,
): Promise<void> {
  if (!(await dependencies.store.completeAttempt(lease, result))) {
    throw new DeferredAttempt("stale_fence");
  }
  dependencies.options.observe?.(observation(authority, "attempt_completed", lease.stage));
}

async function deferAttempt(
  authority: MediaProcessingAuthority,
  lease: MediaProcessingAttemptLease,
  result: MediaProcessingAttemptResult,
  retryAfterMs: number,
  dependencies: MediaProcessingWorkflowDependencies,
): Promise<never> {
  if (!(await dependencies.store.deferAttempt(lease, result, retryAfterMs))) {
    throw new DeferredAttempt("stale_fence");
  }
  dependencies.options.observe?.(observation(authority, "attempt_completed", lease.stage));
  throw new DeferredAttempt("provider_progress");
}

async function failAttempt(
  authority: MediaProcessingAuthority,
  lease: MediaProcessingAttemptLease,
  dependencies: MediaProcessingWorkflowDependencies,
): Promise<void> {
  if (!(await dependencies.store.failAttempt(lease, "provider_unavailable", true))) {
    throw new DeferredAttempt("stale_fence");
  }
  dependencies.options.observe?.(observation(authority, "attempt_failed", lease.stage));
}

async function authoritativeReload(
  authority: Pick<MediaProcessingAuthority, "submissionId" | "operationId">,
  dependencies: MediaProcessingWorkflowDependencies,
): Promise<MediaProcessingAuthority> {
  const current = await dependencies.store.loadAuthority(
    authority.submissionId,
    authority.operationId,
  );
  if (current === null) throw new TypeError("authoritative media operation is missing");
  return current;
}

function requireAttemptKind<K extends MediaProcessingAttemptResult["kind"]>(
  result: MediaProcessingAttemptResult,
  kind: K,
): Extract<MediaProcessingAttemptResult, { readonly kind: K }> {
  if (result.kind !== kind) throw new TypeError(`attempt replay kind mismatch: ${kind}`);
  return result as Extract<MediaProcessingAttemptResult, { readonly kind: K }>;
}

async function runProbe(
  authority: MediaProcessingAuthority,
  providers: MediaProcessingProviders,
  dependencies: MediaProcessingWorkflowDependencies,
) {
  if (authority.audio === null) throw new TypeError("probe requires authoritative audio");
  const started = await startAttempt(
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
  try {
    const value = await Effect.runPromise(
      providers.transform.probe({
        version: "media-transform-probe-input-v1",
        binding: {
          operationId: authority.operationId,
          audioRevision: authority.audioRevision,
          analysisRevision: authority.analysisRevision,
          canonicalAudioSha256: authority.audio.canonicalSha256,
          requestId: started.lease.attemptId,
        },
        source: { objectKey: authority.audio.immutableRef },
        attempt,
      }),
    );
    if (value.status === "submitted" || value.status === "processing") {
      return await deferAttempt(
        authority,
        started.lease,
        { kind: "probe", value },
        TRANSFORM_POLL_DELAY_MS,
        dependencies,
      );
    }
    if (value.status === "retryable_failure") {
      await failAttempt(authority, started.lease, dependencies);
      throw new DeferredAttempt("provider_progress");
    }
    await completeAttempt(authority, started.lease, { kind: "probe", value }, dependencies);
    return value;
  } catch (error) {
    if (error instanceof DeferredAttempt) throw error;
    await failAttempt(authority, started.lease, dependencies);
    throw error;
  }
}

async function runSample(
  authority: MediaProcessingAuthority,
  providers: MediaProcessingProviders,
  durationMs: number,
  variant: "primary" | "alternate",
  dependencies: MediaProcessingWorkflowDependencies,
) {
  if (authority.audio === null) throw new TypeError("sample requires authoritative audio");
  const stage = variant === "primary" ? "sample_primary" : "sample_alternate";
  const started = await startAttempt(
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
  try {
    const value = await Effect.runPromise(
      providers.transform.extractAudioSample({
        version: "media-transform-audio-sample-input-v1",
        binding: {
          operationId: authority.operationId,
          audioRevision: authority.audioRevision,
          analysisRevision: authority.analysisRevision,
          canonicalAudioSha256: authority.audio.canonicalSha256,
          requestId: started.lease.attemptId,
        },
        source: { objectKey: authority.audio.immutableRef },
        sourceDurationMs: durationMs,
        variant,
        attempt,
      }),
    );
    if (value.status === "submitted" || value.status === "processing") {
      return await deferAttempt(
        authority,
        started.lease,
        { kind: "sample", value },
        TRANSFORM_POLL_DELAY_MS,
        dependencies,
      );
    }
    if (value.status === "retryable_failure") {
      await failAttempt(authority, started.lease, dependencies);
      throw new DeferredAttempt("provider_progress");
    }
    await completeAttempt(authority, started.lease, { kind: "sample", value }, dependencies);
    return value;
  } catch (error) {
    if (error instanceof DeferredAttempt) throw error;
    await failAttempt(authority, started.lease, dependencies);
    throw error;
  }
}

async function runAcr(
  authority: MediaProcessingAuthority,
  providers: MediaProcessingProviders,
  artifact: MediaTransformSampleArtifact,
  variant: "primary" | "alternate",
  dependencies: MediaProcessingWorkflowDependencies,
) {
  if (authority.audio === null) throw new TypeError("identification requires authoritative audio");
  const stage = variant === "primary" ? "acr_primary" : "acr_alternate";
  const started = await startAttempt(
    authority,
    stage,
    authority.audioRevision,
    "identification-port-v1",
    dependencies,
  );
  if (started.kind === "replay") return requireAttemptKind(started.result, "acr").value;
  const abort = new AbortController();
  try {
    const bytes = await providers.artifactReader.readAudioSample(
      artifact,
      dependencies.options.maximumSampleBytes,
      abort.signal,
    );
    const value = await Effect.runPromise(
      providers.identification.identify({
        version: "media-identification-request-v1",
        operationId: authority.operationId,
        audioRevision: authority.audioRevision,
        analysisRevision: authority.analysisRevision,
        canonicalAudioSha256: authority.audio.canonicalSha256,
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
      await failAttempt(authority, started.lease, dependencies);
      throw new DeferredAttempt(
        value.reason === "transport"
          ? "acr_transport"
          : value.reason === "throttled"
            ? "acr_throttled"
            : "acr_provider",
      );
    }
    await completeAttempt(authority, started.lease, { kind: "acr", value }, dependencies);
    return value;
  } catch (error) {
    if (error instanceof DeferredAttempt) throw error;
    abort.abort();
    await failAttempt(authority, started.lease, dependencies);
    throw new DeferredAttempt("acr_preflight");
  }
}

async function runClassifier(
  authority: MediaProcessingAuthority,
  providers: MediaProcessingProviders,
  dependencies: MediaProcessingWorkflowDependencies,
) {
  if (authority.audio === null || authority.lyrics === null) {
    throw new TypeError("classifier requires current accepted lyrics");
  }
  const started = await startAttempt(
    authority,
    "classifier",
    authority.lyrics.lyricsRevision,
    "classifier-port-v1",
    dependencies,
  );
  if (started.kind === "replay") {
    return requireAttemptKind(started.result, "classifier").value;
  }
  const abort = new AbortController();
  const acceptedLyrics: MediaAcceptedLyrics = {
    version: "media-accepted-lyrics-v1",
    operation_id: authority.operationId,
    audio_revision: authority.audioRevision,
    lyrics_revision: authority.lyrics.lyricsRevision,
    canonical_audio_sha256: authority.audio.canonicalSha256,
    lyrics: authority.lyrics.text,
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
  try {
    const value = await Effect.runPromise(
      providers.classifier.classify(input, { signal: abort.signal }),
    );
    if (!isMediaClassifierResultBoundToInputs(input, value)) {
      throw new TypeError("classifier result crossed accepted lyrics lineage");
    }
    await completeAttempt(authority, started.lease, { kind: "classifier", value }, dependencies);
    return value;
  } catch (error) {
    if (error instanceof DeferredAttempt) throw error;
    abort.abort();
    await failAttempt(authority, started.lease, dependencies);
    throw error;
  }
}

async function runMetadata(
  authority: MediaProcessingAuthority,
  providers: MediaProcessingProviders,
  dependencies: MediaProcessingWorkflowDependencies,
) {
  const started = await startAttempt(
    authority,
    "metadata",
    authority.audioRevision,
    dependencies.options.metadataAdapterRevision,
    dependencies,
  );
  if (started.kind === "replay") return requireAttemptKind(started.result, "metadata").value;
  const abort = new AbortController();
  try {
    const value = await providers.metadata.extract(authority, abort.signal);
    await completeAttempt(authority, started.lease, { kind: "metadata", value }, dependencies);
    return value;
  } catch (error) {
    if (error instanceof DeferredAttempt) throw error;
    abort.abort();
    await failAttempt(authority, started.lease, dependencies);
    throw error;
  }
}

function acrDecision(
  authority: MediaProcessingAuthority,
  outcome: Awaited<ReturnType<typeof runAcr>>,
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

async function buildAnalysis(
  firstAuthority: MediaProcessingAuthority,
  providers: MediaProcessingProviders,
  dependencies: MediaProcessingWorkflowDependencies,
): Promise<MediaProcessingAnalysis | "processing_failed"> {
  let authority = await authoritativeReload(firstAuthority, dependencies);
  if (authority.audio === null) return "processing_failed";
  const sealedHash = authority.audio.canonicalSha256;

  const probeOutcome = await runProbe(authority, providers, dependencies);
  if (probeOutcome.status !== "completed") {
    await dependencies.store.commitProcessingFailure(authority, "probe_failed");
    return "processing_failed";
  }
  if (probeOutcome.probe.durationMs > MEDIA_TRANSFORM_MAX_AUDIO_DURATION_MS) {
    await dependencies.store.commitProcessingFailure(authority, "invalid_media");
    return "processing_failed";
  }
  if (
    probeOutcome.probe.container !== "mp3" ||
    probeOutcome.probe.mimeType !== "audio/mpeg" ||
    probeOutcome.probe.tracks[0].codec !== "mp3"
  ) {
    await dependencies.store.commitProcessingFailure(authority, "invalid_media");
    return "processing_failed";
  }

  authority = await authoritativeReload(authority, dependencies);
  if (authority.audio?.canonicalSha256 !== sealedHash) return "processing_failed";
  const primarySample = await runSample(
    authority,
    providers,
    probeOutcome.probe.durationMs,
    "primary",
    dependencies,
  );
  if (primarySample.status !== "completed") {
    await dependencies.store.commitProcessingFailure(authority, "transform_failed");
    return "processing_failed";
  }
  let acrOutcome = await runAcr(
    authority,
    providers,
    primarySample.artifact,
    "primary",
    dependencies,
  );
  if (acrOutcome.outcome === "inconclusive_fingerprint") {
    authority = await authoritativeReload(authority, dependencies);
    if (authority.audio?.canonicalSha256 !== sealedHash) return "processing_failed";
    const alternate = await runSample(
      authority,
      providers,
      probeOutcome.probe.durationMs,
      "alternate",
      dependencies,
    );
    if (alternate.status !== "completed") {
      await dependencies.store.commitProcessingFailure(authority, "transform_failed");
      return "processing_failed";
    }
    acrOutcome = await runAcr(authority, providers, alternate.artifact, "alternate", dependencies);
    if (acrOutcome.outcome === "inconclusive_fingerprint") {
      acrOutcome = {
        ...acrOutcome,
        outcome: "inconclusive_fingerprint",
      };
    }
  }

  authority = await authoritativeReload(authority, dependencies);
  const metadata = await runMetadata(authority, providers, dependencies);
  authority = await authoritativeReload(authority, dependencies);
  const mediaSafety: MediaProcessingAnalysis["mediaSafety"] =
    metadata.cover.status === "absent"
      ? "not_applicable"
      : metadata.cover.status === "rejected" && metadata.cover.reasonCode === "unsafe"
        ? "blocked"
        : "review_required";
  if (authority.audio?.canonicalSha256 !== sealedHash) return "processing_failed";

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
      return "processing_failed";
    const classified = await runClassifier(authority, providers, dependencies);
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
  };
}

export function decideMediaPublication(
  authority: MediaProcessingAuthority,
): MediaProcessingDecision | "waiting_for_terms" {
  if (authority.audio === null || authority.analysis === null || authority.termsRevision === null) {
    return "waiting_for_terms";
  }
  const analysis = authority.analysis;
  const outcome =
    analysis.mediaSafety === "blocked" || analysis.lyricsSafety === "blocked"
      ? "block"
      : analysis.acr.decision === "requires_reference" && authority.boundReferenceAssetId === null
        ? "reference_required"
        : analysis.acr.decision === "inconclusive" ||
            analysis.acr.decision === "skipped" ||
            analysis.mediaSafety === "draft" ||
            analysis.mediaSafety === "review_required" ||
            analysis.lyricsSafety === "review_required" ||
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
  };
}

async function refreshLyricsClassification(
  authority: MediaProcessingAuthority,
  providers: MediaProcessingProviders,
  dependencies: MediaProcessingWorkflowDependencies,
): Promise<MediaProcessingAnalysis | null> {
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
  const classified = await runClassifier(authority, providers, dependencies);
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
      ? "review_required"
      : "allow";
  return { ...analysis, lyricsAnalysis, lyricsSafety };
}

async function publish(
  authority: MediaProcessingAuthority,
  dependencies: MediaProcessingWorkflowDependencies,
): Promise<MediaProcessingWorkflowResult> {
  const current = await authoritativeReload(authority, dependencies);
  if (current.status === "published") {
    return {
      outcome:
        current.publishedLyricsRevision === null ? "published_without_alignment" : "published",
    };
  }
  if (current.status !== "processing" || current.phase !== "publish" || current.audio === null) {
    return { outcome: "inert" };
  }
  const started = await startAttempt(
    current,
    "publication",
    current.decisionRevision,
    "postgres-publication-v1",
    dependencies,
  );
  if (started.kind === "replay") return { outcome: "published" };
  const committed = await dependencies.store.commitPublication(current);
  if (committed === "stale") throw new DeferredAttempt("stale_fence");
  const after = await authoritativeReload(current, dependencies);
  if (after.status !== "published" || after.postId === null) {
    throw new DeferredAttempt("stale_fence");
  }
  await completeAttempt(
    after,
    started.lease,
    { kind: "publication", postId: after.postId },
    dependencies,
  );
  return {
    outcome: after.publishedLyricsRevision === null ? "published_without_alignment" : "published",
  };
}

async function align(
  authority: MediaProcessingAuthority,
  dependencies: MediaProcessingWorkflowDependencies,
): Promise<MediaProcessingWorkflowResult> {
  const current = await authoritativeReload(authority, dependencies);
  if (current.status !== "published" || current.postId === null || current.audio === null) {
    return { outcome: "inert" };
  }
  if (current.publishedLyricsRevision !== (current.lyrics?.lyricsRevision ?? null)) {
    return { outcome: "inert" };
  }
  let started: Awaited<ReturnType<typeof startAttempt>>;
  try {
    started = await startAttempt(
      current,
      "alignment",
      current.publishedLyricsRevision ?? current.analysisRevision,
      "alignment-port-v1",
      dependencies,
    );
  } catch (error) {
    if (!(error instanceof DeferredAttempt) || error.reason !== "exhausted") throw error;
    const exhaustedResult = {
      kind: "alignment",
      status: "unavailable",
      failureCode: "provider_unavailable",
    } as const;
    const committed = await dependencies.store.commitAlignment(current, exhaustedResult);
    if (committed === "stale") throw new DeferredAttempt("stale_fence");
    return { outcome: "alignment_recorded" };
  }
  if (started.kind === "replay") return { outcome: "alignment_recorded" };
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
    const abort = new AbortController();
    try {
      const aligned = await dependencies.providers.alignment.align({
        operationId: current.operationId,
        postId: current.postId,
        audioRevision: current.audioRevision,
        analysisRevision: current.analysisRevision,
        lyricsRevision: current.lyrics.lyricsRevision,
        canonicalAudioSha256: current.audio.canonicalSha256,
        audioArtifactRef: current.audio.immutableRef,
        lyrics: current.lyrics.text,
        signal: abort.signal,
      });
      if (
        aligned.status === "unavailable" &&
        ["rate_limited", "provider_unavailable", "timeout"].includes(aligned.failureCode)
      ) {
        await failAttempt(current, started.lease, dependencies);
        throw new DeferredAttempt("provider_progress");
      }
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
    } catch (error) {
      if (error instanceof DeferredAttempt) throw error;
      abort.abort();
      await failAttempt(current, started.lease, dependencies);
      throw new DeferredAttempt("provider_progress");
    }
  }
  const committed = await dependencies.store.commitAlignment(current, result);
  if (committed === "stale") throw new DeferredAttempt("stale_fence");
  await completeAttempt(current, started.lease, result, dependencies);
  return { outcome: "alignment_recorded" };
}

/** Durable interpreter. Every effectful phase begins from a fresh authority reload. */
async function runMediaProcessingWorkflowOnce(
  rawPayload: unknown,
  eventType: MediaProcessingEventType,
  dependencies: MediaProcessingWorkflowDependencies,
): Promise<MediaProcessingWorkflowResult> {
  const payload = decodeMediaProcessingWorkflowPayload(rawPayload);
  const outbox = await dependencies.store.getOutbox(payload.outboxId);
  if (
    outbox === null ||
    outbox.eventType !== eventType ||
    outbox.submissionId !== payload.submissionId ||
    outbox.operationId !== payload.operationId ||
    outbox.workflowRevision !== payload.workflowRevision
  ) {
    return { outcome: "inert" };
  }
  let authority = await dependencies.store.loadAuthority(payload.submissionId, payload.operationId);
  if (authority === null || authority.workflowRevision !== payload.workflowRevision) {
    return { outcome: "inert" };
  }
  if (["blocked", "processing_failed", "abandoned"].includes(authority.status)) {
    dependencies.options.observe?.(observation(authority, "workflow_terminal"));
    return {
      outcome:
        authority.status === "blocked"
          ? "blocked"
          : authority.status === "processing_failed"
            ? "processing_failed"
            : "inert",
    };
  }
  if (eventType === "alignment") return align(authority, dependencies);
  if (eventType === "publication") return publish(authority, dependencies);
  if (authority.status === "published") {
    return {
      outcome:
        eventType !== "analysis_launch"
          ? "inert"
          : authority.publishedLyricsRevision === null
            ? "published_without_alignment"
            : "published",
    };
  }

  if (!dependencies.options.enabled || dependencies.providers === null) {
    await dependencies.store.commitProviderUnavailableReview(
      authority,
      dependencies.options.enabled ? "missing_provider" : "disabled",
    );
    return { outcome: "manual_review" };
  }

  if (authority.analysis === null) {
    const built = await buildAnalysis(authority, dependencies.providers, dependencies);
    if (built === "processing_failed") return { outcome: "processing_failed" };
    authority = await authoritativeReload(authority, dependencies);
    if (authority.analysis === null) {
      const committed = await dependencies.store.commitAnalysis(authority, built);
      if (committed === "stale") throw new DeferredAttempt("stale_fence");
    }
  } else {
    const refreshed = await refreshLyricsClassification(
      authority,
      dependencies.providers,
      dependencies,
    );
    if (refreshed !== null) {
      authority = await authoritativeReload(authority, dependencies);
      const committed = await dependencies.store.commitAnalysis(authority, refreshed);
      if (committed === "stale") throw new DeferredAttempt("stale_fence");
    }
  }

  authority = await authoritativeReload(authority, dependencies);
  if (authority.analysis === null) throw new DeferredAttempt("stale_fence");
  if (
    authority.lyrics !== null &&
    (authority.lyrics.audioRevision !== authority.audioRevision ||
      authority.lyrics.canonicalAudioSha256 !== authority.audio?.canonicalSha256)
  ) {
    throw new TypeError("accepted lyrics crossed immutable audio lineage");
  }
  const decision = decideMediaPublication(authority);
  if (decision === "waiting_for_terms") {
    dependencies.options.observe?.(observation(authority, "workflow_waiting"));
    return { outcome: decision };
  }
  const decisionCommit = await dependencies.store.commitDecision(authority, decision);
  if (decisionCommit === "stale") throw new DeferredAttempt("stale_fence");
  authority = await authoritativeReload(authority, dependencies);
  if (decision.outcome === "manual_review") return { outcome: "manual_review" };
  if (decision.outcome === "block") return { outcome: "blocked" };
  if (decision.outcome === "reference_required") return { outcome: "action_required" };
  return publish(authority, dependencies);
}

export async function runMediaProcessingWorkflow(
  rawPayload: unknown,
  eventType: MediaProcessingEventType,
  dependencies: MediaProcessingWorkflowDependencies,
): Promise<MediaProcessingWorkflowResult> {
  try {
    return await runMediaProcessingWorkflowOnce(rawPayload, eventType, dependencies);
  } catch (error) {
    if (!(error instanceof DeferredAttempt)) throw error;
    if (error.reason === "exhausted") {
      const payload = decodeMediaProcessingWorkflowPayload(rawPayload);
      const authority = await dependencies.store.loadAuthority(
        payload.submissionId,
        payload.operationId,
      );
      if (authority !== null) {
        await dependencies.store.commitProviderUnavailableReview(authority, "provider_exhausted");
      }
      return { outcome: "manual_review" };
    }
    return error.reason.startsWith("acr_")
      ? {
          outcome: "waiting_for_provider",
          reason: error.reason as NonNullable<
            Extract<MediaProcessingWorkflowResult, { outcome: "waiting_for_provider" }>["reason"]
          >,
        }
      : { outcome: "waiting_for_provider" };
  }
}

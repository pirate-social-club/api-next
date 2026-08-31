import { describe, expect, test } from "bun:test";
import { MODERATION_POLICY_CATEGORIES_V1 } from "@pirate/contracts";
import { canonicalTextModerationInput } from "@pirate/domain";
import { Effect } from "effect";
import { hostileCorrectedLyrics } from "../../../../tests/fixtures/media-processing/hostile-classifier-inputs.ts";
import type {
  MediaTransformAudioSampleInput,
  MediaTransformProbeInput,
} from "../media/transform.ts";
import type { MediaIdentificationRequest } from "../media-identification-provider.ts";
import type { MediaExplicitnessClassifierInput } from "../media-provider-contracts.ts";
import type {
  MediaProcessingAnalysis,
  MediaProcessingAttemptLease,
  MediaProcessingAttemptResult,
  MediaProcessingAuthority,
  MediaProcessingCommit,
  MediaProcessingOutboxRecord,
  MediaProcessingProviders,
  MediaProcessingStore,
} from "./processing-contracts.ts";
import { runMediaProcessingWorkflow } from "./processing-workflow.ts";

const hash = "a".repeat(64);

function authority(overrides: Partial<MediaProcessingAuthority> = {}): MediaProcessingAuthority {
  return {
    communityId: "community-1",
    actorAccountId: "account-1",
    authorPersonaId: "persona-1",
    submissionId: "submission-1",
    operationId: "operation-1",
    songType: "original",
    title: "Song title",
    authorDeclaredRating: "general",
    creationRevision: 2,
    audioRevision: 1,
    analysisRevision: 1,
    decisionRevision: 0,
    workflowRevision: 1,
    retryCount: 0,
    status: "processing",
    phase: "analysis",
    audio: {
      immutableRef: "private/audio-1",
      canonicalSha256: hash,
      contentType: "audio/mpeg",
      sizeBytes: 1024,
    },
    termsRevision: 2,
    lyrics: {
      lyricsRevision: 1,
      audioRevision: 1,
      canonicalAudioSha256: hash,
      text: "accepted lyrics",
    },
    analysis: null,
    decision: null,
    boundReferenceAssetId: null,
    postId: null,
    publishedLyricsRevision: null,
    ...overrides,
  };
}

class FakeStore implements MediaProcessingStore {
  readonly events: string[] = [];
  readonly attempts = new Map<
    string,
    Readonly<{
      lease: MediaProcessingAttemptLease;
      result?: MediaProcessingAttemptResult;
      failed?: boolean;
      deferred?: boolean;
    }>
  >();
  readonly outboxes = new Map<string, MediaProcessingOutboxRecord>();
  current: MediaProcessingAuthority;
  publications = 0;
  alignmentLaunches = 0;
  alignments = 0;
  readonly alignmentResults: Extract<
    MediaProcessingAttemptResult,
    { readonly kind: "alignment" }
  >[] = [];
  providerReviews = 0;
  readonly communityDecisions = new Map<string, "permit" | "review" | "block">();

  constructor(
    current = authority(),
    eventType: MediaProcessingOutboxRecord["eventType"] = "analysis_launch",
  ) {
    this.current = current;
    this.outboxes.set("outbox-1", {
      outboxId: "outbox-1",
      eventType,
      submissionId: current.submissionId,
      operationId: current.operationId,
      workflowRevision: current.workflowRevision,
      workflowInstanceId: `media-${current.operationId}-r${current.workflowRevision}`,
      deliveryAttempts: 0,
      state: "delivered",
      claimFence: 1,
      claimOwner: null,
    });
  }

  getOutbox = async (outboxId: string) => this.outboxes.get(outboxId) ?? null;

  claimOutbox = async (outboxId: string, workerId: string) => {
    const prior = this.outboxes.get(outboxId);
    if (prior === undefined || prior.state === "delivered" || prior.state === "exhausted")
      return null;
    const claimed = {
      ...prior,
      state: "running" as const,
      deliveryAttempts: prior.deliveryAttempts + 1,
      claimFence: prior.claimFence + 1,
      claimOwner: workerId,
    };
    this.outboxes.set(outboxId, claimed);
    return claimed;
  };

  completeOutbox = async (record: MediaProcessingOutboxRecord) => {
    const prior = this.outboxes.get(record.outboxId);
    if (
      prior?.state !== "running" ||
      prior.claimFence !== record.claimFence ||
      prior.claimOwner !== record.claimOwner
    )
      return false;
    this.outboxes.set(record.outboxId, { ...prior, state: "delivered", claimOwner: null });
    return true;
  };

  failOutbox = async (record: MediaProcessingOutboxRecord) => {
    const prior = this.outboxes.get(record.outboxId);
    if (prior?.state !== "running" || prior.claimFence !== record.claimFence) return false;
    this.outboxes.set(record.outboxId, {
      ...prior,
      state: prior.deliveryAttempts >= 3 ? "exhausted" : "failed",
      claimOwner: null,
    });
    return true;
  };

  loadAuthority = async (submissionId: string, operationId: string) =>
    this.current.submissionId === submissionId && this.current.operationId === operationId
      ? this.current
      : null;

  startAttempt: MediaProcessingStore["startAttempt"] = async (input) => {
    const prior = this.attempts.get(input.attemptId);
    if (prior?.result !== undefined && prior.deferred !== true) {
      return { kind: "replay", result: prior.result };
    }
    if (prior !== undefined && prior.failed !== true && prior.deferred !== true) {
      return { kind: "busy" };
    }
    const lease = {
      attemptId: input.attemptId,
      attemptNumber: prior?.lease.attemptNumber ?? 1,
      stage: input.stage,
      claimOwner: input.workerId,
      claimFence: (prior?.lease.claimFence ?? 0) + 1,
      ...(prior?.deferred === true && prior.result !== undefined
        ? { priorResult: prior.result }
        : {}),
    };
    this.events.push(`persist:${input.stage}:${input.inputHash}`);
    this.attempts.set(input.attemptId, { lease });
    return { kind: "run", lease };
  };

  deferAttempt = async (
    lease: MediaProcessingAttemptLease,
    result: MediaProcessingAttemptResult,
  ) => {
    const prior = this.attempts.get(lease.attemptId);
    if (prior?.lease.claimFence !== lease.claimFence || prior.lease.claimOwner !== lease.claimOwner)
      return false;
    this.events.push(`defer:${lease.stage}`);
    this.attempts.set(lease.attemptId, { lease, result, deferred: true });
    return true;
  };

  completeAttempt = async (
    lease: MediaProcessingAttemptLease,
    result: MediaProcessingAttemptResult,
  ) => {
    const prior = this.attempts.get(lease.attemptId);
    if (prior?.lease.claimFence !== lease.claimFence || prior.lease.claimOwner !== lease.claimOwner)
      return false;
    this.events.push(`complete:${lease.stage}`);
    this.attempts.set(lease.attemptId, { lease, result });
    return true;
  };

  failAttempt = async (lease: MediaProcessingAttemptLease) => {
    const prior = this.attempts.get(lease.attemptId);
    if (prior?.lease.claimFence !== lease.claimFence) return false;
    this.events.push(`fail:${lease.stage}`);
    this.attempts.set(lease.attemptId, { lease, failed: true });
    return true;
  };

  commitAnalysis = async (
    expected: MediaProcessingAuthority,
    analysis: MediaProcessingAnalysis,
  ): Promise<MediaProcessingCommit> => {
    if (
      this.current.analysis !== null &&
      this.current.analysis.lyricsAnalysis.status === "ready" &&
      analysis.lyricsAnalysis.status === "ready" &&
      this.current.analysis.lyricsAnalysis.lyricsRevision === analysis.lyricsAnalysis.lyricsRevision
    )
      return "replay";
    if (
      expected.creationRevision !== this.current.creationRevision ||
      analysis.canonicalAudioSha256 !== this.current.audio?.canonicalSha256
    )
      return "stale";
    this.events.push("commit:analysis");
    this.current = { ...this.current, analysis, phase: "decision" };
    return "committed";
  };

  commitDecision: MediaProcessingStore["commitDecision"] = async (expected, decision) => {
    if (this.current.decision !== null) return "replay";
    if (
      expected.creationRevision !== this.current.creationRevision ||
      decision.canonicalAudioSha256 !== this.current.audio?.canonicalSha256
    )
      return "stale";
    this.events.push(`commit:decision:${decision.outcome}`);
    this.current = {
      ...this.current,
      decision,
      decisionRevision: decision.decisionRevision,
      status:
        decision.outcome === "manual_review"
          ? "manual_review"
          : decision.outcome === "block"
            ? "blocked"
            : decision.outcome === "reference_required"
              ? "action_required"
              : "processing",
      phase: decision.outcome === "allow" ? "publish" : null,
    };
    return "committed";
  };

  commitPublication = async (
    expected: MediaProcessingAuthority,
  ): Promise<MediaProcessingCommit> => {
    if (this.current.status === "published") return "replay";
    if (
      expected.creationRevision !== this.current.creationRevision ||
      expected.decisionRevision !== this.current.decisionRevision ||
      this.current.phase !== "publish"
    )
      return "stale";
    this.events.push("commit:publication+alignment");
    this.publications += 1;
    if (this.current.lyrics !== null) this.alignmentLaunches += 1;
    this.current = {
      ...this.current,
      status: "published",
      phase: null,
      postId: `media-post-${this.current.operationId}`,
      publishedLyricsRevision: this.current.lyrics?.lyricsRevision ?? null,
    };
    return "committed";
  };

  commitAlignment: MediaProcessingStore["commitAlignment"] = async (expected, result) => {
    if (
      expected.publishedLyricsRevision !== this.current.publishedLyricsRevision ||
      expected.postId !== this.current.postId
    )
      return "stale";
    if (this.alignments > 0) return "replay";
    this.events.push(`commit:alignment:l${String(expected.publishedLyricsRevision)}`);
    this.alignments += 1;
    this.alignmentResults.push(result);
    return "committed";
  };

  commitProcessingFailure: MediaProcessingStore["commitProcessingFailure"] = async (
    expected,
    reason,
  ) => {
    if (expected.audioRevision !== this.current.audioRevision) return "stale";
    this.events.push(`commit:failure:${reason}`);
    this.current = { ...this.current, status: "processing_failed", phase: null };
    return "committed";
  };

  commitProviderUnavailableReview: MediaProcessingStore["commitProviderUnavailableReview"] = async (
    expected,
    reason,
  ) => {
    if (expected.creationRevision !== this.current.creationRevision) return "stale";
    this.events.push(`commit:provider-review:${reason}`);
    this.providerReviews += 1;
    this.current = { ...this.current, status: "manual_review", phase: null };
    return "committed";
  };

  replaceMissingWorkflow = async (expected: MediaProcessingAuthority) => {
    if (expected.workflowRevision !== this.current.workflowRevision) return "stale" as const;
    this.current = { ...this.current, workflowRevision: this.current.workflowRevision + 1 };
    return "committed" as const;
  };

  listWorkflowCandidates = async () => [this.current];

  readModerationPolicy = async () => ({
    policy_revision: "provider-policy-v1",
    policy_hash: hash,
    platform_policy_revision: "platform-floor-v1",
    platform_policy_hash: hash,
    platform_policy: Object.fromEntries(
      MODERATION_POLICY_CATEGORIES_V1.map((category) => [
        category,
        category === "sexual/minors"
          ? "block"
          : [
                "harassment",
                "illicit",
                "self-harm",
                "sexual",
                "violence",
                "violence/graphic",
              ].includes(category)
            ? "permit"
            : "review",
      ]),
    ) as never,
    community_policy_revision: "community-policy-v1",
    community_policy_hash: hash,
    community_policy: Object.fromEntries(
      MODERATION_POLICY_CATEGORIES_V1.map((category) => [
        category,
        this.communityDecisions.get(category) ??
          (category === "sexual/minors" ? "block" : "review"),
      ]),
    ) as never,
  });
}

type ProviderControls = {
  durationMs: number;
  acr: ("no_match" | "fingerprint" | "match" | "failure")[];
  explicitness: "not_explicit" | "explicit" | "uncertain";
  matchedCategories: readonly (typeof MODERATION_POLICY_CATEGORIES_V1)[number][];
  imageMatchedCategories: readonly (typeof MODERATION_POLICY_CATEGORIES_V1)[number][];
  imageUnavailable: boolean;
  cover: MediaProcessingAnalysis["embeddedMetadata"]["cover"];
  onClassifierInput?: (input: MediaExplicitnessClassifierInput) => void;
};

function providers(
  events: string[],
  overrides: Partial<ProviderControls> = {},
): MediaProcessingProviders {
  const controls: ProviderControls = {
    durationMs: 180_000,
    acr: ["no_match", "no_match"],
    explicitness: "not_explicit",
    matchedCategories: [],
    imageMatchedCategories: [],
    imageUnavailable: false,
    cover: { status: "absent", reasonCode: "not_embedded" },
    ...overrides,
  };
  let acrIndex = 0;
  const categoryBooleans = Object.fromEntries(
    MODERATION_POLICY_CATEGORIES_V1.map((category) => [
      category,
      controls.imageMatchedCategories.includes(category),
    ]),
  ) as Record<(typeof MODERATION_POLICY_CATEGORIES_V1)[number], boolean>;
  const categoryScores = Object.fromEntries(
    MODERATION_POLICY_CATEGORIES_V1.map((category) => [
      category,
      categoryBooleans[category] ? 1 : 0,
    ]),
  ) as Record<(typeof MODERATION_POLICY_CATEGORIES_V1)[number], number>;
  const categoryInputTypes = {} as Record<
    (typeof MODERATION_POLICY_CATEGORIES_V1)[number],
    readonly ("image" | "text")[]
  >;
  for (const category of MODERATION_POLICY_CATEGORIES_V1) {
    categoryInputTypes[category] = categoryBooleans[category] ? ["image"] : [];
  }
  return {
    textModeration: {
      evaluate: (input) => {
        const canonical = canonicalTextModerationInput(input);
        if (canonical.kind !== "accepted") throw new TypeError("invalid moderation fixture");
        return Effect.succeed({
          provider_id: "openai",
          requested_model: "omni-moderation-2024-09-26",
          returned_model: "omni-moderation-2024-09-26",
          input_sha256: canonical.sha256,
          matched_categories: controls.matchedCategories,
          inputs: [],
        });
      },
    },
    imageModeration: {
      evaluateImage: (input) =>
        controls.imageUnavailable
          ? Effect.die(new Error("image moderation unavailable"))
          : Effect.succeed({
              provider_id: "openai",
              requested_model: "omni-moderation-2024-09-26",
              returned_model: "omni-moderation-2024-09-26",
              input_sha256: input.sha256,
              matched_categories: controls.imageMatchedCategories,
              evidence: {
                input_sha256: input.sha256,
                categories: categoryBooleans,
                scores: categoryScores,
                applied_input_types: categoryInputTypes,
              },
            }),
    },
    transform: {
      probe: (input: MediaTransformProbeInput) => {
        events.push(`effect:probe:${input.binding.canonicalAudioSha256}`);
        return Effect.succeed({
          status: "completed",
          attempt: {
            version: "media-transform-attempt-v1",
            runtimeFence: input.attempt.runtimeFence,
            providerJobId: "probe-job",
          },
          context: {
            version: "media-transform-attempt-context-v1",
            operationId: input.binding.operationId,
            audioRevision: input.binding.audioRevision,
            analysisRevision: input.binding.analysisRevision,
            canonicalAudioSha256: input.binding.canonicalAudioSha256,
            requestId: input.binding.requestId,
            adapterRevision: "transform-v1",
          },
          probe: {
            version: "media-transform-probe-v1",
            durationMs: controls.durationMs,
            container: "mp3",
            mimeType: "audio/mpeg",
            tracks: [
              {
                kind: "audio",
                codec: "mp3",
                channels: 2,
                sampleRateHz: 44_100,
                bitrateBps: 192_000,
                bitrateMode: "constant",
              },
            ],
          },
        });
      },
      extractAudioSample: (input: MediaTransformAudioSampleInput) => {
        events.push(`effect:sample:${input.variant}`);
        return Effect.succeed({
          status: "completed",
          attempt: {
            version: "media-transform-attempt-v1",
            runtimeFence: input.attempt.runtimeFence,
            providerJobId: `sample-${input.variant}`,
          },
          context: {
            version: "media-transform-attempt-context-v1",
            operationId: input.binding.operationId,
            audioRevision: input.binding.audioRevision,
            analysisRevision: input.binding.analysisRevision,
            canonicalAudioSha256: input.binding.canonicalAudioSha256,
            requestId: input.binding.requestId,
            adapterRevision: "transform-v1",
          },
          artifact: {
            version: "media-transform-sample-artifact-v1",
            objectKey: `sample/${input.variant}`,
            contentType: "audio/mpeg",
            byteLength: 4,
            offsetMs: input.variant === "primary" ? 42_000 : 126_000,
            durationMs: 12_000,
            variant: input.variant,
            retainedObjectVerification: "required",
          },
        });
      },
      extractCanonicalAudioSegment: (input) =>
        Effect.succeed({ status: "unavailable", reason: "disabled", binding: input.binding }),
      alignVideoSoundtrackToSong: (input) =>
        Effect.succeed({ status: "unavailable", reason: "disabled", binding: input.binding }),
      cancelAssembly: () => Effect.succeed({ status: "unavailable", reason: "disabled" }),
    },
    artifactReader: {
      readAudioSample: async (objectKey) => {
        events.push(`effect:read:${objectKey}`);
        return new Uint8Array([1, 2, 3, 4]);
      },
      readCoverArtifact: async (artifact) => {
        events.push(`effect:read-cover:${artifact.artifactRef}`);
        return new Uint8Array([5, 6, 7, 8]);
      },
    },
    identification: {
      identify: (input: MediaIdentificationRequest) => {
        events.push(`effect:acr:${input.sample.filename}`);
        const selected = controls.acr[acrIndex] ?? controls.acr.at(-1) ?? "failure";
        acrIndex += 1;
        const context = {
          version: "media-identification-attempt-context-v1" as const,
          operationId: input.operationId,
          audioRevision: input.audioRevision,
          analysisRevision: input.analysisRevision,
          canonicalAudioSha256: input.canonicalAudioSha256,
          requestId: input.requestId,
          adapterRevision: "acr-v1",
        };
        if (selected === "match") {
          return Effect.succeed({
            context,
            outcome: "retained_reference_match",
            evidence: {
              version: "media-identification-match-evidence-v1",
              provider: "acrcloud",
              matchKind: "music",
              providerMatchId: "match-1",
              title: "retained title",
              artists: ["retained artist"],
              score: 99,
            },
          });
        }
        if (selected === "fingerprint")
          return Effect.succeed({ context, outcome: "inconclusive_fingerprint" });
        if (selected === "failure")
          return Effect.succeed({ context, outcome: "retryable_failure", reason: "provider" });
        return Effect.succeed({ context, outcome: "no_match" });
      },
    },
    metadata: {
      extract: async (input) => {
        events.push(`effect:metadata:${input.operationId}`);
        return {
          evidenceRef: "metadata-evidence-1",
          adapterRevision: "metadata-v1",
          trackTitle: "embedded title",
          cover: controls.cover,
        };
      },
    },
    classifier: {
      classify: (input: MediaExplicitnessClassifierInput) => {
        controls.onClassifierInput?.(input);
        events.push(`effect:classifier:l${input.accepted_lyrics.lyrics_revision}`);
        return Effect.succeed({
          version: "media-explicitness-classifier-result-v1",
          status: "classified",
          explicitness: controls.explicitness,
          primary_language_bcp47: "en",
          secondary_language_bcp47: null,
          confidence: { explicitness: 0.98, primary_language: 0.97, secondary_language: null },
          evidence: [
            { kind: "explicitness", confidence: 0.98 },
            { kind: "primary_language", confidence: 0.97 },
          ],
          lyrics_identity: {
            operation_id: input.accepted_lyrics.operation_id,
            audio_revision: input.accepted_lyrics.audio_revision,
            lyrics_revision: input.accepted_lyrics.lyrics_revision,
            canonical_audio_sha256: input.accepted_lyrics.canonical_audio_sha256,
          },
          attempt_id: input.attempt.attempt_id,
          policy_revision: "classifier-policy-v1",
          prompt_revision: "classifier-prompt-v1",
          classifier_revision: "classifier-model-v1",
          adapter_revision: "classifier-adapter-v1",
        });
      },
    },
    alignment: {
      align: async (input) => {
        events.push(`effect:alignment:l${input.lyricsRevision}:${input.lyrics}`);
        return {
          status: "ready",
          artifactRef: `alignment-l${input.lyricsRevision}`,
          artifactSha256: "b".repeat(64),
          artifact: { version: "timed-lyrics-v1", timings: [] },
        };
      },
    },
  };
}

test("song moderation raises the durable rating for an adult category", async () => {
  const store = new FakeStore(authority({ lyrics: null }));
  store.communityDecisions.set("sexual", "permit");
  const result = await runMediaProcessingWorkflow(
    workflowPayload(store),
    "analysis_launch",
    dependencies(store, providers([], { matchedCategories: ["sexual"] })),
  );
  expect(result).toEqual({ outcome: "published_without_alignment" });
  expect(store.current.analysis?.contentModeration).toMatchObject({
    decision: "allow",
    resultingContentRating: "adult_18",
    matchedCategories: ["sexual"],
  });
  expect(store.current.decision?.contentRating).toBe("adult_18");
});

test("publishes a song with OpenAI-cleared general-audience artwork", async () => {
  const store = new FakeStore(authority({ lyrics: null }));
  const result = await runMediaProcessingWorkflow(
    workflowPayload(store),
    "analysis_launch",
    dependencies(
      store,
      providers([], {
        cover: {
          status: "ready",
          artifactRef: "restricted-cover-1",
          artifactSha256: "b".repeat(64),
          mediaType: "image/jpeg",
          width: 1200,
          height: 1200,
          normalizationRevision: "cover-normalization-v1",
          safetyPolicyRevision: "visual-provider-pending-v1",
        },
      }),
    ),
  );

  expect(result).toEqual({ outcome: "published_without_alignment" });
  expect(store.current.analysis?.mediaSafety).toBe("allow");
  expect(store.current.analysis?.coverModeration).toMatchObject({
    decision: "allow",
    reason: "clean",
    providerId: "openai",
  });
  expect(store.current.decision?.outcome).toBe("allow");
});

test("withholds flagged artwork without blocking the song", async () => {
  const store = new FakeStore(authority({ lyrics: null }));
  const result = await runMediaProcessingWorkflow(
    workflowPayload(store),
    "analysis_launch",
    dependencies(
      store,
      providers([], {
        imageMatchedCategories: ["sexual"],
        cover: {
          status: "ready",
          artifactRef: "restricted-cover-2",
          artifactSha256: "c".repeat(64),
          mediaType: "image/webp",
          width: 1200,
          height: 1200,
          normalizationRevision: "cover-normalization-v1",
          safetyPolicyRevision: "openai-cover-general-audience-v1",
        },
      }),
    ),
  );

  expect(result).toEqual({ outcome: "published_without_alignment" });
  expect(store.current.analysis?.mediaSafety).toBe("cover_withheld");
  expect(store.current.analysis?.coverModeration).toMatchObject({
    decision: "withheld",
    reason: "matched_category",
    matchedCategories: ["sexual"],
  });
  expect(store.current.decision?.outcome).toBe("allow");
});

test("withholds artwork on provider failure without blocking the song", async () => {
  const store = new FakeStore(authority({ lyrics: null }));
  const result = await runMediaProcessingWorkflow(
    workflowPayload(store),
    "analysis_launch",
    dependencies(
      store,
      providers([], {
        imageUnavailable: true,
        cover: {
          status: "ready",
          artifactRef: "restricted-cover-3",
          artifactSha256: "d".repeat(64),
          mediaType: "image/webp",
          width: 1200,
          height: 1200,
          normalizationRevision: "cover-normalization-v1",
          safetyPolicyRevision: "openai-cover-general-audience-v1",
        },
      }),
    ),
  );

  expect(result).toEqual({ outcome: "published_without_alignment" });
  expect(store.current.analysis?.mediaSafety).toBe("cover_withheld");
  expect(store.current.analysis?.coverModeration).toMatchObject({
    decision: "withheld",
    reason: "provider_unavailable",
    matchedCategories: [],
  });
  expect(store.current.decision?.outcome).toBe("allow");
});

function dependencies(store: FakeStore, provider: MediaProcessingProviders | null) {
  return {
    store,
    providers: provider,
    options: {
      enabled: true,
      workerId: "processor-1",
      now: () => 1_000,
      policyRevision: "processor-policy-v1",
      transformAdapterRevision: "transform-v1",
      metadataAdapterRevision: "metadata-v1",
      classifierTimeoutMs: 10_000,
      transformRuntimeMs: 60_000,
      maximumSampleBytes: 1_000_000,
    },
  } as const;
}

const workflowPayload = (store: FakeStore) => ({
  outboxId: "outbox-1",
  submissionId: store.current.submissionId,
  operationId: store.current.operationId,
  workflowRevision: store.current.workflowRevision,
});

describe("media processing workflow", () => {
  test("persists and resumes a submitted Transloadit assembly before downstream effects", async () => {
    const store = new FakeStore(authority({ lyrics: null }));
    const providerEvents: string[] = [];
    const base = providers(providerEvents);
    let polls = 0;
    const provider: MediaProcessingProviders = {
      ...base,
      transform: {
        ...base.transform,
        probe: (input) => {
          polls += 1;
          if (polls === 1) {
            return Effect.succeed({
              status: "submitted",
              attempt: {
                version: "media-transform-attempt-v1",
                runtimeFence: input.attempt.runtimeFence,
                providerJobId: "durable-probe-assembly",
              },
            });
          }
          expect(input.attempt.providerJobId).toBe("durable-probe-assembly");
          return base.transform.probe(input);
        },
      },
    };

    expect(
      await runMediaProcessingWorkflow(
        workflowPayload(store),
        "analysis_launch",
        dependencies(store, provider),
      ),
    ).toEqual({ outcome: "waiting_for_provider" });
    expect(store.events).toContain("defer:probe");
    expect(
      await runMediaProcessingWorkflow(
        workflowPayload(store),
        "analysis_launch",
        dependencies(store, provider),
      ),
    ).toEqual({ outcome: "published_without_alignment" });
    expect(polls).toBe(2);
  });

  test("runs the terms-first fake-transport golden vertical and consumes the sealed hash", async () => {
    const store = new FakeStore();
    const providerEvents = store.events;
    const classifierInputs: MediaExplicitnessClassifierInput[] = [];
    const result = await runMediaProcessingWorkflow(
      workflowPayload(store),
      "analysis_launch",
      dependencies(
        store,
        providers(providerEvents, { onClassifierInput: (input) => classifierInputs.push(input) }),
      ),
    );

    expect(result).toEqual({ outcome: "published" });
    expect(store.publications).toBe(1);
    expect(store.alignmentLaunches).toBe(1);
    expect(store.current.publishedLyricsRevision).toBe(1);
    expect(store.current.analysis?.canonicalAudioSha256).toBe(hash);
    expect(store.events.indexOf(`persist:probe:${hash}`)).toBeLessThan(
      providerEvents.indexOf(`effect:probe:${hash}`),
    );
    for (const stage of ["probe", "sample_primary", "acr_primary", "classifier"] as const) {
      expect(store.events).toContain(`persist:${stage}:${hash}`);
    }
    expect(classifierInputs).toHaveLength(1);
    expect(Object.keys(classifierInputs[0] ?? {}).sort()).toEqual([
      "accepted_lyrics",
      "attempt",
      "version",
    ]);
    expect(classifierInputs[0]?.accepted_lyrics.lyrics).toBe("accepted lyrics");
  });

  test("analysis-first waits only for terms and publishes without lyrics", async () => {
    const store = new FakeStore(authority({ termsRevision: null, lyrics: null }));
    const providerEvents: string[] = [];
    const provider = providers(providerEvents);
    const first = await runMediaProcessingWorkflow(
      workflowPayload(store),
      "analysis_launch",
      dependencies(store, provider),
    );
    expect(first).toEqual({ outcome: "waiting_for_terms" });
    expect(providerEvents.filter((event) => event.startsWith("effect:classifier"))).toHaveLength(0);

    store.current = {
      ...store.current,
      creationRevision: 4,
      termsRevision: 4,
      lyrics: {
        lyricsRevision: 1,
        audioRevision: 1,
        canonicalAudioSha256: hash,
        text: "later accepted lyrics",
      },
    };
    const decisionOutbox = store.outboxes.get("outbox-1");
    if (decisionOutbox === undefined) throw new TypeError("decision outbox fixture is missing");
    store.outboxes.set("outbox-1", {
      ...decisionOutbox,
      eventType: "decision_wakeup",
    });
    const second = await runMediaProcessingWorkflow(
      workflowPayload(store),
      "decision_wakeup",
      dependencies(store, provider),
    );
    const replay = await runMediaProcessingWorkflow(
      workflowPayload(store),
      "decision_wakeup",
      dependencies(store, provider),
    );
    expect(second).toEqual({ outcome: "published" });
    expect(replay).toEqual({ outcome: "inert" });
    expect(store.publications).toBe(1);
    expect(store.alignmentLaunches).toBe(1);
    expect(providerEvents.filter((event) => event.startsWith("effect:classifier"))).toHaveLength(1);
  });

  test("corrected accepted lyrics get a new fenced classifier attempt", async () => {
    const store = new FakeStore();
    const providerEvents: string[] = [];
    const provider = providers(providerEvents);
    await runMediaProcessingWorkflow(
      workflowPayload(store),
      "analysis_launch",
      dependencies(store, provider),
    );
    store.current = {
      ...store.current,
      status: "processing",
      phase: "decision",
      creationRevision: 4,
      lyrics: {
        lyricsRevision: 2,
        audioRevision: 1,
        canonicalAudioSha256: hash,
        text: hostileCorrectedLyrics,
      },
      decision: null,
    };
    const prior = store.outboxes.get("outbox-1");
    if (prior === undefined) throw new TypeError("lyrics wakeup outbox fixture is missing");
    store.outboxes.set("outbox-1", { ...prior, eventType: "decision_wakeup" });

    await runMediaProcessingWorkflow(
      workflowPayload(store),
      "decision_wakeup",
      dependencies(store, provider),
    );
    expect(store.current.analysis?.lyricsAnalysis).toMatchObject({
      status: "ready",
      lyricsRevision: 2,
    });
    expect([...store.attempts.keys()]).toContain("media-attempt-operation-1-a1-n1-classifier-l2");
    expect(providerEvents.filter((event) => event === "effect:classifier:l2")).toHaveLength(1);
  });

  test("stale audio-bound lyrics never reach the classifier", async () => {
    const store = new FakeStore(
      authority({
        lyrics: {
          lyricsRevision: 2,
          audioRevision: 1,
          canonicalAudioSha256: "b".repeat(64),
          text: "stale pasted lyrics",
        },
      }),
    );
    const providerEvents: string[] = [];
    expect(
      await runMediaProcessingWorkflow(
        workflowPayload(store),
        "analysis_launch",
        dependencies(store, providers(providerEvents)),
      ),
    ).toEqual({ outcome: "processing_failed" });
    expect(providerEvents.some((event) => event.startsWith("effect:classifier"))).toBe(false);
    expect(store.current.decision).toBeNull();
  });

  test("missing lyrics bypass classification and alignment but still publishes", async () => {
    const store = new FakeStore(authority({ lyrics: null }));
    const providerEvents: string[] = [];
    const result = await runMediaProcessingWorkflow(
      workflowPayload(store),
      "analysis_launch",
      dependencies(store, providers(providerEvents)),
    );
    expect(result).toEqual({ outcome: "published_without_alignment" });
    expect(providerEvents.some((event) => event.startsWith("effect:classifier"))).toBe(false);
    expect(store.current.publishedLyricsRevision).toBeNull();
    expect(store.alignmentLaunches).toBe(0);
    expect(store.current.analysis?.lyricsAnalysis).toEqual({ status: "not_applicable" });
  });

  test("duration rejection stops before sample, ACR, classification, and publication", async () => {
    const store = new FakeStore();
    const providerEvents: string[] = [];
    const result = await runMediaProcessingWorkflow(
      workflowPayload(store),
      "analysis_launch",
      dependencies(store, providers(providerEvents, { durationMs: 3_600_001 })),
    );
    expect(result).toEqual({ outcome: "processing_failed" });
    expect(providerEvents).toEqual([`effect:probe:${hash}`]);
    expect(store.publications).toBe(0);
  });

  test("trusted probing rejects a non-MP3 before sampling or identification", async () => {
    const store = new FakeStore();
    const providerEvents: string[] = [];
    const base = providers(providerEvents);
    const provider: MediaProcessingProviders = {
      ...base,
      transform: {
        ...base.transform,
        probe: (input) =>
          base.transform.probe(input).pipe(
            Effect.map((outcome) =>
              outcome.status === "completed"
                ? {
                    ...outcome,
                    probe: {
                      ...outcome.probe,
                      container: "wav" as const,
                      mimeType: "audio/wav",
                      tracks: [{ ...outcome.probe.tracks[0], codec: "pcm" as const }] as const,
                    },
                  }
                : outcome,
            ),
          ),
      },
    };
    const result = await runMediaProcessingWorkflow(
      workflowPayload(store),
      "analysis_launch",
      dependencies(store, provider),
    );
    expect(result).toEqual({ outcome: "processing_failed" });
    expect(providerEvents).toEqual([`effect:probe:${hash}`]);
    expect(store.publications).toBe(0);
  });

  test("one alternate fingerprint attempt ends inconclusive in manual review", async () => {
    const store = new FakeStore();
    const providerEvents: string[] = [];
    const result = await runMediaProcessingWorkflow(
      workflowPayload(store),
      "analysis_launch",
      dependencies(store, providers(providerEvents, { acr: ["fingerprint", "fingerprint"] })),
    );
    expect(result).toEqual({ outcome: "manual_review" });
    expect(providerEvents.filter((event) => event.startsWith("effect:acr"))).toEqual([
      "effect:acr:primary.mp3",
      "effect:acr:alternate.mp3",
    ]);
    expect(store.publications).toBe(0);
  });

  test("retained ACR match and remix no-match both require a reference", async () => {
    for (const [songType, acr] of [
      ["original", ["match"]],
      ["remix", ["no_match", "no_match"]],
    ] as const) {
      const store = new FakeStore(authority({ songType }));
      const result = await runMediaProcessingWorkflow(
        workflowPayload(store),
        "analysis_launch",
        dependencies(store, providers([], { acr: [...acr] })),
      );
      expect(result).toEqual({ outcome: "action_required" });
      expect(store.publications).toBe(0);
    }
  });

  test("explicit lyrics publish truthfully while uncertain classification enters review", async () => {
    const explicitStore = new FakeStore();
    expect(
      await runMediaProcessingWorkflow(
        workflowPayload(explicitStore),
        "analysis_launch",
        dependencies(explicitStore, providers([], { explicitness: "explicit" })),
      ),
    ).toEqual({ outcome: "published" });
    expect(explicitStore.current.analysis?.lyricsAnalysis.status).toBe("ready");
    if (explicitStore.current.analysis?.lyricsAnalysis.status === "ready") {
      expect(explicitStore.current.analysis.lyricsAnalysis.explicitness).toBe("explicit");
    }

    const mismatchStore = new FakeStore();
    expect(
      await runMediaProcessingWorkflow(
        workflowPayload(mismatchStore),
        "analysis_launch",
        dependencies(mismatchStore, providers([], { explicitness: "uncertain" })),
      ),
    ).toEqual({ outcome: "manual_review" });
    expect(mismatchStore.publications).toBe(0);
  });

  test("moderator approval produces one publication and one alignment launch", async () => {
    const store = new FakeStore();
    const provider = providers([], { explicitness: "uncertain" });
    expect(
      await runMediaProcessingWorkflow(
        workflowPayload(store),
        "analysis_launch",
        dependencies(store, provider),
      ),
    ).toEqual({ outcome: "manual_review" });
    store.current = { ...store.current, status: "processing", phase: "publish" };
    const outbox = store.outboxes.get("outbox-1");
    if (outbox === undefined) throw new TypeError("publication outbox fixture is missing");
    store.outboxes.set("outbox-1", { ...outbox, eventType: "publication" });

    expect(
      await runMediaProcessingWorkflow(
        workflowPayload(store),
        "publication",
        dependencies(store, provider),
      ),
    ).toEqual({ outcome: "published" });
    expect(
      await runMediaProcessingWorkflow(
        workflowPayload(store),
        "publication",
        dependencies(store, provider),
      ),
    ).toEqual({ outcome: "published" });
    expect(store.publications).toBe(1);
    expect(store.alignmentLaunches).toBe(1);
  });

  test("disabled or missing provider composition fails closed without effects", async () => {
    const store = new FakeStore();
    const deps = dependencies(store, null);
    const result = await runMediaProcessingWorkflow(
      workflowPayload(store),
      "analysis_launch",
      deps,
    );
    expect(result).toEqual({ outcome: "manual_review" });
    expect(store.providerReviews).toBe(1);
    expect(store.attempts.size).toBe(0);
  });

  test("late wakeups and stale workflow revisions are inert", async () => {
    const store = new FakeStore(authority({ status: "abandoned", phase: null }));
    const wakeupOutbox = store.outboxes.get("outbox-1");
    if (wakeupOutbox === undefined) throw new TypeError("wakeup outbox fixture is missing");
    store.outboxes.set("outbox-1", {
      ...wakeupOutbox,
      eventType: "decision_wakeup",
    });
    expect(
      await runMediaProcessingWorkflow(
        workflowPayload(store),
        "decision_wakeup",
        dependencies(store, providers([])),
      ),
    ).toEqual({ outcome: "inert" });
    expect(store.attempts.size).toBe(0);

    store.current = { ...store.current, workflowRevision: 2 };
    expect(
      await runMediaProcessingWorkflow(
        { ...workflowPayload(store), workflowRevision: 1 },
        "decision_wakeup",
        dependencies(store, providers([])),
      ),
    ).toEqual({ outcome: "inert" });
  });

  test("alignment consumes the exact published lyrics revision once", async () => {
    const store = new FakeStore();
    const providerEvents: string[] = [];
    const provider = providers(providerEvents);
    await runMediaProcessingWorkflow(
      workflowPayload(store),
      "analysis_launch",
      dependencies(store, provider),
    );
    const alignmentOutbox = store.outboxes.get("outbox-1");
    if (alignmentOutbox === undefined) throw new TypeError("alignment outbox fixture is missing");
    store.outboxes.set("outbox-1", {
      ...alignmentOutbox,
      eventType: "alignment",
    });
    const aligned = await runMediaProcessingWorkflow(
      workflowPayload(store),
      "alignment",
      dependencies(store, provider),
    );
    const replay = await runMediaProcessingWorkflow(
      workflowPayload(store),
      "alignment",
      dependencies(store, provider),
    );
    expect(aligned).toEqual({ outcome: "alignment_recorded" });
    expect(replay).toEqual({ outcome: "alignment_recorded" });
    expect(store.alignments).toBe(1);
    expect(providerEvents.filter((event) => event.startsWith("effect:alignment"))).toEqual([
      "effect:alignment:l1:accepted lyrics",
    ]);
  });

  test("alignment provider failures retry without changing published product state", async () => {
    const store = new FakeStore(
      authority({
        status: "published",
        phase: null,
        postId: "media-post-operation-1",
        publishedLyricsRevision: 1,
      }),
      "alignment",
    );
    const base = providers([]);
    const provider: MediaProcessingProviders = {
      ...base,
      alignment: { align: async () => Promise.reject(new Error("provider unavailable")) },
    };

    expect(
      await runMediaProcessingWorkflow(
        workflowPayload(store),
        "alignment",
        dependencies(store, provider),
      ),
    ).toEqual({ outcome: "waiting_for_provider" });
    expect(store.events).toContain("fail:alignment");
    expect(store.current.status).toBe("published");
    expect(store.providerReviews).toBe(0);
    expect(store.alignments).toBe(0);
  });

  test("transient alignment outcomes enter the durable retry ledger", async () => {
    const store = new FakeStore(
      authority({
        status: "published",
        phase: null,
        postId: "media-post-operation-1",
        publishedLyricsRevision: 1,
      }),
      "alignment",
    );
    const base = providers([]);
    const provider: MediaProcessingProviders = {
      ...base,
      alignment: {
        align: async () => ({ status: "unavailable", failureCode: "provider_unavailable" }),
      },
    };

    expect(
      await runMediaProcessingWorkflow(
        workflowPayload(store),
        "alignment",
        dependencies(store, provider),
      ),
    ).toEqual({ outcome: "waiting_for_provider" });
    expect(store.events).toContain("fail:alignment");
    expect(store.current.status).toBe("published");
    expect(store.providerReviews).toBe(0);
    expect(store.alignments).toBe(0);
  });

  test("alignment exhaustion records unavailable without reopening published moderation", async () => {
    class AlignmentExhaustedStore extends FakeStore {
      override startAttempt: MediaProcessingStore["startAttempt"] = async () => ({
        kind: "exhausted",
      });
    }
    const store = new AlignmentExhaustedStore(
      authority({
        status: "published",
        phase: null,
        postId: "media-post-operation-1",
        publishedLyricsRevision: 1,
      }),
      "alignment",
    );

    expect(
      await runMediaProcessingWorkflow(
        workflowPayload(store),
        "alignment",
        dependencies(store, providers([])),
      ),
    ).toEqual({ outcome: "alignment_recorded" });
    expect(store.alignmentResults).toEqual([
      { kind: "alignment", status: "unavailable", failureCode: "provider_unavailable" },
    ]);
    expect(store.current.status).toBe("published");
    expect(store.providerReviews).toBe(0);
  });

  test("stale attempt completion is fenced", async () => {
    const store = new FakeStore();
    const first = await store.startAttempt({
      authority: store.current,
      stage: "probe",
      attemptId: "attempt-1",
      workerId: "worker-1",
      inputRevision: 1,
      inputHash: hash,
      policyRevision: "policy-v1",
      adapterRevision: "adapter-v1",
    });
    expect(first.kind).toBe("run");
    if (first.kind !== "run") return;
    store.attempts.set("attempt-1", {
      lease: { ...first.lease, claimOwner: "worker-2", claimFence: 2 },
    });
    expect(
      await store.completeAttempt(first.lease, {
        kind: "probe",
        value: {
          status: "unavailable",
          reason: "disabled",
          attempt: {
            version: "media-transform-attempt-v1",
            runtimeFence: { submittedAtMs: 1, runtimeDeadlineMs: 2 },
          },
        },
      }),
    ).toBe(false);
  });
});

import type { MediaProcessingProviders } from "@pirate/application/media/processing-contracts";
import type {
  MediaTransformProbeInput,
  MediaTransformService,
  MediaTransformVideoCapabilities,
  MediaTransformVideoProbeInput,
} from "@pirate/application/media/transform";
import type { VideoAnalysisProviders } from "@pirate/application/video/analysis";
import { isExplicitlyEnabled } from "@pirate/platform-cf/cloudflare-orchestration-primitives";
import { mediaProcessingPhysicalObjectKey } from "@pirate/platform-cf/media-immutable-object-key";
import {
  type CloudflareMediaWorkflowBinding,
  makeCloudflareMediaProcessingWorkflowLauncher,
} from "@pirate/platform-cf/media-processing-cloudflare";
import {
  MEDIA_MP3_SAMPLE_ADAPTER_REVISION,
  type MediaProcessingFetch,
  makeAcrCloudFetchTransport,
  makeElevenLabsAlignmentFetchTransport,
  makeElevenLabsProcessingAlignmentPort,
  makeOpenRouterFetchTransport,
  makeR2EmbeddedMetadataPort,
  makeR2MediaProcessingArtifactReader,
  makeR2Mp3SampleMediaTransform,
} from "@pirate/platform-cf/media-processing-runtime";
import { makeMediaProcessingStore } from "@pirate/platform-cf/media-processing-store";
import { makeAcrCloudAdapter } from "@pirate/platform-cf/media-providers/acrcloud";
import { ElevenLabsAlignmentAdapter } from "@pirate/platform-cf/media-providers/elevenlabs-alignment";
import { makeOpenRouterClassifierAdapter } from "@pirate/platform-cf/media-providers/openrouter";
import { disabledMediaTransform } from "@pirate/platform-cf/media-transform";
import {
  makeOpenAiTextModerationProvider,
  type OpenAiModerationTransport,
} from "@pirate/platform-cf/openai-text-moderation";
import {
  CONTROL_PLANE_HYPERDRIVE_SEARCH_PATH,
  makeHyperdriveControlPlaneLayer,
} from "@pirate/platform-cf/postgres";
import {
  makeQencodeMediaTransform,
  makeQencodeTaskTransport,
  makeR2QencodeArtifactStore,
  type QencodeArtifactStore,
  type QencodeSourceGrantIssuer,
  type QencodeTaskTransport,
} from "@pirate/platform-cf/qencode-media-transform";
import { makeSongSourceAcrCloudCatalog } from "@pirate/platform-cf/song-source-acrcloud-catalog";
import { makeSongSourceRecordingR2Reader } from "@pirate/platform-cf/song-source-recording-r2";
import { makeSongSourceRecordingRepository } from "@pirate/platform-cf/song-source-recording-repository";
import { makeR2SongVideoOutputStore } from "@pirate/platform-cf/song-video-master-store";
import { makeWorkerSongVideoRenderServices } from "@pirate/platform-cf/song-video-worker-render";
import { makeControlPlaneVideoAnalysisOutboxRepository } from "@pirate/platform-cf/video-analysis-outbox-repository";
import {
  makeConfiguredVideoAnalysisWorkflowLauncher,
  type VideoAnalysisWorkflowBinding,
  type VideoWorkflowStatusFetch,
} from "@pirate/platform-cf/video-analysis-workflow-cloudflare";
import { makeControlPlaneVideoPublicationStore } from "@pirate/platform-cf/video-publication-repository";
import { makeVideoRecognitionProvider } from "@pirate/platform-cf/video-recognition-provider";
import { makeVideoSafetyEvidenceStore } from "@pirate/platform-cf/video-safety-evidence-repository";
import { makeVideoSafetyFrameReader } from "@pirate/platform-cf/video-safety-frame-reader";
import { makeVideoSafetyProvider } from "@pirate/platform-cf/video-safety-provider";
import { makeVideoSealedSourceVerifier } from "@pirate/platform-cf/video-sealed-source-verifier";
import { makeVideoSourceGrantIssuer } from "@pirate/platform-cf/video-source-grant-issuer";
import { makeVideoStageArtifactHead } from "@pirate/platform-cf/video-stage-artifact-head";
import { makeControlPlaneVideoStageFactStore } from "@pirate/platform-cf/video-stage-fact-repository";
import { Effect } from "effect";
import type { MediaProcessorComposition, MediaProcessorWorkerEnv } from "./index.ts";
import { makeVideoDeliveryComposition } from "./video-delivery-composition.ts";

export { mediaProcessingPhysicalObjectKey } from "@pirate/platform-cf/media-immutable-object-key";

const MAXIMUM_AUDIO_BYTES = 64 * 1024 * 1024;

export type MediaProcessorRuntimeEnv = MediaProcessorWorkerEnv &
  Readonly<{
    readonly CONTROL_PLANE?: Readonly<{ readonly connectionString: string }>;
    readonly MEDIA_PROCESSING_WORKFLOW?: CloudflareMediaWorkflowBinding;
    readonly MEDIA_IMMUTABLE_ORIGINALS?: R2Bucket;
    readonly MEDIA_DERIVED_ARTIFACTS?: R2Bucket;
    readonly IMAGE_TRANSFORMATIONS?: ImagesBinding;
    readonly ACRCLOUD_IDENTIFY_HOST?: string;
    readonly ACRCLOUD_ACCESS_KEY?: string;
    readonly ACRCLOUD_ACCESS_SECRET?: string;
    readonly ACRCLOUD_CONSOLE_ORIGIN?: string;
    readonly ACRCLOUD_CONSOLE_TOKEN?: string;
    readonly ACRCLOUD_SOURCE_BUCKET_ID?: string;
    readonly SONG_SOURCE_RECORDING_ENABLED?: string;
    readonly ELEVENLABS_API_KEY?: string;
    readonly OPENAI_API_KEY?: string;
    readonly OPENAI_MODERATION_ENABLED?: string;
    readonly OPENROUTER_API_KEY?: string;
    readonly QENCODE_API_KEY?: string;
    readonly VIDEO_SOURCE_GATEWAY_ORIGIN?: string;
    readonly DATA_REGISTRATION_ENABLED?: string;
    readonly DATA_REGISTRATION_CHAIN_ID?: string;
    readonly VIDEO_ANALYSIS_ENABLED?: string;
    readonly VIDEO_DELIVERY_ENABLED?: string;
    readonly VIDEO_STREAM_API_TOKEN?: string;
    readonly VIDEO_ANALYSIS_WORKFLOW?: VideoAnalysisWorkflowBinding;
    readonly VIDEO_WORKFLOW_ACCOUNT_ID?: string;
    readonly VIDEO_WORKFLOW_NAME?: string;
    readonly VIDEO_WORKFLOW_SCRIPT_NAME?: string;
    readonly VIDEO_WORKFLOW_READ_TOKEN?: string;
  }>;

export type MediaProcessorRuntimeAdapters = Readonly<{
  readonly videoAnalysis?: Readonly<{
    readonly providers?: Partial<VideoAnalysisProviders>;
    readonly moderationTransport?: OpenAiModerationTransport;
    readonly recognitionFetch?: MediaProcessingFetch;
    readonly workflowFetch?: VideoWorkflowStatusFetch;
    readonly transform?: MediaTransformVideoCapabilities;
    readonly qencode?: Readonly<{
      readonly sourceGateway?: QencodeSourceGrantIssuer;
      readonly transport?: QencodeTaskTransport;
      readonly artifacts?: QencodeArtifactStore;
    }>;
  }>;
}>;

function requiredText(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required when media processing is enabled`);
  }
  return value;
}

function requiredOperationalSecret(value: string | undefined, name: string): string {
  const secret = requiredText(value, name);
  if (secret === "PENDING") throw new Error(`${name} is pending provisioning`);
  return secret;
}

function requiredBinding<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} binding is required`);
  return value;
}

function bindPhysicalR2Keys(transform: MediaTransformService): MediaTransformService {
  return {
    probe: ((input: MediaTransformProbeInput | MediaTransformVideoProbeInput) =>
      input.version === "media-transform-video-probe-input-v1"
        ? Effect.suspend(() =>
            transform.probe({
              ...input,
              source: {
                ...input.source,
                objectKey: mediaProcessingPhysicalObjectKey(input.source.objectKey),
              },
            }),
          )
        : Effect.suspend(() =>
            transform.probe({
              ...input,
              source: { objectKey: mediaProcessingPhysicalObjectKey(input.source.objectKey) },
            }),
          )) as MediaTransformService["probe"],
    extractAudioSample: (input) =>
      Effect.suspend(() =>
        transform.extractAudioSample({
          ...input,
          source: { objectKey: mediaProcessingPhysicalObjectKey(input.source.objectKey) },
        }),
      ),
    extractVideoAudio: (input) =>
      Effect.suspend(() =>
        transform.extractVideoAudio({
          ...input,
          source: {
            ...input.source,
            objectKey: mediaProcessingPhysicalObjectKey(input.source.objectKey),
          },
        }),
      ),
    extractVideoFrames: (input) =>
      Effect.suspend(() =>
        transform.extractVideoFrames({
          ...input,
          source: {
            ...input.source,
            objectKey: mediaProcessingPhysicalObjectKey(input.source.objectKey),
          },
        }),
      ),
    extractCanonicalAudioSegment: (input) =>
      Effect.suspend(() =>
        transform.extractCanonicalAudioSegment({
          ...input,
          canonicalAudio: {
            ...input.canonicalAudio,
            objectKey: mediaProcessingPhysicalObjectKey(input.canonicalAudio.objectKey),
          },
        }),
      ),
    alignVideoSoundtrackToSong: (input) =>
      Effect.suspend(() =>
        transform.alignVideoSoundtrackToSong({
          ...input,
          video: {
            ...input.video,
            objectKey: mediaProcessingPhysicalObjectKey(input.video.objectKey),
          },
          songAudio: {
            ...input.songAudio,
            objectKey: mediaProcessingPhysicalObjectKey(input.songAudio.objectKey),
          },
        }),
      ),
    cancelJob: (input) => transform.cancelJob(input),
  };
}

function bindVideoPhysicalR2Keys(
  transform: MediaTransformVideoCapabilities,
): MediaTransformVideoCapabilities {
  const source = <A extends { readonly source: { readonly objectKey: string } }>(input: A): A => ({
    ...input,
    source: {
      ...input.source,
      objectKey: mediaProcessingPhysicalObjectKey(input.source.objectKey),
    },
  });
  return {
    allocate: (input) => Effect.suspend(() => transform.allocate(source(input))),
    submit: (input) => Effect.suspend(() => transform.submit(source(input))),
    observe: ((input) =>
      Effect.suspend(() =>
        transform.observe(source(input)),
      )) as MediaTransformVideoCapabilities["observe"],
    probe: (input) => Effect.suspend(() => transform.probe(source(input))),
    extractVideoAudio: (input) => Effect.suspend(() => transform.extractVideoAudio(source(input))),
    extractVideoFrames: (input) =>
      Effect.suspend(() => transform.extractVideoFrames(source(input))),
  };
}

function makeIdentification(env: MediaProcessorRuntimeEnv, fetcher?: MediaProcessingFetch) {
  const acrHost = requiredText(env.ACRCLOUD_IDENTIFY_HOST, "ACRCLOUD_IDENTIFY_HOST");
  return makeAcrCloudAdapter({
    host: acrHost,
    credentials: {
      accessKey: requiredText(env.ACRCLOUD_ACCESS_KEY, "ACRCLOUD_ACCESS_KEY"),
      accessSecret: requiredText(env.ACRCLOUD_ACCESS_SECRET, "ACRCLOUD_ACCESS_SECRET"),
    },
    transport: makeAcrCloudFetchTransport(acrHost, fetcher),
    clock: () => Math.floor(Date.now() / 1_000),
    adapterRevision: "acrcloud-adapter-v1",
    limits: {
      maxSampleBytes: 4_000_000,
      maxRequestBytes: 4_100_000,
      maxResponseBytes: 1_048_576,
      timeoutMs: 120_000,
    },
  });
}

function makeEnabledProviders(env: MediaProcessorRuntimeEnv): MediaProcessingProviders {
  const immutableOriginals = requiredBinding(
    env.MEDIA_IMMUTABLE_ORIGINALS,
    "MEDIA_IMMUTABLE_ORIGINALS",
  );
  const derivedArtifacts = requiredBinding(env.MEDIA_DERIVED_ARTIFACTS, "MEDIA_DERIVED_ARTIFACTS");
  const imageTransformations = requiredBinding(env.IMAGE_TRANSFORMATIONS, "IMAGE_TRANSFORMATIONS");
  const identification = makeIdentification(env);
  const alignmentAdapter = new ElevenLabsAlignmentAdapter({
    enabled: true,
    api_key: requiredText(env.ELEVENLABS_API_KEY, "ELEVENLABS_API_KEY"),
    transport: makeElevenLabsAlignmentFetchTransport(),
    limits: {
      max_audio_bytes: MAXIMUM_AUDIO_BYTES,
      max_transcript_bytes: 4_000_000,
      timeout_ms: 300_000,
      max_response_bytes: 5_000_000,
      max_timings: 100_000,
      max_timing_ms: 60 * 60 * 1_000,
    },
  });

  const transform = makeR2Mp3SampleMediaTransform({
    providerTransform: disabledMediaTransform,
    immutableOriginals,
    derivedArtifacts,
    maximumSampleBytes: 4_000_000,
  });
  const openAiModeration = makeOpenAiTextModerationProvider({
    apiKey: requiredText(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
  });

  return {
    transform: bindPhysicalR2Keys(transform),
    identification,
    classifier: makeOpenRouterClassifierAdapter({
      enabled: true,
      api_key: requiredOperationalSecret(env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY"),
      model: "google/gemini-3.7-flash",
      prompt_revision: "lyrics-explicitness-language-prompt-v1",
      policy_revision: "lyrics-explicitness-language-policy-v2-openrouter-zdr",
      classifier_revision: "lyrics-explicitness-language-classifier-v2-gemini-3.7-flash",
      adapter_revision: "openrouter-classifier-adapter-v3-standard-zdr",
      provider_policy: {
        require_parameters: true,
        data_collection: "deny",
        zdr: true,
        allow_fallbacks: false,
        sort: "price",
        order: ["google-vertex"],
        only: ["google-vertex"],
        ignore: [],
      },
      account_plugins_disabled: true,
      transport: makeOpenRouterFetchTransport(),
    }),
    artifactReader: makeR2MediaProcessingArtifactReader(derivedArtifacts),
    metadata: makeR2EmbeddedMetadataPort(
      immutableOriginals,
      derivedArtifacts,
      imageTransformations,
    ),
    alignment: makeElevenLabsProcessingAlignmentPort(
      immutableOriginals,
      alignmentAdapter,
      MAXIMUM_AUDIO_BYTES,
    ),
    textModeration: openAiModeration,
    imageModeration: openAiModeration,
  };
}

const workflowIsNeverMissingByThrownError = (): boolean => false;

function videoTransform(
  env: MediaProcessorRuntimeEnv,
  runtime: ReturnType<typeof makeHyperdriveControlPlaneLayer>,
  adapters: NonNullable<MediaProcessorRuntimeAdapters["videoAnalysis"]>,
): MediaTransformVideoCapabilities {
  if (adapters.transform !== undefined) return adapters.transform;
  const apiKey = requiredOperationalSecret(env.QENCODE_API_KEY, "QENCODE_API_KEY");
  const artifacts =
    adapters.qencode?.artifacts ??
    makeR2QencodeArtifactStore(
      requiredBinding(env.MEDIA_DERIVED_ARTIFACTS, "MEDIA_DERIVED_ARTIFACTS"),
    );
  return makeQencodeMediaTransform({
    enabled: true,
    apiKey,
    transport: adapters.qencode?.transport ?? makeQencodeTaskTransport(),
    sourceGateway:
      adapters.qencode?.sourceGateway ??
      makeVideoSourceGrantIssuer(
        runtime,
        requiredText(env.VIDEO_SOURCE_GATEWAY_ORIGIN, "VIDEO_SOURCE_GATEWAY_ORIGIN"),
        "qencode",
      ),
    artifacts,
  });
}

export function makeMediaProcessorComposition(
  env: MediaProcessorRuntimeEnv,
  adapters: MediaProcessorRuntimeAdapters = {},
): MediaProcessorComposition {
  const controlPlane = requiredBinding(env.CONTROL_PLANE, "CONTROL_PLANE");
  const workflowBinding = requiredBinding(
    env.MEDIA_PROCESSING_WORKFLOW,
    "MEDIA_PROCESSING_WORKFLOW",
  );
  const runtime = makeHyperdriveControlPlaneLayer(controlPlane);
  const dataRegistrationEnabled = env.DATA_REGISTRATION_ENABLED === "true";
  const songSourceRecordingEnabled = env.SONG_SOURCE_RECORDING_ENABLED === "true";
  const songSourceCatalogBucketId = songSourceRecordingEnabled
    ? requiredText(env.ACRCLOUD_SOURCE_BUCKET_ID, "ACRCLOUD_SOURCE_BUCKET_ID")
    : undefined;
  const dataRegistrationChainId = dataRegistrationEnabled
    ? BigInt(requiredText(env.DATA_REGISTRATION_CHAIN_ID, "DATA_REGISTRATION_CHAIN_ID"))
    : undefined;
  if (dataRegistrationChainId !== undefined && dataRegistrationChainId !== 1315n) {
    throw new Error("only Aeneid DATA registration is authorized in staging");
  }
  const store = makeMediaProcessingStore(runtime, {
    ...(dataRegistrationChainId === undefined ? {} : { dataRegistrationChainId }),
    ...(songSourceCatalogBucketId === undefined ? {} : { songSourceCatalogBucketId }),
  });
  const workflow = makeCloudflareMediaProcessingWorkflowLauncher(
    workflowBinding,
    workflowIsNeverMissingByThrownError,
  );
  const enabled = isExplicitlyEnabled(env.MEDIA_PROCESSING_ENABLED);
  const workerId = `media-processor-${crypto.randomUUID()}`;
  const videoAnalysisEnabled = env.VIDEO_ANALYSIS_ENABLED === "true";
  const videoAnalysisRepository = videoAnalysisEnabled
    ? makeControlPlaneVideoAnalysisOutboxRepository(runtime)
    : undefined;
  const enabledVideoTransform = videoAnalysisEnabled
    ? videoTransform(env, runtime, adapters.videoAnalysis ?? {})
    : undefined;

  const videoModeration =
    videoAnalysisEnabled && env.OPENAI_MODERATION_ENABLED === "true"
      ? makeOpenAiTextModerationProvider({
          apiKey: requiredOperationalSecret(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
          ...(adapters.videoAnalysis?.moderationTransport === undefined
            ? {}
            : { transport: adapters.videoAnalysis.moderationTransport }),
        })
      : null;
  const videoProviders: VideoAnalysisProviders | undefined = videoAnalysisEnabled
    ? {
        identifySoundtrack:
          adapters.videoAnalysis?.providers?.identifySoundtrack ??
          makeVideoRecognitionProvider({
            identification: [
              env.ACRCLOUD_IDENTIFY_HOST,
              env.ACRCLOUD_ACCESS_KEY,
              env.ACRCLOUD_ACCESS_SECRET,
            ].every((value) => value !== undefined && value.trim() !== "" && value !== "PENDING")
              ? makeIdentification(env, adapters.videoAnalysis?.recognitionFetch)
              : null,
            reader: makeR2MediaProcessingArtifactReader(
              requiredBinding(env.MEDIA_DERIVED_ARTIFACTS, "MEDIA_DERIVED_ARTIFACTS"),
            ),
          }),
        moderate:
          adapters.videoAnalysis?.providers?.moderate ??
          makeVideoSafetyProvider({
            image: videoModeration,
            text: videoModeration,
            readFrame: makeVideoSafetyFrameReader(
              requiredBinding(env.MEDIA_DERIVED_ARTIFACTS, "MEDIA_DERIVED_ARTIFACTS"),
            ),
            readPolicy: store.readModerationPolicy,
            evidence: makeVideoSafetyEvidenceStore(runtime),
          }),
      }
    : undefined;
  if (videoAnalysisEnabled && env.VIDEO_ANALYSIS_WORKFLOW === undefined) {
    throw new Error("VIDEO_ANALYSIS_WORKFLOW is required when video analysis is enabled");
  }

  return {
    queue: { store, workflow, workerId },
    ...(songSourceRecordingEnabled && songSourceCatalogBucketId !== undefined
      ? {
          sourceRecording: {
            repository: makeSongSourceRecordingRepository(runtime),
            leaseSeconds: 300,
            workflow: {
              enabled: true,
              workerId,
              adapterRevision: "acrcloud-adapter-v1",
              catalog: makeSongSourceAcrCloudCatalog({
                origin: requiredText(env.ACRCLOUD_CONSOLE_ORIGIN, "ACRCLOUD_CONSOLE_ORIGIN"),
                bucketId: songSourceCatalogBucketId,
                token: requiredOperationalSecret(
                  env.ACRCLOUD_CONSOLE_TOKEN,
                  "ACRCLOUD_CONSOLE_TOKEN",
                ),
                maxResponseBytes: 1_048_576,
                maxAudioBytes: MAXIMUM_AUDIO_BYTES,
                request: async (request) => {
                  const response = await fetch(request.url, {
                    method: request.method,
                    headers: request.headers,
                    ...(request.body === undefined ? {} : { body: request.body }),
                    signal: request.signal,
                    redirect: request.redirect,
                  });
                  if (response.body === null) throw new TypeError("ACRCloud returned no body");
                  return { status: response.status, body: response.body };
                },
              }),
              audio: makeSongSourceRecordingR2Reader({
                immutableOriginals: requiredBinding(
                  env.MEDIA_IMMUTABLE_ORIGINALS,
                  "MEDIA_IMMUTABLE_ORIGINALS",
                ),
                derivedArtifacts: requiredBinding(
                  env.MEDIA_DERIVED_ARTIFACTS,
                  "MEDIA_DERIVED_ARTIFACTS",
                ),
                maximumCanonicalBytes: MAXIMUM_AUDIO_BYTES,
                maximumSampleBytes: 4_000_000,
              }),
              identification: makeIdentification(env),
            },
          },
        }
      : {}),
    ...makeVideoDeliveryComposition(env, runtime),
    ...(videoAnalysisRepository !== undefined &&
    enabledVideoTransform !== undefined &&
    videoProviders !== undefined &&
    env.VIDEO_ANALYSIS_WORKFLOW !== undefined
      ? {
          videoWorkflow: {
            store: makeControlPlaneVideoPublicationStore(runtime),
            reconciliation: makeControlPlaneVideoPublicationStore(runtime),
            outbox: videoAnalysisRepository,
            stageFacts: makeControlPlaneVideoStageFactStore(runtime),
            verifySource: makeVideoSealedSourceVerifier(runtime, (reference) =>
              requiredBinding(env.MEDIA_IMMUTABLE_ORIGINALS, "MEDIA_IMMUTABLE_ORIGINALS").head(
                mediaProcessingPhysicalObjectKey(reference),
              ),
            ),
            artifactHead: makeVideoStageArtifactHead(
              requiredBinding(env.MEDIA_DERIVED_ARTIFACTS, "MEDIA_DERIVED_ARTIFACTS"),
            ),
            nowIso: () => new Date().toISOString(),
            randomUuid: () => crypto.randomUUID(),
            analysisProviders: videoProviders,
            transform: bindVideoPhysicalR2Keys(enabledVideoTransform),
            transformAttempts: videoAnalysisRepository,
            songRender: makeWorkerSongVideoRenderServices({
              connect: async () => {
                const { Client } = await import("pg");
                const client = new Client({
                  connectionString: controlPlane.connectionString,
                });
                await client.connect();
                return client;
              },
              output: makeR2SongVideoOutputStore(
                requiredBinding(env.MEDIA_IMMUTABLE_ORIGINALS, "MEDIA_IMMUTABLE_ORIGINALS"),
              ),
              transactionSearchPath: CONTROL_PLANE_HYPERDRIVE_SEARCH_PATH,
            }),
          },
          videoAnalysis: {
            launcher: makeConfiguredVideoAnalysisWorkflowLauncher(
              env.VIDEO_ANALYSIS_WORKFLOW,
              {
                accountId: env.VIDEO_WORKFLOW_ACCOUNT_ID,
                workflowName: env.VIDEO_WORKFLOW_NAME,
                scriptName: env.VIDEO_WORKFLOW_SCRIPT_NAME,
                readToken: env.VIDEO_WORKFLOW_READ_TOKEN,
              },
              adapters.videoAnalysis?.workflowFetch,
            ),
            outbox: videoAnalysisRepository,
            runtime: {
              store: makeControlPlaneVideoPublicationStore(runtime),
              nowIso: () => new Date().toISOString(),
              randomUuid: () => crypto.randomUUID(),
              analysisProviders: videoProviders,
              transform: bindVideoPhysicalR2Keys(enabledVideoTransform),
              transformAttempts: videoAnalysisRepository,
            },
            workerId,
          },
        }
      : {}),
    workflow: {
      store,
      providers: enabled ? makeEnabledProviders(env) : null,
      options: {
        enabled,
        workerId,
        now: Date.now,
        policyRevision: "song-publication-decision-v1",
        transformAdapterRevision: MEDIA_MP3_SAMPLE_ADAPTER_REVISION,
        metadataAdapterRevision: "id3v2-mp3-metadata-v1",
        classifierTimeoutMs: 30_000,
        transformRuntimeMs: 30 * 60 * 1_000,
        maximumSampleBytes: 4_000_000,
      },
    },
  };
}

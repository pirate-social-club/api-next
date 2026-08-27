import type { MediaProcessingProviders } from "@pirate/application/media/processing-contracts";
import type { MediaTransformService } from "@pirate/application/media/transform";
import {
  type CloudflareMediaWorkflowBinding,
  makeCloudflareMediaProcessingWorkflowLauncher,
} from "@pirate/platform-cf/media-processing-cloudflare";
import {
  MEDIA_MP3_SAMPLE_ADAPTER_REVISION,
  makeAcrCloudFetchTransport,
  makeElevenLabsAlignmentFetchTransport,
  makeElevenLabsProcessingAlignmentPort,
  makeR2EmbeddedMetadataPort,
  makeR2MediaProcessingArtifactReader,
  makeR2Mp3SampleMediaTransform,
  makeTransloaditFetchTransport,
} from "@pirate/platform-cf/media-processing-runtime";
import { makeMediaProcessingStore } from "@pirate/platform-cf/media-processing-store";
import { makeAcrCloudAdapter } from "@pirate/platform-cf/media-providers/acrcloud";
import { ElevenLabsAlignmentAdapter } from "@pirate/platform-cf/media-providers/elevenlabs-alignment";
import { makeOpenRouterClassifierAdapter } from "@pirate/platform-cf/media-providers/openrouter";
import { makeTransloaditMediaTransform } from "@pirate/platform-cf/media-transform";
import { makeHyperdriveControlPlaneLayer } from "@pirate/platform-cf/postgres";
import { Effect } from "effect";
import type { MediaProcessorComposition, MediaProcessorWorkerEnv } from "./index.ts";
import { isMediaProcessingEnabled } from "./posture.ts";

const IMMUTABLE_REFERENCE_PREFIX = "media://immutable/";
const MAXIMUM_AUDIO_BYTES = 64 * 1024 * 1024;

export type MediaProcessorRuntimeEnv = MediaProcessorWorkerEnv &
  Readonly<{
    readonly CONTROL_PLANE?: Readonly<{ readonly connectionString: string }>;
    readonly MEDIA_PROCESSING_WORKFLOW?: CloudflareMediaWorkflowBinding;
    readonly MEDIA_IMMUTABLE_ORIGINALS?: R2Bucket;
    readonly MEDIA_DERIVED_ARTIFACTS?: R2Bucket;
    readonly TRANSLOADIT_AUTH_KEY?: string;
    readonly TRANSLOADIT_AUTH_SECRET?: string;
    readonly TRANSLOADIT_PROBE_TEMPLATE_ID?: string;
    readonly TRANSLOADIT_SAMPLE_PRIMARY_TEMPLATE_ID?: string;
    readonly TRANSLOADIT_SAMPLE_ALTERNATE_TEMPLATE_ID?: string;
    readonly ACRCLOUD_IDENTIFY_HOST?: string;
    readonly ACRCLOUD_ACCESS_KEY?: string;
    readonly ACRCLOUD_ACCESS_SECRET?: string;
    readonly ELEVENLABS_API_KEY?: string;
    readonly DATA_REGISTRATION_ENABLED?: string;
    readonly DATA_REGISTRATION_CHAIN_ID?: string;
  }>;

function requiredText(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required when media processing is enabled`);
  }
  return value;
}

function requiredBinding<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} binding is required`);
  return value;
}

/** Translate one persisted logical identity into the fixed-template R2 key. */
export function mediaProcessingPhysicalObjectKey(reference: string): string {
  if (!reference.startsWith(IMMUTABLE_REFERENCE_PREFIX)) {
    throw new TypeError("invalid immutable media reference");
  }
  const suffix = reference.slice(IMMUTABLE_REFERENCE_PREFIX.length);
  if (
    suffix.length === 0 ||
    suffix.length > 768 ||
    suffix.startsWith("/") ||
    suffix.includes("\\") ||
    suffix.split("/").includes("..")
  ) {
    throw new TypeError("invalid immutable media reference");
  }
  return `immutable/${suffix}`;
}

function bindPhysicalR2Keys(transform: MediaTransformService): MediaTransformService {
  return {
    probe: (input) =>
      Effect.suspend(() =>
        transform.probe({
          ...input,
          source: { objectKey: mediaProcessingPhysicalObjectKey(input.source.objectKey) },
        }),
      ),
    extractAudioSample: (input) =>
      Effect.suspend(() =>
        transform.extractAudioSample({
          ...input,
          source: { objectKey: mediaProcessingPhysicalObjectKey(input.source.objectKey) },
        }),
      ),
    cancelAssembly: (input) => transform.cancelAssembly(input),
  };
}

function makeEnabledProviders(env: MediaProcessorRuntimeEnv): MediaProcessingProviders {
  const immutableOriginals = requiredBinding(
    env.MEDIA_IMMUTABLE_ORIGINALS,
    "MEDIA_IMMUTABLE_ORIGINALS",
  );
  const derivedArtifacts = requiredBinding(env.MEDIA_DERIVED_ARTIFACTS, "MEDIA_DERIVED_ARTIFACTS");
  const transloadit = makeTransloaditMediaTransform({
    enabled: true,
    adapterRevision: "transloadit-v1",
    credentials: {
      authKey: requiredText(env.TRANSLOADIT_AUTH_KEY, "TRANSLOADIT_AUTH_KEY"),
      authSecret: requiredText(env.TRANSLOADIT_AUTH_SECRET, "TRANSLOADIT_AUTH_SECRET"),
    },
    templates: {
      probe: requiredText(env.TRANSLOADIT_PROBE_TEMPLATE_ID, "TRANSLOADIT_PROBE_TEMPLATE_ID"),
      samplePrimary: requiredText(
        env.TRANSLOADIT_SAMPLE_PRIMARY_TEMPLATE_ID,
        "TRANSLOADIT_SAMPLE_PRIMARY_TEMPLATE_ID",
      ),
      sampleAlternate: requiredText(
        env.TRANSLOADIT_SAMPLE_ALTERNATE_TEMPLATE_ID,
        "TRANSLOADIT_SAMPLE_ALTERNATE_TEMPLATE_ID",
      ),
    },
    limits: {
      maxRequestBytes: 131_072,
      maxResponseBytes: 2_097_152,
      maxSampleBytes: 5_000_000,
      requestTimeoutMs: 120_000,
      maxAssemblyRuntimeMs: 30 * 60 * 1_000,
    },
    clock: { nowMilliseconds: Date.now },
    transport: makeTransloaditFetchTransport(),
  });
  const acrHost = requiredText(env.ACRCLOUD_IDENTIFY_HOST, "ACRCLOUD_IDENTIFY_HOST");
  const identification = makeAcrCloudAdapter({
    host: acrHost,
    credentials: {
      accessKey: requiredText(env.ACRCLOUD_ACCESS_KEY, "ACRCLOUD_ACCESS_KEY"),
      accessSecret: requiredText(env.ACRCLOUD_ACCESS_SECRET, "ACRCLOUD_ACCESS_SECRET"),
    },
    transport: makeAcrCloudFetchTransport(acrHost),
    clock: () => Math.floor(Date.now() / 1_000),
    adapterRevision: "acrcloud-adapter-v1",
    limits: {
      maxSampleBytes: 4_000_000,
      maxRequestBytes: 4_100_000,
      maxResponseBytes: 1_048_576,
      timeoutMs: 120_000,
    },
  });
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
    providerTransform: transloadit,
    immutableOriginals,
    derivedArtifacts,
    maximumSampleBytes: 4_000_000,
  });

  return {
    transform: bindPhysicalR2Keys(transform),
    identification,
    // The accepted scaffold is deliberately disabled until its provider route
    // is ratified. Lyrics therefore fail closed into the persisted exhaustion
    // path without a classifier request; lyrics-free songs do not call it.
    classifier: makeOpenRouterClassifierAdapter(),
    artifactReader: makeR2MediaProcessingArtifactReader(derivedArtifacts),
    metadata: makeR2EmbeddedMetadataPort(immutableOriginals),
    alignment: makeElevenLabsProcessingAlignmentPort(
      immutableOriginals,
      alignmentAdapter,
      MAXIMUM_AUDIO_BYTES,
    ),
  };
}

const workflowIsNeverMissingByThrownError = (): boolean => false;

export function makeMediaProcessorComposition(
  env: MediaProcessorRuntimeEnv,
): MediaProcessorComposition {
  const controlPlane = requiredBinding(env.CONTROL_PLANE, "CONTROL_PLANE");
  const workflowBinding = requiredBinding(
    env.MEDIA_PROCESSING_WORKFLOW,
    "MEDIA_PROCESSING_WORKFLOW",
  );
  const runtime = makeHyperdriveControlPlaneLayer(controlPlane);
  const dataRegistrationEnabled = env.DATA_REGISTRATION_ENABLED === "true";
  const dataRegistrationChainId = dataRegistrationEnabled
    ? BigInt(requiredText(env.DATA_REGISTRATION_CHAIN_ID, "DATA_REGISTRATION_CHAIN_ID"))
    : undefined;
  if (dataRegistrationChainId !== undefined && dataRegistrationChainId !== 1315n) {
    throw new Error("only Aeneid DATA registration is authorized in staging");
  }
  const store = makeMediaProcessingStore(runtime, {
    ...(dataRegistrationChainId === undefined ? {} : { dataRegistrationChainId }),
  });
  const workflow = makeCloudflareMediaProcessingWorkflowLauncher(
    workflowBinding,
    workflowIsNeverMissingByThrownError,
  );
  const enabled = isMediaProcessingEnabled(env.MEDIA_PROCESSING_ENABLED);
  const workerId = `media-processor-${crypto.randomUUID()}`;

  return {
    queue: { store, workflow, workerId },
    workflow: {
      store,
      providers: enabled ? makeEnabledProviders(env) : null,
      options: {
        enabled,
        workerId,
        now: Date.now,
        policyRevision: "song-publication-decision-v1",
        transformAdapterRevision: `transloadit-probe-${MEDIA_MP3_SAMPLE_ADAPTER_REVISION}`,
        metadataAdapterRevision: "id3v2-mp3-metadata-v1",
        classifierTimeoutMs: 30_000,
        transformRuntimeMs: 30 * 60 * 1_000,
        maximumSampleBytes: 4_000_000,
      },
    },
  };
}

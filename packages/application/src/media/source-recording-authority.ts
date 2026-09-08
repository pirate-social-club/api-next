import { Effect } from "effect";
import type {
  MediaIdentificationOutcome,
  MediaIdentificationProviderService,
  MediaIdentificationRequest,
} from "../media-identification-provider";

export const SONG_SOURCE_RECORDING_AUTHORITY_VERSION =
  "song-source-recording-authority-v1" as const;

export type SongSourceRegistrationState =
  | "pending_upload"
  | "provider_outcome_unknown"
  | "provider_processing"
  | "ready"
  | "failed"
  | "deletion_pending"
  | "deleted";

export type SongSourceRegistration = Readonly<{
  registrationId: string;
  assetId: string;
  submissionId: string;
  operationId: string;
  audioRevision: number;
  analysisRevision: number;
  publicationRevision: number;
  termsRevision: number;
  canonicalAudioSha256: string;
  immutableAudioRef: string;
  verificationSample: Readonly<{
    objectKey: string;
    contentType: "audio/mpeg" | "audio/wav";
    byteLength: number;
  }>;
  provider: "acrcloud";
  bucketId: string;
  opaqueTitle: string;
  state: SongSourceRegistrationState;
  providerFileId: string | null;
  providerMatchId: string | null;
  claimOwner: string | null;
  claimFence: bigint;
}>;

export type SongSourceCatalogFile = Readonly<{
  providerFileId: string;
  providerMatchId: string;
  bucketId: string;
  opaqueTitle: string;
  state: "processing" | "ready" | "error";
  registrationId: string;
  assetId: string;
  canonicalAudioSha256: string;
}>;

export type SongSourceCatalogLookup =
  | Readonly<{ outcome: "none" }>
  | Readonly<{ outcome: "exact"; file: SongSourceCatalogFile }>
  | Readonly<{ outcome: "ambiguous" }>
  | Readonly<{ outcome: "retryable"; reason: string }>
  | Readonly<{ outcome: "rejected"; reason: string }>;

export type SongSourceCatalogUpload =
  | Readonly<{ outcome: "accepted"; file: SongSourceCatalogFile; evidenceDigest: string }>
  | Readonly<{ outcome: "ambiguous"; evidenceDigest: string }>
  | Readonly<{ outcome: "retryable"; reason: string }>
  | Readonly<{ outcome: "rejected"; reason: string; evidenceDigest: string }>;

export interface SongSourceCatalog {
  readonly findExact: (
    registration: SongSourceRegistration,
    signal: AbortSignal,
  ) => Promise<SongSourceCatalogLookup>;
  readonly upload: (
    registration: SongSourceRegistration,
    audio: Readonly<{ bytes: Uint8Array; filename: string; contentType: string }>,
    signal: AbortSignal,
  ) => Promise<SongSourceCatalogUpload>;
  readonly get: (
    registration: SongSourceRegistration,
    providerFileId: string,
    signal: AbortSignal,
  ) => Promise<SongSourceCatalogLookup>;
}

export interface SongSourceAudioReader {
  readonly readCanonical: (
    registration: SongSourceRegistration,
    signal: AbortSignal,
  ) => Promise<Readonly<{ bytes: Uint8Array; filename: string; contentType: string }>>;
  readonly readVerificationSample: (
    registration: SongSourceRegistration,
    signal: AbortSignal,
  ) => Promise<Readonly<{ bytes: Uint8Array; filename: string; contentType: string }>>;
}

export type SongSourceFailureCode =
  | "catalog_configuration_invalid"
  | "catalog_upload_rejected"
  | "catalog_record_ambiguous"
  | "catalog_record_invalid"
  | "catalog_processing_failed"
  | "verification_rejected"
  | "verification_mismatch";

export interface SongSourceRecordingStore {
  readonly get: (registrationId: string) => Promise<SongSourceRegistration | null>;
  readonly acceptProviderFile: (
    input: Readonly<{
      registrationId: string;
      workerId: string;
      claimFence: bigint;
      file: SongSourceCatalogFile;
      evidenceDigest: string;
    }>,
  ) => Promise<boolean>;
  readonly markProviderOutcomeUnknown: (
    input: Readonly<{
      registrationId: string;
      workerId: string;
      claimFence: bigint;
      evidenceDigest: string;
    }>,
  ) => Promise<boolean>;
  readonly markReady: (
    input: Readonly<{
      registrationId: string;
      workerId: string;
      claimFence: bigint;
      providerFileId: string;
      providerMatchId: string;
      identificationEvidence: MediaIdentificationOutcome;
    }>,
  ) => Promise<boolean>;
  readonly fail: (
    input: Readonly<{
      registrationId: string;
      workerId: string;
      claimFence: bigint;
      failureCode: SongSourceFailureCode;
      evidenceRef: string;
    }>,
  ) => Promise<boolean>;
}

export type SongSourceRecordingWorkflowDependencies = Readonly<{
  enabled: boolean;
  workerId: string;
  adapterRevision: string;
  store: SongSourceRecordingStore;
  catalog: SongSourceCatalog;
  audio: SongSourceAudioReader;
  identification: MediaIdentificationProviderService;
}>;

export type SongSourceRecordingWorkflowResult = Readonly<{
  outcome: "inert" | "waiting" | "progress" | "ready" | "failed" | "lost_claim";
}>;

const HASH = /^[0-9a-f]{64}$/u;

const exactFile = (registration: SongSourceRegistration, file: SongSourceCatalogFile): boolean =>
  file.bucketId === registration.bucketId &&
  file.opaqueTitle === registration.opaqueTitle &&
  file.registrationId === registration.registrationId &&
  file.assetId === registration.assetId &&
  file.canonicalAudioSha256 === registration.canonicalAudioSha256 &&
  file.providerFileId.length > 0 &&
  file.providerMatchId.length > 0;

const validRegistration = (registration: SongSourceRegistration): boolean =>
  registration.registrationId.length > 0 &&
  registration.assetId.length > 0 &&
  registration.audioRevision > 0 &&
  registration.analysisRevision > 0 &&
  registration.publicationRevision > 0 &&
  registration.termsRevision > 0 &&
  HASH.test(registration.canonicalAudioSha256) &&
  registration.bucketId.length > 0 &&
  registration.opaqueTitle.length > 0 &&
  registration.claimOwner !== null &&
  registration.verificationSample.objectKey.length > 0 &&
  registration.verificationSample.byteLength > 0 &&
  (registration.verificationSample.contentType === "audio/mpeg" ||
    registration.verificationSample.contentType === "audio/wav");

const evidenceRef = (prefix: string, registration: SongSourceRegistration): string =>
  `${prefix}:${registration.registrationId}:f${registration.claimFence}`;

async function fail(
  dependencies: SongSourceRecordingWorkflowDependencies,
  registration: SongSourceRegistration,
  failureCode: SongSourceFailureCode,
): Promise<SongSourceRecordingWorkflowResult> {
  const changed = await dependencies.store.fail({
    registrationId: registration.registrationId,
    workerId: dependencies.workerId,
    claimFence: registration.claimFence,
    failureCode,
    evidenceRef: evidenceRef(failureCode, registration),
  });
  return { outcome: changed ? "failed" : "lost_claim" };
}

async function accept(
  dependencies: SongSourceRecordingWorkflowDependencies,
  registration: SongSourceRegistration,
  file: SongSourceCatalogFile,
  evidenceDigest: string,
): Promise<SongSourceRecordingWorkflowResult> {
  if (!exactFile(registration, file)) {
    return fail(dependencies, registration, "catalog_record_invalid");
  }
  const changed = await dependencies.store.acceptProviderFile({
    registrationId: registration.registrationId,
    workerId: dependencies.workerId,
    claimFence: registration.claimFence,
    file,
    evidenceDigest,
  });
  return { outcome: changed ? "progress" : "lost_claim" };
}

async function reconcile(
  dependencies: SongSourceRecordingWorkflowDependencies,
  registration: SongSourceRegistration,
  signal: AbortSignal,
): Promise<SongSourceRecordingWorkflowResult | null> {
  const lookup = await dependencies.catalog.findExact(registration, signal);
  if (lookup.outcome === "retryable") return { outcome: "waiting" };
  if (lookup.outcome === "none") {
    return registration.state === "provider_outcome_unknown" ? { outcome: "waiting" } : null;
  }
  if (lookup.outcome === "ambiguous") {
    return fail(dependencies, registration, "catalog_record_ambiguous");
  }
  if (lookup.outcome === "rejected") {
    return fail(dependencies, registration, "catalog_configuration_invalid");
  }
  return accept(
    dependencies,
    registration,
    lookup.file,
    evidenceRef("catalog-reconciled", registration),
  );
}

async function verify(
  dependencies: SongSourceRecordingWorkflowDependencies,
  registration: SongSourceRegistration,
  file: SongSourceCatalogFile,
  signal: AbortSignal,
): Promise<SongSourceRecordingWorkflowResult> {
  if (!exactFile(registration, file)) {
    return fail(dependencies, registration, "catalog_record_invalid");
  }
  if (file.state === "processing") return { outcome: "waiting" };
  if (file.state === "error") {
    return fail(dependencies, registration, "catalog_processing_failed");
  }
  const sample = await dependencies.audio.readVerificationSample(registration, signal);
  const request: MediaIdentificationRequest = {
    version: "media-identification-request-v1",
    operationId: registration.operationId,
    audioRevision: registration.audioRevision,
    analysisRevision: registration.analysisRevision,
    canonicalAudioSha256: registration.canonicalAudioSha256,
    requestId: `${registration.registrationId}:verify:f${registration.claimFence}`,
    signal,
    sample,
  };
  const result = await Effect.runPromise(dependencies.identification.identify(request));
  if (result.outcome !== "retained_reference_match") {
    if (result.outcome === "retryable_failure") return { outcome: "waiting" };
    return fail(dependencies, registration, "verification_rejected");
  }
  if (
    result.context.operationId !== registration.operationId ||
    result.context.audioRevision !== registration.audioRevision ||
    result.context.analysisRevision !== registration.analysisRevision ||
    result.context.canonicalAudioSha256 !== registration.canonicalAudioSha256 ||
    result.context.adapterRevision !== dependencies.adapterRevision ||
    result.evidence.provider !== "acrcloud" ||
    result.evidence.matchKind !== "custom" ||
    result.evidence.providerMatchId !== file.providerMatchId
  ) {
    return fail(dependencies, registration, "verification_mismatch");
  }
  const changed = await dependencies.store.markReady({
    registrationId: registration.registrationId,
    workerId: dependencies.workerId,
    claimFence: registration.claimFence,
    providerFileId: file.providerFileId,
    providerMatchId: file.providerMatchId,
    identificationEvidence: result,
  });
  return { outcome: changed ? "ready" : "lost_claim" };
}

/**
 * Advances one already-claimed source registration by at most one durable
 * provider effect. An uncertain upload response is never retried blindly.
 */
export async function advanceSongSourceRecordingAuthority(
  dependencies: SongSourceRecordingWorkflowDependencies,
  registrationId: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<SongSourceRecordingWorkflowResult> {
  if (!dependencies.enabled) return { outcome: "inert" };
  const registration = await dependencies.store.get(registrationId);
  if (
    registration === null ||
    !validRegistration(registration) ||
    registration.claimOwner !== dependencies.workerId ||
    registration.state === "deleted" ||
    registration.state === "deletion_pending"
  ) {
    return { outcome: "inert" };
  }
  if (registration.state === "ready") return { outcome: "ready" };
  if (registration.state === "failed") return { outcome: "failed" };

  if (
    registration.state === "pending_upload" ||
    registration.state === "provider_outcome_unknown"
  ) {
    const recovered = await reconcile(dependencies, registration, signal);
    if (recovered !== null) return recovered;
    const audio = await dependencies.audio.readCanonical(registration, signal);
    const uploaded = await dependencies.catalog.upload(registration, audio, signal);
    if (uploaded.outcome === "retryable") return { outcome: "waiting" };
    if (uploaded.outcome === "rejected") {
      return fail(dependencies, registration, "catalog_upload_rejected");
    }
    if (uploaded.outcome === "ambiguous") {
      const changed = await dependencies.store.markProviderOutcomeUnknown({
        registrationId: registration.registrationId,
        workerId: dependencies.workerId,
        claimFence: registration.claimFence,
        evidenceDigest: uploaded.evidenceDigest,
      });
      return { outcome: changed ? "waiting" : "lost_claim" };
    }
    return accept(dependencies, registration, uploaded.file, uploaded.evidenceDigest);
  }

  if (registration.providerFileId === null) {
    return fail(dependencies, registration, "catalog_record_invalid");
  }
  const lookup = await dependencies.catalog.get(registration, registration.providerFileId, signal);
  if (lookup.outcome === "retryable" || lookup.outcome === "none") return { outcome: "waiting" };
  if (lookup.outcome === "ambiguous") {
    return fail(dependencies, registration, "catalog_record_ambiguous");
  }
  if (lookup.outcome === "rejected") {
    return fail(dependencies, registration, "catalog_configuration_invalid");
  }
  return verify(dependencies, registration, lookup.file, signal);
}

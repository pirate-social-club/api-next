import {
  type CopyObjectRequest,
  type CopyObjectResponse,
  type HeadObjectResponse,
  probeScenario,
  type R2SealTransport,
} from "./r2-seal-probe";
import { emptyScenarioEvidence, type ScenarioEvidence } from "./r2-seal-probe-evidence";
import {
  type CleanupCandidate,
  cleanupOwnedKeys,
  runWithCleanup,
} from "./r2-seal-probe-staging-cleanup";
import {
  redactStagingEvidence,
  type StagingEvidence,
  type StagingHeadEvidence,
} from "./r2-seal-probe-staging-evidence";
import {
  R2S3StagingTransport,
  type StagingHeadResult,
  type StagingPutResult,
  type StagingTransportOptions,
  sha256Base64,
} from "./r2-seal-probe-staging-transport";

export const STAGING_ENV_NAMES = {
  accessKeyId: "R2_SEAL_PROBE_ACCESS_KEY_ID",
  secretAccessKey: "R2_SEAL_PROBE_SECRET_ACCESS_KEY",
} as const;

export const STAGING_EXECUTION_ACKNOWLEDGEMENT = "execute-staging" as const;

export type StagingConfig = Readonly<{
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}>;

export type StagingTarget = Readonly<{
  accountId: string;
  bucket: string;
}>;

export type StagingRunOptions = Readonly<{
  acknowledgement?: string;
  env?: Readonly<Record<string, string | undefined>>;
  target?: StagingTarget;
  fetch?: StagingTransportOptions["fetch"];
  now?: () => Date;
  runId?: string;
}>;

export type ProbeInvocation =
  | Readonly<{ mode: "dry-run" }>
  | Readonly<{ mode: "execute-staging"; target: StagingTarget }>;

const CONTENT_TYPE = "audio/mpeg";
const CONTENT = new TextEncoder().encode("r2-seal-staging-proof-v1\n");
const REMAINING_DECISIONS = [
  "Ratify the public outcome for a shared 412 PreconditionFailed before accepting a production sealing adapter.",
  "Ratify or reject production dependence on the beta cf-copy-destination-if-none-match extension.",
  "Bind the live VersionId and SHA-256 observations to the reservation evidence contract.",
] as const;

function requireStagingAcknowledgement(value: string | undefined): true {
  if (value !== STAGING_EXECUTION_ACKNOWLEDGEMENT) {
    throw new Error("staging probe requires the explicit execute-staging acknowledgement");
  }
  return true;
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0 || /[\r\n]/.test(value)) {
    throw new Error(`required staging environment variable ${name} is missing or invalid`);
  }
  return value;
}

export function readStagingConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  target?: StagingTarget,
): StagingConfig {
  if (target === undefined) throw new Error("staging probe target is missing");
  const { accountId, bucket } = target;
  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error("staging probe account id is invalid");
  }
  const accessKeyId = requiredEnv(env, STAGING_ENV_NAMES.accessKeyId);
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(accessKeyId)) {
    throw new Error(
      `required staging environment variable ${STAGING_ENV_NAMES.accessKeyId} is invalid`,
    );
  }
  const secretAccessKey = requiredEnv(env, STAGING_ENV_NAMES.secretAccessKey);
  if (secretAccessKey.length < 16 || secretAccessKey.length > 256) {
    throw new Error(
      `required staging environment variable ${STAGING_ENV_NAMES.secretAccessKey} is invalid`,
    );
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error("staging probe bucket is invalid");
  }
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

export function parseProbeInvocation(args: readonly string[]): ProbeInvocation {
  if (args.length === 0) return { mode: "dry-run" };
  if (
    args.length === 5 &&
    args[0] === "--execute-staging" &&
    args[1] === "--account-id" &&
    args[3] === "--bucket"
  ) {
    return {
      mode: "execute-staging",
      target: { accountId: args[2] ?? "", bucket: args[4] ?? "" },
    };
  }
  throw new Error(
    "use no arguments for the local dry run or exactly --execute-staging --account-id <id> --bucket <bucket>",
  );
}

function sha256Hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", bytes as BufferSource)
    .then((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
}

function newRunId(): string {
  return `${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}-${crypto.randomUUID()}`;
}

function emptyHead(called = false): StagingHeadEvidence {
  return {
    called,
    status: null,
    code: null,
    etag: null,
    size_bytes: null,
    content_type: null,
    checksum_sha256: null,
    version_id: null,
  };
}

function headEvidence(result: StagingHeadResult, called = true): StagingHeadEvidence {
  return {
    called,
    status: result.status,
    code: result.code,
    etag: result.etag ?? null,
    size_bytes: result.sizeBytes ?? null,
    content_type: result.contentType ?? null,
    checksum_sha256: result.sha256 ?? null,
    version_id: result.versionId ?? null,
  };
}

function putEvidence(result: StagingPutResult, ownershipMarker: string) {
  return {
    called: true,
    status: result.status,
    code: result.code,
    etag: result.etag ?? null,
    checksum_sha256: result.sha256 ?? null,
    version_id: result.versionId ?? null,
    owned_after_success: result.kind === "created",
    ownership:
      result.kind === "created" ? "confirmed" : result.kind === "ambiguous" ? "ambiguous" : "none",
    ownership_marker: ownershipMarker,
  } as const;
}

function copyEvidence(result: StagingCopyResultLike) {
  return {
    called: true,
    status: result.status,
    code: result.code,
    etag: result.destinationEtag ?? null,
    checksum_sha256: result.destinationSha256 ?? null,
    version_id: result.destinationVersionId ?? null,
    source_version_id: result.sourceVersionId ?? null,
  } as const;
}

type StagingCopyResultLike = Readonly<{
  status: number;
  code: string;
  destinationEtag?: string;
  destinationSha256?: string;
  destinationVersionId?: string;
  sourceVersionId?: string;
}>;

function mapHead(result: StagingHeadResult): HeadObjectResponse {
  if (result.kind === "missing") return { kind: "missing", status: 404, code: "NoSuchKey" };
  if (result.kind === "error") return { kind: "error", status: result.status, code: result.code };
  if (
    result.etag === undefined ||
    result.sizeBytes === undefined ||
    result.contentType === undefined
  ) {
    return { kind: "error", status: result.status, code: "IncompleteMetadata" };
  }
  return {
    kind: "found",
    status: 200,
    code: "OK",
    etag: result.etag,
    sizeBytes: result.sizeBytes,
    contentType: result.contentType,
    ...(result.sha256 === undefined ? {} : { sha256: result.sha256 }),
    ...(result.versionId === undefined ? {} : { versionId: result.versionId }),
  };
}

function mapCopy(
  result: Awaited<ReturnType<R2S3StagingTransport["copyObject"]>>,
): CopyObjectResponse {
  if (result.kind === "precondition-failed") {
    return { kind: "precondition-failed", status: 412, code: "PreconditionFailed" };
  }
  if (result.kind === "ambiguous") {
    return { kind: "error", status: result.status, code: result.code };
  }
  if (result.kind === "error") return { kind: "error", status: result.status, code: result.code };
  if (result.destinationEtag === undefined) {
    return { kind: "error", status: result.status, code: "MissingCopyETag" };
  }
  return {
    kind: "copied",
    status: 200,
    code: "OK",
    destinationEtag: result.destinationEtag,
    ...(result.destinationVersionId === undefined
      ? {}
      : { destinationVersionId: result.destinationVersionId }),
  };
}

class RecordingSealTransport implements R2SealTransport {
  sourceHead: StagingHeadResult | undefined;
  destinationHead: StagingHeadResult | undefined;
  copy: Awaited<ReturnType<R2S3StagingTransport["copyObject"]>> | undefined;

  constructor(
    private readonly transport: R2S3StagingTransport,
    private readonly onCopyAttempt: () => void,
  ) {}

  async headObject(bucket: string, key: string): Promise<HeadObjectResponse> {
    const result = await this.transport.headObject(bucket, key);
    if (this.sourceHead === undefined) this.sourceHead = result;
    else this.destinationHead = result;
    return mapHead(result);
  }

  async copyObject(request: CopyObjectRequest): Promise<CopyObjectResponse> {
    this.onCopyAttempt();
    const result = await this.transport.copyObject({
      sourceBucket: request.sourceBucket,
      destinationBucket: request.destinationBucket,
      sourceKey: request.sourceKey,
      destinationKey: request.destinationKey,
      sourceEtag: request.headers["x-amz-copy-source-if-match"],
    });
    this.copy = result;
    return mapCopy(result);
  }
}

function preflightSafe(source: StagingHeadResult, destination: StagingHeadResult): boolean {
  return (
    source.kind === "missing" &&
    source.code === "NoSuchKey" &&
    destination.kind === "missing" &&
    destination.code === "NoSuchKey"
  );
}

function defaultScenario(sourceKey: string, destinationKey: string, expectedSha256: string) {
  return {
    name: "success" as const,
    sourceBucket: "unused",
    destinationBucket: "unused",
    sourceKey,
    destinationKey,
    source: null,
    destination: null,
    expectedSizeBytes: CONTENT.byteLength,
    expectedContentType: CONTENT_TYPE,
    expectedSha256,
  };
}

export async function runStagingProbe(options: StagingRunOptions = {}): Promise<StagingEvidence> {
  const acknowledgedExecuteFlag = requireStagingAcknowledgement(options.acknowledgement);
  const config = readStagingConfig(options.env ?? process.env, options.target);
  const runId = options.runId ?? newRunId();
  if (!/^[A-Za-z0-9-]{8,128}$/.test(runId)) throw new Error("staging run id is invalid");
  const prefix = `media-r2-seal-probe/${runId}/`;
  const sourceKey = `${prefix}source.bin`;
  const destinationKey = `${prefix}sealed.bin`;
  const ownershipMarker = `r2-seal:${runId}`;
  const startedAt = new Date().toISOString();
  const expectedSha256 = await sha256Hex(CONTENT);
  const expectedSha256Base64 = await sha256Base64(CONTENT);
  const transportOptions: StagingTransportOptions = {
    accountId: config.accountId,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  const transport = new R2S3StagingTransport(transportOptions);
  const sourcePreflight = await transport.headObject(config.bucket, sourceKey);
  const destinationPreflight = await transport.headObject(config.bucket, destinationKey);
  const safeToWrite = preflightSafe(sourcePreflight, destinationPreflight);
  const expectedObject = {
    sizeBytes: CONTENT.byteLength,
    contentType: CONTENT_TYPE,
    sha256: expectedSha256,
  } as const;
  const candidates: CleanupCandidate[] = [];
  const workflow = await runWithCleanup(
    async () => {
      let upload: StagingPutResult = {
        kind: "error",
        status: 0,
        code: "NotAttempted",
      };
      let scenario: ScenarioEvidence = emptyScenarioEvidence(
        defaultScenario(sourceKey, destinationKey, expectedSha256),
      );
      let sealingTransport: RecordingSealTransport | undefined;
      if (safeToWrite) {
        const sourceCandidate: CleanupCandidate = {
          key: sourceKey,
          ownership: "ambiguous",
          ownershipMarker,
          expected: expectedObject,
        };
        const sourceCandidateIndex = candidates.push(sourceCandidate) - 1;
        upload = await transport.putObject(
          config.bucket,
          sourceKey,
          CONTENT,
          CONTENT_TYPE,
          expectedSha256Base64,
          ownershipMarker,
        );
        if (upload.kind === "created") {
          candidates[sourceCandidateIndex] = {
            ...sourceCandidate,
            ownership: "confirmed",
            ...(upload.etag === undefined ? {} : { expectedEtag: upload.etag }),
          };
          sealingTransport = new RecordingSealTransport(transport, () => {
            candidates.push({
              key: destinationKey,
              ownership: "ambiguous",
              ownershipMarker,
              expected: expectedObject,
            });
          });
          scenario = await probeScenario(
            defaultScenario(sourceKey, destinationKey, expectedSha256),
            sealingTransport,
          );
          if (sealingTransport.copy?.kind === "copied") {
            const destinationCandidate = candidates.find(({ key }) => key === destinationKey);
            if (destinationCandidate !== undefined) {
              const destinationIndex = candidates.findIndex(({ key }) => key === destinationKey);
              candidates[destinationIndex] = {
                ...destinationCandidate,
                ownership: "confirmed",
                ...(sealingTransport.copy.destinationEtag === undefined
                  ? {}
                  : { expectedEtag: sealingTransport.copy.destinationEtag }),
              };
            }
          } else if (sealingTransport.copy?.kind !== "ambiguous") {
            const destinationIndex = candidates.findIndex(({ key }) => key === destinationKey);
            if (destinationIndex >= 0) candidates.splice(destinationIndex, 1);
          }
        } else if (upload.kind !== "ambiguous") {
          candidates.pop();
        }
      }
      return { upload, scenario, sealingTransport };
    },
    () => cleanupOwnedKeys(transport, config.bucket, prefix, candidates),
  );
  const { upload, scenario, sealingTransport } = workflow.value;
  const cleanup = workflow.cleanup;
  const sourceHead =
    sealingTransport?.sourceHead === undefined
      ? emptyHead()
      : headEvidence(sealingTransport.sourceHead);
  const destinationHead =
    sealingTransport?.destinationHead === undefined || scenario.destination_head_calls === 0
      ? null
      : headEvidence(sealingTransport.destinationHead);
  const copy = sealingTransport?.copy;
  const completedAt = new Date().toISOString();
  const evidence: StagingEvidence = {
    schema_version: "r2-seal-staging-evidence-v1",
    run: {
      run_id: runId,
      started_at: startedAt,
      completed_at: completedAt,
      deterministic: false,
    },
    account_id: config.accountId,
    bucket: config.bucket,
    prefix,
    source_key: sourceKey,
    destination_key: destinationKey,
    mode: "staging-execute",
    transport: "r2-s3-sigv4",
    provider_contacted: true,
    credentials_read: true,
    preflight: {
      source: headEvidence(sourcePreflight),
      destination: headEvidence(destinationPreflight),
      safe_to_write: safeToWrite,
    },
    upload: putEvidence(upload, ownershipMarker),
    sealing: {
      outcome: scenario.outcome,
      source_head: sourceHead,
      conditional_copy:
        copy === undefined
          ? {
              called: false,
              status: null,
              code: null,
              etag: null,
              checksum_sha256: null,
              version_id: null,
              source_version_id: null,
            }
          : copyEvidence(copy),
      destination_head: destinationHead,
      automatic_retry: false,
      destination_verified: scenario.destination_verified,
    },
    metadata: {
      source_etag: scenario.observed_source_etag,
      destination_etag: scenario.observed_destination_etag,
      source_checksum_sha256: {
        available: scenario.observed_source_sha256 !== null,
        value: scenario.observed_source_sha256,
      },
      destination_checksum_sha256: {
        available: scenario.observed_destination_sha256 !== null,
        value: scenario.observed_destination_sha256,
      },
      source_version_id: scenario.observed_source_version_id,
      destination_version_id: scenario.observed_destination_version_id,
      version_binding: scenario.version_binding,
    },
    cleanup: {
      status: cleanup.status,
      attempted: cleanup.keys.length > 0,
      keys: cleanup.keys,
      bucket_deleted: false,
    },
    safety: {
      acknowledged_execute_flag: acknowledgedExecuteFlag,
      shared_412_is_ambiguous: true,
      conditional_copy_is_never_retried: true,
      post_412_destination_head: false,
      destination_head_only_after_copy_success: true,
      preexisting_keys_fail_closed: true,
      cleanup_is_exact_run_owned_keys: true,
      bucket_was_not_created_or_deleted: true,
      secrets_emitted: false,
      urls_headers_bodies_emitted: false,
    },
    remaining_decisions: REMAINING_DECISIONS,
  };
  return redactStagingEvidence(evidence);
}

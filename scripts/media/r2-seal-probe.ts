import {
  emptyScenarioEvidence,
  type ProbeEvidence,
  redactEvidence,
  type ScenarioEvidence,
  type VerificationFailure,
  type VersionBinding,
} from "./r2-seal-probe-evidence";
import {
  type FixtureObject,
  type FixtureSet,
  loadHostileFixtures,
  type SealFixture,
} from "./r2-seal-probe-fixtures";

export { redactEvidence } from "./r2-seal-probe-evidence";
export { loadHostileFixtures } from "./r2-seal-probe-fixtures";

function encodeRfc3986Segment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function encodeCopySource(sourceBucket: string, sourceKey: string): string {
  const encodedBucket = encodeRfc3986Segment(sourceBucket);
  const encodedKey = sourceKey.split("/").map(encodeRfc3986Segment).join("/");
  return `/${encodedBucket}/${encodedKey}`;
}

export type HeadObjectResponse =
  | Readonly<{
      kind: "found";
      status: 200;
      code: "OK";
      etag: string;
      sizeBytes: number;
      contentType: string;
      sha256?: string;
      versionId?: string;
    }>
  | Readonly<{ kind: "missing"; status: 404; code: "NoSuchKey" }>
  | Readonly<{ kind: "error"; status: number; code: string }>;

export type CopyObjectRequest = Readonly<{
  sourceBucket: string;
  destinationBucket: string;
  sourceKey: string;
  destinationKey: string;
  headers: Readonly<{
    "x-amz-copy-source": string;
    "x-amz-copy-source-if-match": string;
    "cf-copy-destination-if-none-match": "*";
  }>;
}>;

export type CopyObjectResponse =
  | Readonly<{
      kind: "copied";
      status: 200;
      code: "OK";
      destinationEtag: string;
      destinationVersionId?: string;
    }>
  | Readonly<{ kind: "precondition-failed"; status: 412; code: "PreconditionFailed" }>
  | Readonly<{ kind: "error"; status: number; code: string }>;

export interface R2SealTransport {
  headObject(bucket: string, key: string): Promise<HeadObjectResponse>;
  copyObject(request: CopyObjectRequest): Promise<CopyObjectResponse>;
}

export type FakeTransportCall =
  | Readonly<{ kind: "head"; bucket: string; key: string }>
  | Readonly<{
      kind: "copy";
      sourceBucket: string;
      destinationBucket: string;
      sourceKey: string;
      destinationKey: string;
      headers: CopyObjectRequest["headers"];
    }>;

export class FakeR2Transport implements R2SealTransport {
  readonly calls: FakeTransportCall[] = [];
  private source: FixtureObject | null;
  private destination: FixtureObject | null;
  private overwriteApplied = false;
  private copyApplied = false;

  constructor(private readonly fixture: SealFixture) {
    this.source = fixture.source;
    this.destination = fixture.destination;
  }

  async headObject(bucket: string, key: string): Promise<HeadObjectResponse> {
    this.calls.push({ kind: "head", bucket, key });
    const isSource = bucket === this.fixture.sourceBucket && key === this.fixture.sourceKey;
    const isDestination =
      bucket === this.fixture.destinationBucket && key === this.fixture.destinationKey;
    if (isSource && this.fixture.sourceHeadError !== undefined) {
      switch (this.fixture.sourceHeadError) {
        case "malformed-404":
          return { kind: "error", status: 404, code: "MalformedXML" };
        case "no-such-bucket":
          return { kind: "error", status: 404, code: "NoSuchBucket" };
        case "generic-404":
          return { kind: "error", status: 404, code: "ProviderError" };
      }
    }
    if (isDestination && this.copyApplied && this.fixture.destinationHeadFailure !== undefined) {
      return this.fixture.destinationHeadFailure === "missing"
        ? { kind: "missing", status: 404, code: "NoSuchKey" }
        : { kind: "error", status: 503, code: "SlowDown" };
    }
    const object = isSource ? this.source : isDestination ? this.destination : null;
    if (object === null) return { kind: "missing", status: 404, code: "NoSuchKey" };
    return {
      kind: "found",
      status: 200,
      code: "OK",
      etag: object.etag,
      sizeBytes: object.sizeBytes,
      contentType: object.contentType,
      ...(object.sha256 === undefined ? {} : { sha256: object.sha256 }),
      ...(object.versionId === undefined ? {} : { versionId: object.versionId }),
    };
  }

  async copyObject(request: CopyObjectRequest): Promise<CopyObjectResponse> {
    this.calls.push({
      kind: "copy",
      sourceBucket: request.sourceBucket,
      destinationBucket: request.destinationBucket,
      sourceKey: request.sourceKey,
      destinationKey: request.destinationKey,
      headers: request.headers,
    });
    if (
      request.sourceBucket !== this.fixture.sourceBucket ||
      request.destinationBucket !== this.fixture.destinationBucket
    ) {
      return { kind: "error", status: 404, code: "NoSuchBucket" };
    }
    if (
      request.sourceKey !== this.fixture.sourceKey ||
      request.destinationKey !== this.fixture.destinationKey
    ) {
      return { kind: "error", status: 404, code: "NoSuchKey" };
    }
    if (
      request.headers["x-amz-copy-source"] !==
      encodeCopySource(request.sourceBucket, request.sourceKey)
    ) {
      return { kind: "error", status: 400, code: "InvalidCopySource" };
    }
    if (request.headers["x-amz-copy-source-if-match"].length === 0) {
      return { kind: "error", status: 400, code: "MissingSourceCondition" };
    }
    if (request.headers["cf-copy-destination-if-none-match"] !== "*") {
      return { kind: "error", status: 400, code: "MissingDestinationCondition" };
    }
    if (this.fixture.overwriteSourceBeforeCopy !== undefined && !this.overwriteApplied) {
      this.source = this.fixture.overwriteSourceBeforeCopy;
      this.overwriteApplied = true;
    }
    if (this.fixture.sourceDisappearsBeforeCopy === true) {
      this.source = null;
    }
    if (this.fixture.destinationAppearsBeforeCopy !== undefined && this.destination === null) {
      this.destination = this.fixture.destinationAppearsBeforeCopy;
    }
    if (this.fixture.copyFailure === "ambiguous-412") {
      return { kind: "precondition-failed", status: 412, code: "PreconditionFailed" };
    }
    if (this.fixture.copyFailure === "provider-error") {
      return { kind: "error", status: 503, code: "SlowDown" };
    }
    if (this.fixture.copyFailure === "nonstandard-412") {
      return { kind: "error", status: 412, code: "ConditionalRequestConflict" };
    }
    if (this.source === null) {
      return { kind: "error", status: 404, code: "NoSuchKey" };
    }
    if (this.source.etag !== request.headers["x-amz-copy-source-if-match"]) {
      return { kind: "precondition-failed", status: 412, code: "PreconditionFailed" };
    }
    if (request.headers["cf-copy-destination-if-none-match"] === "*" && this.destination !== null) {
      return { kind: "precondition-failed", status: 412, code: "PreconditionFailed" };
    }
    const source = this.source;
    const mismatch = this.fixture.verificationMismatch;
    const destinationEtag = this.fixture.copiedDestinationEtag ?? source.etag;
    this.destination = {
      ...source,
      etag: destinationEtag,
      ...(this.fixture.destinationVersionIdAfterCopy === undefined
        ? {}
        : { versionId: this.fixture.destinationVersionIdAfterCopy }),
      ...(mismatch === "etag" ? { etag: '"etag-verification-mismatch"' } : {}),
      ...(mismatch === "size" ? { sizeBytes: source.sizeBytes + 1 } : {}),
      ...(mismatch === "content-type" ? { contentType: "application/octet-stream" } : {}),
      ...(mismatch === "checksum"
        ? { sha256: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" }
        : {}),
      ...(mismatch === "version" ? { versionId: "version-verification-mismatch" } : {}),
    };
    this.copyApplied = true;
    return {
      kind: "copied",
      status: 200,
      code: "OK",
      destinationEtag,
      ...(this.fixture.destinationVersionIdAfterCopy === undefined
        ? {}
        : { destinationVersionId: this.fixture.destinationVersionIdAfterCopy }),
    };
  }
}

export async function probeScenario(
  fixture: SealFixture,
  transport: R2SealTransport,
): Promise<ScenarioEvidence> {
  const evidence = emptyScenarioEvidence(fixture);
  let sourceHeadCalls = 0;
  let conditionalCopyCalls = 0;
  let destinationHeadCalls = 0;
  const finish = (
    result: Omit<
      ScenarioEvidence,
      "source_head_calls" | "conditional_copy_calls" | "destination_head_calls"
    >,
  ): ScenarioEvidence => ({
    ...result,
    source_head_calls: sourceHeadCalls,
    conditional_copy_calls: conditionalCopyCalls,
    destination_head_calls: destinationHeadCalls,
  });

  try {
    sourceHeadCalls += 1;
    const source = await transport.headObject(fixture.sourceBucket, fixture.sourceKey);
    const sourceStatus = source.status;
    const sourceCode = source.code;
    if (source.kind === "missing") {
      return finish({
        ...evidence,
        outcome: "source_missing",
        proof_scope: "local-only",
        diagnostic_scope: "none",
        source_head_status: sourceStatus,
        source_head_code: sourceCode,
      });
    }
    if (source.kind === "error") {
      return finish({
        ...evidence,
        outcome: "provider_response_unknown",
        source_head_status: sourceStatus,
        source_head_code: sourceCode,
      });
    }

    const observedSourceMatches =
      source.sizeBytes === fixture.expectedSizeBytes &&
      source.contentType === fixture.expectedContentType &&
      (fixture.expectedSha256 === undefined || source.sha256 === fixture.expectedSha256);
    const observedEvidence = {
      observed_source_etag: source.etag,
      observed_source_size_bytes: source.sizeBytes,
      observed_source_content_type: source.contentType,
      observed_source_sha256: source.sha256 ?? null,
      observed_source_version_id: source.versionId ?? null,
      source_head_status: sourceStatus,
      source_head_code: sourceCode,
    } as const;
    if (!observedSourceMatches) {
      return finish({
        ...evidence,
        ...observedEvidence,
        outcome: "expectation_mismatch",
        proof_scope: "local-only",
        diagnostic_scope: "none",
      });
    }

    conditionalCopyCalls += 1;
    const copy = await transport.copyObject({
      sourceBucket: fixture.sourceBucket,
      destinationBucket: fixture.destinationBucket,
      sourceKey: fixture.sourceKey,
      destinationKey: fixture.destinationKey,
      headers: {
        "x-amz-copy-source": encodeCopySource(fixture.sourceBucket, fixture.sourceKey),
        // Preserve the observed quoted or multipart ETag byte-for-byte.
        "x-amz-copy-source-if-match": source.etag,
        "cf-copy-destination-if-none-match": "*",
      },
    });
    if (copy.kind === "precondition-failed") {
      // A shared 412 is terminal and intentionally has no follow-up HEAD.
      return finish({
        ...evidence,
        ...observedEvidence,
        outcome: "conditional_precondition_ambiguous",
        proof_scope: "inconclusive",
        diagnostic_scope: "transport-ambiguous",
        conditional_copy_status: copy.status,
        conditional_copy_code: copy.code,
      });
    }
    if (copy.kind === "error") {
      if (copy.status === 404 && copy.code === "NoSuchKey") {
        return finish({
          ...evidence,
          ...observedEvidence,
          outcome: "source_missing",
          proof_scope: "local-only",
          diagnostic_scope: "none",
          conditional_copy_status: copy.status,
          conditional_copy_code: copy.code,
        });
      }
      return finish({
        ...evidence,
        ...observedEvidence,
        outcome: "provider_response_unknown",
        conditional_copy_status: copy.status,
        conditional_copy_code: copy.code,
      });
    }

    destinationHeadCalls += 1;
    const destination = await transport.headObject(
      fixture.destinationBucket,
      fixture.destinationKey,
    );
    const destinationVersionBinding: VersionBinding =
      copy.destinationVersionId === undefined
        ? "unavailable"
        : destination.kind === "found" && destination.versionId === copy.destinationVersionId
          ? "matched"
          : "mismatch";
    const verificationFailure: VerificationFailure =
      destination.kind === "missing"
        ? "destination_missing"
        : destination.kind === "error"
          ? "provider_error"
          : destination.etag !== copy.destinationEtag
            ? "etag_mismatch"
            : destination.sizeBytes !== source.sizeBytes
              ? "size_mismatch"
              : destination.contentType !== source.contentType
                ? "content_type_mismatch"
                : source.sha256 !== undefined && destination.sha256 !== source.sha256
                  ? "checksum_mismatch"
                  : copy.destinationVersionId === undefined
                    ? "version_unavailable"
                    : destinationVersionBinding !== "matched"
                      ? "version_mismatch"
                      : "none";
    const destinationVerified = verificationFailure === "none";
    return finish({
      ...evidence,
      ...observedEvidence,
      outcome: destinationVerified ? "success" : "verification_mismatch",
      proof_scope: destinationVerified ? "local-only" : "inconclusive",
      diagnostic_scope: destinationVerified ? "none" : "transport-ambiguous",
      observed_destination_etag: destination.kind === "found" ? destination.etag : null,
      observed_destination_size_bytes: destination.kind === "found" ? destination.sizeBytes : null,
      observed_destination_content_type:
        destination.kind === "found" ? destination.contentType : null,
      observed_destination_sha256:
        destination.kind === "found" ? (destination.sha256 ?? null) : null,
      observed_destination_version_id:
        destination.kind === "found" ? (destination.versionId ?? null) : null,
      version_binding: destinationVersionBinding,
      verification_failure: verificationFailure,
      conditional_copy_status: copy.status,
      conditional_copy_code: copy.code,
      destination_head_status: destination.status,
      destination_head_code: destination.code,
      destination_verified: destinationVerified,
    });
  } catch {
    return finish({ ...evidence, outcome: "transport_error" });
  }
}

export async function runLocalDryRun(fixtureSet?: FixtureSet): Promise<ProbeEvidence> {
  const fixtures = fixtureSet ?? (await loadHostileFixtures());
  const scenarios: ScenarioEvidence[] = [];
  for (const fixture of fixtures.scenarios) {
    scenarios.push(await probeScenario(fixture, new FakeR2Transport(fixture)));
  }
  return redactEvidence({ scenarios });
}

async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  if (args.length > 0) {
    throw new Error("The local R2 seal probe accepts no network, credential, or live-run options");
  }
  process.stdout.write(`${JSON.stringify(await runLocalDryRun(), null, 2)}\n`);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "R2 seal probe failed");
    process.exitCode = 1;
  });
}

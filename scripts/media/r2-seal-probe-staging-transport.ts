import {
  encodeR2CopySource,
  type SignedStagingRequest,
  type StagingCredentials,
  signR2Request,
} from "./r2-seal-probe-staging-signing";

export type StagingFetch = (input: string, init: RequestInit) => Promise<Response>;

export type StagingHeadResult = Readonly<{
  kind: "found" | "missing" | "error";
  status: number;
  code: string;
  etag?: string;
  sizeBytes?: number;
  contentType?: string;
  sha256?: string;
  versionId?: string;
  ownershipMarker?: string;
}>;

export type StagingPutResult = Readonly<{
  kind: "created" | "precondition-failed" | "ambiguous" | "error";
  status: number;
  code: string;
  etag?: string;
  sha256?: string;
  versionId?: string;
}>;

export type StagingCopyResult = Readonly<{
  kind: "copied" | "precondition-failed" | "ambiguous" | "error";
  status: number;
  code: string;
  destinationEtag?: string;
  destinationSha256?: string;
  destinationVersionId?: string;
  sourceVersionId?: string;
}>;

export type CopyGuardMode = "source-only" | "destination-only" | "combined";

export type StagingDeleteResult = Readonly<{
  kind: "deleted" | "error";
  status: number;
  code: string;
}>;

export type StagingBodySha256Result = Readonly<{
  kind: "verified" | "error";
  status: number;
  code: string;
  sha256?: string;
}>;

export type StagingTransportOptions = Readonly<{
  accountId: string;
  credentials: StagingCredentials;
  fetch?: StagingFetch;
  now?: () => Date;
}>;

function header(response: Response, name: string): string | undefined {
  const value = response.headers.get(name);
  return value === null || value.length === 0 ? undefined : value;
}

function safeCode(value: string | undefined, fallback: string): string {
  if (value === undefined || value.length === 0) return fallback;
  const match = /^[A-Za-z0-9._-]{1,96}/.exec(value);
  return match?.[0] === value ? value : fallback;
}

async function responseCode(response: Response): Promise<string> {
  const explicit = header(response, "x-amz-error-code");
  if (explicit !== undefined) return safeCode(explicit, "ProviderError");
  if (response.status === 200 || response.status === 201 || response.status === 204) {
    return "OK";
  }
  let body = "";
  try {
    body = await response.text();
  } catch {
    return "ProviderError";
  }
  const code = /<Code>([^<]+)<\/Code>/i.exec(body)?.[1];
  return safeCode(code, response.status === 404 ? "NotFound" : "ProviderError");
}

function xmlValue(body: string, tag: string): string | undefined {
  const value = new RegExp(`<${tag}>([^<]*)</${tag}>`, "i").exec(body)?.[1];
  return value === undefined || value.length === 0 ? undefined : value;
}

function decodeBase64Sha256(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    if (bytes.length !== 32) return undefined;
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return undefined;
  }
}

async function signedFetch(
  options: StagingTransportOptions,
  input: Omit<Parameters<typeof signR2Request>[0], "credentials">,
): Promise<{ request: SignedStagingRequest; response: Response }> {
  const request = await signR2Request({
    ...input,
    now: options.now?.() ?? new Date(),
    credentials: options.credentials,
  });
  const response = await (options.fetch ?? fetch)(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body as unknown as BodyInit,
    redirect: "error",
    cache: "no-store",
  });
  return { request, response };
}

function responseSize(response: Response): number | undefined {
  const value = header(response, "content-length");
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const size = Number(value);
  return Number.isSafeInteger(size) ? size : undefined;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isAmbiguousMutationStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export class R2S3StagingTransport {
  private readonly options: StagingTransportOptions;

  constructor(options: StagingTransportOptions) {
    this.options = options;
  }

  async preflightObject(bucket: string, key: string): Promise<StagingHeadResult> {
    try {
      const { response } = await signedFetch(this.options, {
        accountId: this.options.accountId,
        bucket,
        key,
        method: "GET",
        headers: { range: "bytes=0-0" },
      });
      const code = await responseCode(response);
      if (!response.bodyUsed) await response.body?.cancel();
      if (response.status === 404 && code === "NoSuchKey") {
        return { kind: "missing", status: response.status, code };
      }
      if (response.status === 200 || response.status === 206) {
        return { kind: "found", status: response.status, code };
      }
      return { kind: "error", status: response.status, code };
    } catch {
      return { kind: "error", status: 0, code: "TransportError" };
    }
  }

  async readObjectSha256(
    bucket: string,
    key: string,
    ifMatch: string,
    expectedSizeBytes: number,
  ): Promise<StagingBodySha256Result> {
    if (
      !Number.isSafeInteger(expectedSizeBytes) ||
      expectedSizeBytes < 1 ||
      expectedSizeBytes > 1024
    ) {
      return { kind: "error", status: 0, code: "CleanupBodyTooLarge" };
    }
    try {
      const { response } = await signedFetch(this.options, {
        accountId: this.options.accountId,
        bucket,
        key,
        method: "GET",
        headers: {
          "if-match": ifMatch,
          range: `bytes=0-${expectedSizeBytes - 1}`,
        },
      });
      const code = await responseCode(response);
      if (response.status !== 200 && response.status !== 206) {
        return { kind: "error", status: response.status, code };
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== expectedSizeBytes) {
        return { kind: "error", status: response.status, code: "CleanupBodySizeMismatch" };
      }
      return {
        kind: "verified",
        status: response.status,
        code,
        sha256: await sha256Hex(bytes),
      };
    } catch {
      return { kind: "error", status: 0, code: "TransportError" };
    }
  }

  async headObject(bucket: string, key: string): Promise<StagingHeadResult> {
    try {
      const { response } = await signedFetch(this.options, {
        accountId: this.options.accountId,
        bucket,
        key,
        method: "HEAD",
        headers: { "x-amz-checksum-mode": "ENABLED" },
      });
      const code = await responseCode(response);
      if (response.status === 404 && code === "NoSuchKey") {
        return { kind: "missing", status: response.status, code };
      }
      if (response.status !== 200) return { kind: "error", status: response.status, code };
      return {
        kind: "found",
        status: response.status,
        code,
        ...(header(response, "etag") === undefined ? {} : { etag: header(response, "etag") }),
        ...(responseSize(response) === undefined ? {} : { sizeBytes: responseSize(response) }),
        ...(header(response, "content-type") === undefined
          ? {}
          : { contentType: header(response, "content-type") }),
        ...(decodeBase64Sha256(header(response, "x-amz-checksum-sha256")) === undefined
          ? {}
          : { sha256: decodeBase64Sha256(header(response, "x-amz-checksum-sha256")) }),
        ...(header(response, "x-amz-version-id") === undefined
          ? {}
          : { versionId: header(response, "x-amz-version-id") }),
        ...(header(response, "x-amz-meta-r2-seal-run-marker") === undefined
          ? {}
          : { ownershipMarker: header(response, "x-amz-meta-r2-seal-run-marker") }),
      };
    } catch {
      return { kind: "error", status: 0, code: "TransportError" };
    }
  }

  async putObject(
    bucket: string,
    key: string,
    bytes: Uint8Array,
    contentType: string,
    sha256Base64: string,
    ownershipMarker: string,
  ): Promise<StagingPutResult> {
    try {
      const { response } = await signedFetch(this.options, {
        accountId: this.options.accountId,
        bucket,
        key,
        method: "PUT",
        headers: {
          "content-type": contentType,
          "content-length": String(bytes.byteLength),
          "if-none-match": "*",
          "x-amz-checksum-sha256": sha256Base64,
          "x-amz-meta-r2-seal-run-marker": ownershipMarker,
        },
        body: bytes,
      });
      const code = await responseCode(response);
      if (response.status === 412 && code === "PreconditionFailed")
        return { kind: "precondition-failed", status: response.status, code };
      if (response.status === 412) return { kind: "error", status: response.status, code };
      if (isAmbiguousMutationStatus(response.status)) {
        return { kind: "ambiguous", status: response.status, code };
      }
      if (response.status < 200 || response.status >= 300) {
        return { kind: "error", status: response.status, code };
      }
      return {
        kind: "created",
        status: response.status,
        code,
        ...(header(response, "etag") === undefined ? {} : { etag: header(response, "etag") }),
        ...(decodeBase64Sha256(header(response, "x-amz-checksum-sha256")) === undefined
          ? {}
          : { sha256: decodeBase64Sha256(header(response, "x-amz-checksum-sha256")) }),
        ...(header(response, "x-amz-version-id") === undefined
          ? {}
          : { versionId: header(response, "x-amz-version-id") }),
      };
    } catch {
      return { kind: "ambiguous", status: 0, code: "ResponseLost" };
    }
  }

  async copyObject(input: {
    sourceBucket: string;
    destinationBucket: string;
    sourceKey: string;
    destinationKey: string;
    sourceEtag: string;
  }): Promise<StagingCopyResult> {
    return this.copyObjectWithGuards(input, "combined");
  }

  /** Diagnostic-only request builder; production sealing always uses combined guards. */
  async copyObjectWithGuards(
    input: {
      sourceBucket: string;
      destinationBucket: string;
      sourceKey: string;
      destinationKey: string;
      sourceEtag: string;
    },
    guardMode: CopyGuardMode,
  ): Promise<StagingCopyResult> {
    try {
      const guardHeaders = {
        ...(guardMode === "source-only" || guardMode === "combined"
          ? { "x-amz-copy-source-if-match": input.sourceEtag }
          : {}),
        ...(guardMode === "destination-only" || guardMode === "combined"
          ? { "cf-copy-destination-if-none-match": "*" }
          : {}),
      };
      const { response } = await signedFetch(this.options, {
        accountId: this.options.accountId,
        bucket: input.destinationBucket,
        key: input.destinationKey,
        method: "PUT",
        headers: {
          "x-amz-copy-source": encodeR2CopySource(input.sourceBucket, input.sourceKey),
          "x-amz-metadata-directive": "COPY",
          ...guardHeaders,
        },
      });
      const code = await responseCode(response);
      if (response.status === 412 && code === "PreconditionFailed") {
        return { kind: "precondition-failed", status: response.status, code };
      }
      if (response.status === 412) return { kind: "error", status: response.status, code };
      if (isAmbiguousMutationStatus(response.status)) {
        return { kind: "ambiguous", status: response.status, code };
      }
      if (response.status < 200 || response.status >= 300) {
        return { kind: "error", status: response.status, code };
      }
      let body = "";
      try {
        body = await response.text();
      } catch {
        body = "";
      }
      return {
        kind: "copied",
        status: response.status,
        code,
        ...((header(response, "etag") ?? xmlValue(body, "ETag"))
          ? { destinationEtag: header(response, "etag") ?? xmlValue(body, "ETag") }
          : {}),
        ...(decodeBase64Sha256(header(response, "x-amz-checksum-sha256")) === undefined
          ? {}
          : { destinationSha256: decodeBase64Sha256(header(response, "x-amz-checksum-sha256")) }),
        ...((header(response, "x-amz-version-id") ?? xmlValue(body, "VersionId"))
          ? {
              destinationVersionId:
                header(response, "x-amz-version-id") ?? xmlValue(body, "VersionId"),
            }
          : {}),
        ...((header(response, "x-amz-copy-source-version-id") ??
        xmlValue(body, "CopySourceVersionId"))
          ? {
              sourceVersionId:
                header(response, "x-amz-copy-source-version-id") ??
                xmlValue(body, "CopySourceVersionId"),
            }
          : {}),
      };
    } catch {
      return { kind: "ambiguous", status: 0, code: "ResponseLost" };
    }
  }

  async deleteObject(bucket: string, key: string, ifMatch?: string): Promise<StagingDeleteResult> {
    try {
      const { response } = await signedFetch(this.options, {
        accountId: this.options.accountId,
        bucket,
        key,
        method: "DELETE",
        ...(ifMatch === undefined ? {} : { headers: { "if-match": ifMatch } }),
      });
      const code = await responseCode(response);
      return response.status >= 200 && response.status < 300
        ? { kind: "deleted", status: response.status, code }
        : { kind: "error", status: response.status, code };
    } catch {
      return { kind: "error", status: 0, code: "TransportError" };
    }
  }
}

export async function sha256Base64(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const binary = String.fromCharCode(...new Uint8Array(digest));
  return btoa(binary);
}

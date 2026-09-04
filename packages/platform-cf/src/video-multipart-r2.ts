import type {
  VideoMultipartManifestPart,
  VideoMultipartUploadGateway,
} from "@pirate/application/video/publication";

const encoder = new TextEncoder();
const accountIdPattern = /^[0-9a-f]{32}$/u;
const bucketPattern = /^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?$/u;
const keyPattern = /^reservations\/media-reservation-[0-9a-f-]{36}\/source$/u;
const uploadIdPattern = /^[^\r\n]{1,1024}$/u;

export const VIDEO_MULTIPART_CORS_REQUIREMENTS = Object.freeze({
  methods: ["PUT"] as const,
  exposeHeaders: ["ETag"] as const,
});

export type R2VideoMultipartOptions = Readonly<{
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetch?: typeof fetch;
  now?: () => Date;
}>;

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function objectPath(bucket: string, key: string): string {
  return `/${encodeRfc3986(bucket)}/${key.split("/").map(encodeRfc3986).join("/")}`;
}

function canonicalQuery(entries: readonly (readonly [string, string])[]): string {
  return entries
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      if (leftName === rightName)
        return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      return leftName < rightName ? -1 : 1;
    })
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value)));
}

async function signingKey(secret: string, date: string): Promise<Uint8Array> {
  const dated = await hmac(encoder.encode(`AWS4${secret}`), date);
  const regional = await hmac(dated, "auto");
  const service = await hmac(regional, "s3");
  return hmac(service, "aws4_request");
}

function dateParts(now: Date): Readonly<{ short: string; full: string }> {
  const iso = now.toISOString();
  const short = iso.slice(0, 10).replaceAll("-", "");
  return { short, full: `${short}T${iso.slice(11, 19).replaceAll(":", "")}Z` };
}

function validOptions(options: R2VideoMultipartOptions): boolean {
  return (
    accountIdPattern.test(options.accountId) &&
    bucketPattern.test(options.bucket) &&
    options.accessKeyId.length > 0 &&
    options.secretAccessKey.length > 0 &&
    options.accessKeyId !== "PENDING" &&
    options.secretAccessKey !== "PENDING" &&
    !/[\r\n]/u.test(options.accessKeyId) &&
    !/[\r\n]/u.test(options.secretAccessKey)
  );
}

function validTarget(key: string, uploadId?: string): boolean {
  return (
    keyPattern.test(key) &&
    !key.includes("..") &&
    (uploadId === undefined || uploadIdPattern.test(uploadId))
  );
}

async function authorization(input: {
  options: R2VideoMultipartOptions;
  method: string;
  path: string;
  query: string;
  bodyHash: string;
  date: Readonly<{ short: string; full: string }>;
  host: string;
}): Promise<string> {
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    input.method,
    input.path,
    input.query,
    `host:${input.host}\nx-amz-content-sha256:${input.bodyHash}\nx-amz-date:${input.date.full}\n`,
    signedHeaders,
    input.bodyHash,
  ].join("\n");
  const scope = `${input.date.short}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.date.full,
    scope,
    await sha256Hex(encoder.encode(canonicalRequest)),
  ].join("\n");
  const signature = Array.from(
    await hmac(await signingKey(input.options.secretAccessKey, input.date.short), stringToSign),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `AWS4-HMAC-SHA256 Credential=${input.options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

async function signedRequest(
  options: R2VideoMultipartOptions,
  input: Readonly<{
    method: "POST" | "DELETE" | "HEAD";
    key: string;
    query: readonly (readonly [string, string])[];
    body?: Uint8Array;
  }>,
): Promise<Response> {
  if (!validOptions(options) || !validTarget(input.key))
    throw new Error("invalid multipart target");
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("invalid multipart clock");
  const host = `${options.accountId}.r2.cloudflarestorage.com`;
  const path = objectPath(options.bucket, input.key);
  const query = canonicalQuery(input.query);
  const body = input.body ?? new Uint8Array();
  const bodyHash = await sha256Hex(body);
  const date = dateParts(now);
  const headers = new Headers({
    host,
    "x-amz-content-sha256": bodyHash,
    "x-amz-date": date.full,
    authorization: await authorization({
      options,
      method: input.method,
      path,
      query,
      bodyHash,
      date,
      host,
    }),
  });
  if (input.body !== undefined) headers.set("content-type", "application/xml");
  return (options.fetch ?? fetch)(
    `https://${host}${path}${query.length === 0 ? "" : `?${query}`}`,
    {
      method: input.method,
      headers,
      ...(input.body === undefined ? {} : { body }),
    },
  );
}

async function presignedPartUrl(
  options: R2VideoMultipartOptions,
  input: Readonly<{
    key: string;
    uploadId: string;
    partNumber: number;
    expiresInSeconds: number;
    now: Date;
  }>,
): Promise<string> {
  if (
    !validOptions(options) ||
    !validTarget(input.key, input.uploadId) ||
    !Number.isSafeInteger(input.partNumber) ||
    input.partNumber < 1 ||
    !Number.isSafeInteger(input.expiresInSeconds) ||
    input.expiresInSeconds < 1 ||
    input.expiresInSeconds > 604_800
  )
    throw new Error("invalid multipart part target");
  const date = dateParts(input.now);
  const host = `${options.accountId}.r2.cloudflarestorage.com`;
  const path = objectPath(options.bucket, input.key);
  const scope = `${date.short}/auto/s3/aws4_request`;
  const unsigned: readonly (readonly [string, string])[] = [
    ["partNumber", String(input.partNumber)],
    ["uploadId", input.uploadId],
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${options.accessKeyId}/${scope}`],
    ["X-Amz-Date", date.full],
    ["X-Amz-Expires", String(input.expiresInSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const query = canonicalQuery(unsigned);
  const canonicalRequest = ["PUT", path, query, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join(
    "\n",
  );
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    date.full,
    scope,
    await sha256Hex(encoder.encode(canonicalRequest)),
  ].join("\n");
  const signature = Array.from(
    await hmac(await signingKey(options.secretAccessKey, date.short), stringToSign),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `https://${host}${path}?${query}&X-Amz-Signature=${signature}`;
}

function parseUploadId(xml: string): string {
  const match = /<UploadId>([^<]+)<\/UploadId>/u.exec(xml);
  const value = match?.[1]
    ?.replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
  if (value === undefined || !uploadIdPattern.test(value))
    throw new Error("invalid multipart response");
  return value;
}

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function completeBody(parts: readonly VideoMultipartManifestPart[]): Uint8Array {
  const entries = parts
    .map(
      (part) =>
        `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`,
    )
    .join("");
  return encoder.encode(`<CompleteMultipartUpload>${entries}</CompleteMultipartUpload>`);
}

export function makeR2VideoMultipartGateway(
  options: R2VideoMultipartOptions,
): VideoMultipartUploadGateway {
  const partUrls = async (input: {
    key: string;
    uploadId: string;
    partNumbers: readonly number[];
    expiresInSeconds: number;
  }) => {
    const now = options.now?.() ?? new Date();
    const expiresAt = new Date(now.getTime() + input.expiresInSeconds * 1_000).toISOString();
    return Promise.all(
      input.partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await presignedPartUrl(options, {
          key: input.key,
          uploadId: input.uploadId,
          partNumber,
          expiresInSeconds: input.expiresInSeconds,
          now,
        }),
        expiresAt,
      })),
    );
  };
  const objectExists = async (key: string): Promise<boolean> => {
    const response = await signedRequest(options, { method: "HEAD", key, query: [] });
    if (response.ok) return true;
    if (response.status === 404) return false;
    throw new Error("multipart object inspection failed");
  };
  return {
    create: async ({ objectKey, contentType, partSizeBytes, partCount, expiresInSeconds }) => {
      if (!validTarget(objectKey) || !["video/mp4", "video/quicktime"].includes(contentType))
        throw new Error("invalid multipart target");
      const response = await signedRequest(options, {
        method: "POST",
        key: objectKey,
        query: [["uploads", ""]],
      });
      if (!response.ok) throw new Error("multipart creation failed");
      const uploadId = parseUploadId(await response.text());
      const parts = await partUrls({
        key: objectKey,
        uploadId,
        partNumbers: Array.from({ length: partCount }, (_, index) => index + 1),
        expiresInSeconds,
      });
      return {
        uploadId,
        partSizeBytes,
        partCount,
        parts,
        expiresAt: parts[0]?.expiresAt ?? new Date().toISOString(),
      };
    },
    renew: ({ objectKey, uploadId, partNumbers, expiresInSeconds }) =>
      partUrls({ key: objectKey, uploadId, partNumbers, expiresInSeconds }),
    completeOrInspect: async ({ objectKey, uploadId, parts }) => {
      if (await objectExists(objectKey)) return { completed: true };
      const body = completeBody(parts);
      try {
        const response = await signedRequest(options, {
          method: "POST",
          key: objectKey,
          query: [["uploadId", uploadId]],
          body,
        });
        if (response.ok) return { completed: true };
        if (response.status !== 404 || !(await objectExists(objectKey)))
          throw new Error("multipart completion failed");
        return { completed: true };
      } catch (error) {
        if (await objectExists(objectKey)) return { completed: true };
        throw error;
      }
    },
    abort: async ({ objectKey, uploadId }) => {
      if (!validTarget(objectKey, uploadId)) throw new Error("invalid multipart target");
      const response = await signedRequest(options, {
        method: "DELETE",
        key: objectKey,
        query: [["uploadId", uploadId]],
      });
      if (!response.ok && response.status !== 404) throw new Error("multipart abort failed");
    },
  };
}

import type { VideoMultipartUploadGateway } from "@pirate/application/video/publication";

const encoder = new TextEncoder();
const accountIdPattern = /^[0-9a-f]{32}$/u;
const bucketPattern = /^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?$/u;
const keyPattern = /^reservations\/media-reservation-[0-9a-f-]{36}\/source$/u;
const uploadIdPattern = /^[^\r\n]{1,1024}$/u;

export const VIDEO_MULTIPART_CORS_REQUIREMENTS = Object.freeze({
  methods: ["PUT"] as const,
  exposeHeaders: ["ETag"] as const,
});

/** The only R2 binding operations used by the multipart control plane. */
export type R2VideoMultipartControl = Readonly<{
  head: (key: string) => Promise<unknown | null>;
  createMultipartUpload: (
    key: string,
    options: Readonly<{ httpMetadata: Readonly<{ contentType: string }> }>,
  ) => Promise<Readonly<{ uploadId: string }>>;
  resumeMultipartUpload: (
    key: string,
    uploadId: string,
  ) => Readonly<{
    complete: (parts: Array<{ partNumber: number; etag: string }>) => Promise<unknown>;
    abort: () => Promise<void>;
  }>;
}>;

export type R2VideoMultipartOptions = Readonly<{
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketBinding: R2VideoMultipartControl;
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
  const objectExists = async (key: string): Promise<boolean> =>
    (await options.bucketBinding.head(key)) !== null;
  return {
    create: async ({ objectKey, contentType, partSizeBytes, partCount, expiresInSeconds }) => {
      if (
        !validOptions(options) ||
        !validTarget(objectKey) ||
        !["video/mp4", "video/quicktime"].includes(contentType) ||
        !Number.isSafeInteger(partSizeBytes) ||
        partSizeBytes < 1 ||
        !Number.isSafeInteger(partCount) ||
        partCount < 1 ||
        partCount > 10_000 ||
        !Number.isSafeInteger(expiresInSeconds) ||
        expiresInSeconds < 1 ||
        expiresInSeconds > 604_800
      )
        throw new Error("invalid multipart target");
      const upload = await options.bucketBinding.createMultipartUpload(objectKey, {
        httpMetadata: { contentType },
      });
      const uploadId = upload.uploadId;
      if (!uploadIdPattern.test(uploadId)) throw new Error("invalid multipart response");
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
      if (!validTarget(objectKey, uploadId)) throw new Error("invalid multipart target");
      if (await objectExists(objectKey)) return { completed: true };
      try {
        // R2 permits cross-API resume, including uploads initiated by the former S3 path.
        await options.bucketBinding
          .resumeMultipartUpload(objectKey, uploadId)
          .complete(parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })));
        return { completed: true };
      } catch (error) {
        if (await objectExists(objectKey)) return { completed: true };
        throw error;
      }
    },
    abort: async ({ objectKey, uploadId }) => {
      if (!validTarget(objectKey, uploadId)) throw new Error("invalid multipart target");
      await options.bucketBinding.resumeMultipartUpload(objectKey, uploadId).abort();
    },
  };
}

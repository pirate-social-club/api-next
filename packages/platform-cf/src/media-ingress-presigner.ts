import {
  MEDIA_INGRESS_UPLOAD_CONTENT_TYPE_HEADER,
  MEDIA_INGRESS_UPLOAD_EXPIRY_SECONDS,
  MEDIA_INGRESS_UPLOAD_METHOD,
  type MediaIngressUploadPresigner,
  MediaIngressUploadPresignFailed,
} from "@pirate/application";
import { Effect } from "effect";

const encoder = new TextEncoder();
const accountIdPattern = /^[0-9a-f]{32}$/u;
const bucketPattern = /^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?$/u;
const keyPattern =
  /^reservations\/media-reservation-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/source$/u;
const mediaTypePattern = /^audio\/[a-z0-9][a-z0-9.+-]{0,126}$/u;

export type MediaIngressPresignerOptions = Readonly<{
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  now?: () => Date;
}>;

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeObjectPath(bucket: string, key: string): string {
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
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(value).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key).buffer,
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

function amzDate(now: Date): Readonly<{ short: string; full: string }> {
  const iso = now.toISOString();
  const short = iso.slice(0, 10).replaceAll("-", "");
  return { short, full: `${short}T${iso.slice(11, 19).replaceAll(":", "")}Z` };
}

function validOptions(options: MediaIngressPresignerOptions): boolean {
  return (
    accountIdPattern.test(options.accountId) &&
    bucketPattern.test(options.bucket) &&
    options.accessKeyId.length > 0 &&
    options.accessKeyId.length <= 256 &&
    options.secretAccessKey.length > 0 &&
    options.secretAccessKey.length <= 4096 &&
    options.accessKeyId !== "PENDING" &&
    options.secretAccessKey !== "PENDING" &&
    !/[\r\n]/u.test(options.accessKeyId) &&
    !/[\r\n]/u.test(options.secretAccessKey)
  );
}

/** Creates an offline signer for one fixed, physically separate ingress bucket. */
export function makeR2MediaIngressPresigner(
  options: MediaIngressPresignerOptions,
): MediaIngressUploadPresigner["Service"] {
  return {
    presign: (request) =>
      Effect.tryPromise({
        try: async () => {
          const contentType = request.requiredSignedHeaders[0]?.value.toLowerCase();
          if (
            !validOptions(options) ||
            request.method !== MEDIA_INGRESS_UPLOAD_METHOD ||
            request.expiresInSeconds !== MEDIA_INGRESS_UPLOAD_EXPIRY_SECONDS ||
            request.requiredSignedHeaders.length !== 1 ||
            request.requiredSignedHeaders[0]?.name !== MEDIA_INGRESS_UPLOAD_CONTENT_TYPE_HEADER ||
            contentType === undefined ||
            !mediaTypePattern.test(contentType) ||
            !keyPattern.test(request.serverOwnedObjectKey) ||
            request.serverOwnedObjectKey.includes("..")
          ) {
            throw new MediaIngressUploadPresignFailed({ reason: "invalid-target" });
          }

          const now = options.now?.() ?? new Date();
          if (!Number.isFinite(now.getTime())) {
            throw new MediaIngressUploadPresignFailed({ reason: "unavailable" });
          }
          const date = amzDate(now);
          const host = `${options.accountId}.r2.cloudflarestorage.com`;
          const path = encodeObjectPath(options.bucket, request.serverOwnedObjectKey);
          const signedHeaders = "content-type;host";
          const scope = `${date.short}/auto/s3/aws4_request`;
          const unsignedQuery: readonly (readonly [string, string])[] = [
            ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
            ["X-Amz-Credential", `${options.accessKeyId}/${scope}`],
            ["X-Amz-Date", date.full],
            ["X-Amz-Expires", String(MEDIA_INGRESS_UPLOAD_EXPIRY_SECONDS)],
            ["X-Amz-SignedHeaders", signedHeaders],
          ];
          const canonical = canonicalQuery(unsignedQuery);
          const canonicalRequest = [
            MEDIA_INGRESS_UPLOAD_METHOD,
            path,
            canonical,
            `content-type:${contentType}\nhost:${host}\n`,
            signedHeaders,
            "UNSIGNED-PAYLOAD",
          ].join("\n");
          const stringToSign = [
            "AWS4-HMAC-SHA256",
            date.full,
            scope,
            await sha256Hex(encoder.encode(canonicalRequest)),
          ].join("\n");
          const signatureBytes = await hmac(
            await signingKey(options.secretAccessKey, date.short),
            stringToSign,
          );
          const signature = Array.from(signatureBytes, (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
          return {
            url: `https://${host}${path}?${canonical}&X-Amz-Signature=${signature}`,
            requiredHeaders: [
              { name: MEDIA_INGRESS_UPLOAD_CONTENT_TYPE_HEADER, value: contentType },
            ],
            expiresAt: new Date(
              now.getTime() + MEDIA_INGRESS_UPLOAD_EXPIRY_SECONDS * 1_000,
            ).toISOString(),
          };
        },
        catch: (error) =>
          error instanceof MediaIngressUploadPresignFailed
            ? error
            : new MediaIngressUploadPresignFailed({ reason: "unavailable" }),
      }),
  };
}

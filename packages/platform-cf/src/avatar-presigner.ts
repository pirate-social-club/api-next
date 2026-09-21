import type { AvatarReservation } from "@pirate/application/avatars/ports";
import {
  amzDate,
  canonicalQuery,
  encodeObjectPath,
  hmac,
  sha256Hex,
  signingKey,
} from "./r2-upload-signing.ts";

const encoder = new TextEncoder();
export type AvatarSigningOptions = Readonly<{
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}>;
/** Signs exact length as well as type; the browser supplies Content-Length for its Blob. */
export async function presignAvatar(options: AvatarSigningOptions, asset: AvatarReservation) {
  if (
    !/^[0-9a-f]{32}$/u.test(options.accountId) ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(options.bucket) ||
    !options.accessKeyId ||
    !options.secretAccessKey
  )
    throw new Error("Avatar signing unavailable");
  const now = new Date();
  const ttl = Math.floor((Date.parse(asset.uploadExpiresAt) - now.getTime()) / 1000);
  if (ttl < 1 || ttl > 600 || !/^ingress\/avatar-[0-9a-f-]{36}$/u.test(asset.ingressKey))
    throw new Error("Avatar reservation expired");
  const date = amzDate(now);
  const host = `${options.accountId}.r2.cloudflarestorage.com`;
  const path = encodeObjectPath(options.bucket, asset.ingressKey);
  const scope = `${date.short}/auto/s3/aws4_request`;
  const signedHeaders = "content-length;content-type;host";
  const query = canonicalQuery([
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${options.accessKeyId}/${scope}`],
    ["X-Amz-Date", date.full],
    ["X-Amz-Expires", String(ttl)],
    ["X-Amz-SignedHeaders", signedHeaders],
  ]);
  const canonical = [
    "PUT",
    path,
    query,
    `content-length:${asset.byteLength}\ncontent-type:${asset.contentType}\nhost:${host}\n`,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const toSign = [
    "AWS4-HMAC-SHA256",
    date.full,
    scope,
    await sha256Hex(encoder.encode(canonical)),
  ].join("\n");
  const signature = Array.from(
    await hmac(await signingKey(options.secretAccessKey, date.short), toSign),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return {
    url: `https://${host}${path}?${query}&X-Amz-Signature=${signature}`,
    requiredHeaders: [{ name: "content-type", value: asset.contentType }],
  };
}

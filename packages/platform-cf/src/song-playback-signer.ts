import type { SongPlaybackServices } from "@pirate/application/use-cases/content/song-playback";
import { SONG_PLAYBACK_LIFETIME_SECONDS } from "@pirate/application/use-cases/content/song-playback";
import { Effect } from "effect";
import { mediaProcessingPhysicalObjectKey } from "./media-immutable-object-key.ts";

const encoder = new TextEncoder();
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

/** Offline GET-only signer. Supply credentials restricted to the immutable audio bucket. */
export function makeSongPlaybackSigner(options: {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): SongPlaybackServices["sign"] {
  if (
    !/^[a-f0-9]{32}$/.test(options.accountId) ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket) ||
    !options.accessKeyId ||
    !options.secretAccessKey ||
    [options.accessKeyId, options.secretAccessKey].some(
      (value) => value === "PENDING" || /[\r\n]/.test(value),
    )
  )
    throw new Error("Invalid song playback signing configuration");
  return (input) =>
    Effect.tryPromise(async () => {
      if (
        input.lifetimeSeconds !== SONG_PLAYBACK_LIFETIME_SECONDS ||
        !Number.isSafeInteger(input.nowSeconds) ||
        input.nowSeconds < 0
      )
        throw new Error("Invalid song playback grant");
      const key = mediaProcessingPhysicalObjectKey(input.immutableRef);
      const date = amzDate(new Date(input.nowSeconds * 1000));
      const host = `${options.accountId}.r2.cloudflarestorage.com`;
      const path = encodeObjectPath(options.bucket, key);
      const scope = `${date.short}/auto/s3/aws4_request`;
      const query = canonicalQuery([
        ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
        ["X-Amz-Credential", `${options.accessKeyId}/${scope}`],
        ["X-Amz-Date", date.full],
        ["X-Amz-Expires", String(input.lifetimeSeconds)],
        ["X-Amz-SignedHeaders", "host"],
      ]);
      const request = ["GET", path, query, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
      const signature = await hmac(
        await signingKey(options.secretAccessKey, date.short),
        ["AWS4-HMAC-SHA256", date.full, scope, await sha256Hex(encoder.encode(request))].join("\n"),
      );
      return `https://${host}${path}?${query}&X-Amz-Signature=${Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    });
}

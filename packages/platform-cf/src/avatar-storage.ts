import { AvatarFailure, type AvatarStorage } from "@pirate/application/avatars/ports";
import { AVATAR_MAX_BYTES, AVATAR_MAX_PIXELS } from "@pirate/contracts";
import { Effect, Option, Schema } from "effect";
import { stripAvatarJpegMetadata } from "./avatar-jpeg.ts";
import { type AvatarSigningOptions, presignAvatar } from "./avatar-presigner.ts";

type AvatarObject = Readonly<{
  size: number;
  customMetadata?: Record<string, string>;
  httpMetadata?: { contentType?: string };
}>;
export type AvatarBucket = Readonly<{
  head: (key: string) => Promise<AvatarObject | null>;
  get: (key: string) => Promise<(AvatarObject & { body: ReadableStream<Uint8Array> }) | null>;
  put: (
    key: string,
    bytes: Uint8Array<ArrayBuffer>,
    options: {
      onlyIf: { etagDoesNotMatch: string };
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
    },
  ) => Promise<AvatarObject | null>;
  delete: (key: string) => Promise<void>;
}>;
type ImageInfo = { format: string; width?: number; height?: number };
export type AvatarImages = Readonly<{
  info: (stream: ReadableStream<Uint8Array>) => Promise<ImageInfo>;
  input: (stream: ReadableStream<Uint8Array>) => {
    transform: (options: {
      width: number;
      height: number;
      fit: "scale-down";
      background: string;
    }) => {
      output: (options: {
        format: "image/jpeg";
        quality: number;
        anim: false;
      }) => Promise<{ image: () => ReadableStream<Uint8Array> }>;
    };
  };
}>;
export type AvatarBindings = Readonly<{
  ingress?: AvatarBucket;
  sealed: AvatarBucket;
  images?: AvatarImages;
  signing?: AvatarSigningOptions;
}>;

const fail = (reason: AvatarFailure["reason"]) => new AvatarFailure({ reason });
async function boundedBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > AVATAR_MAX_BYTES) throw fail("invalid");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  if (length === 0) throw fail("invalid");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
const streamOf = (bytes: Uint8Array<ArrayBuffer>) => new Blob([bytes]).stream();
const invalidCodec = Schema.Struct({ code: Schema.Literal(9412) });
const attempt = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      error instanceof AvatarFailure
        ? error
        : Option.isSome(Schema.decodeUnknownOption(invalidCodec)(error))
          ? fail("invalid")
          : fail("unavailable"),
  }).pipe(
    Effect.timeout("20 seconds"),
    Effect.mapError((error) => (error instanceof AvatarFailure ? error : fail("unavailable"))),
  );

export function makeAvatarStorage(bindings: AvatarBindings): AvatarStorage {
  return {
    presign: (asset) =>
      attempt(async () => {
        if (!bindings.signing) throw fail("unavailable");
        return presignAvatar(bindings.signing, asset);
      }),
    seal: (asset) =>
      attempt(async (signal) => {
        if (!bindings.ingress || !bindings.images) throw fail("unavailable");
        const existing = await bindings.sealed.head(asset.sealedKey);
        if (existing) {
          const metadata = existing.customMetadata;
          if (
            metadata?.asset !== asset.assetId ||
            !/^[0-9a-f]{64}$/u.test(metadata.digest ?? "") ||
            existing.httpMetadata?.contentType !== "image/jpeg" ||
            !Number.isSafeInteger(existing.size) ||
            existing.size < 1 ||
            existing.size > AVATAR_MAX_BYTES ||
            ![Number(metadata.width), Number(metadata.height)].every(
              (value) => Number.isSafeInteger(value) && value >= 1 && value <= 512,
            )
          )
            throw fail("unavailable");
          return {
            digest: metadata.digest ?? "",
            width: Number(metadata.width),
            height: Number(metadata.height),
            byteLength: existing.size,
          };
        }
        const source = await bindings.ingress.get(asset.ingressKey);
        if (!source) throw fail("invalid");
        if (
          source.size !== asset.byteLength ||
          source.size > AVATAR_MAX_BYTES ||
          source.httpMetadata?.contentType !== asset.contentType
        ) {
          await source.body.cancel();
          throw fail("invalid");
        }
        const bytes = await boundedBytes(source.body);
        if (bytes.byteLength !== asset.byteLength) throw fail("invalid");
        const info = await bindings.images.info(streamOf(bytes));
        if (
          info.width === undefined ||
          info.height === undefined ||
          info.format !== asset.contentType ||
          !Number.isSafeInteger(info.width) ||
          !Number.isSafeInteger(info.height) ||
          info.width < 1 ||
          info.height < 1 ||
          info.width * info.height > AVATAR_MAX_PIXELS
        )
          throw fail("invalid");
        const output = await bindings.images
          .input(streamOf(bytes))
          .transform({ width: 512, height: 512, fit: "scale-down", background: "#ffffff" })
          .output({ format: "image/jpeg", quality: 85, anim: false });
        const normalized = stripAvatarJpegMetadata(await boundedBytes(output.image()));
        const normalizedInfo = await bindings.images.info(streamOf(normalized));
        if (
          normalizedInfo.width === undefined ||
          normalizedInfo.height === undefined ||
          normalizedInfo.format !== "image/jpeg" ||
          normalizedInfo.width < 1 ||
          normalizedInfo.height < 1 ||
          normalizedInfo.width > 512 ||
          normalizedInfo.height > 512
        )
          throw fail("invalid");
        const digest = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", normalized)),
          (b) => b.toString(16).padStart(2, "0"),
        ).join("");
        signal.throwIfAborted();
        const stored = await bindings.sealed.put(asset.sealedKey, normalized, {
          onlyIf: { etagDoesNotMatch: "*" },
          httpMetadata: { contentType: "image/jpeg" },
          customMetadata: {
            asset: asset.assetId,
            digest,
            width: String(normalizedInfo.width),
            height: String(normalizedInfo.height),
          },
        });
        if (!stored) throw fail("unavailable");
        return {
          digest,
          width: normalizedInfo.width,
          height: normalizedInfo.height,
          byteLength: normalized.byteLength,
        };
      }),
    read: (key) => attempt(async () => (await bindings.sealed.get(key))?.body ?? null),
    delete: (key) =>
      attempt(async () => {
        const bucket = key.startsWith("ingress/") ? bindings.ingress : bindings.sealed;
        if (!bucket) throw fail("unavailable");
        await bucket.delete(key);
      }),
  };
}

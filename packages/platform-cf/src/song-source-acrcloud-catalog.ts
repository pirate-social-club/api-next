import type {
  SongSourceCatalog,
  SongSourceCatalogFile,
  SongSourceCatalogLookup,
  SongSourceRegistration,
} from "@pirate/application/media/source-recording-authority";
import { Schema } from "effect";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const CatalogFile = Schema.Struct({
  id: Schema.Union([Schema.Number, Schema.String]),
  bucket_id: Schema.Union([Schema.Number, Schema.String]),
  acr_id: Text,
  state: Schema.Literals([-1, 0, 1]),
  title: Text,
  user_defined: Schema.Struct({
    registration_id: Text,
    asset_id: Text,
    canonical_audio_sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  }),
});
const UploadResponse = Schema.Struct({ data: CatalogFile });
const ListResponse = Schema.Struct({ data: Schema.Array(CatalogFile) });

export type SongSourceAcrCloudCatalogRequest = Readonly<{
  method: "GET" | "POST";
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: FormData;
  signal: AbortSignal;
  redirect: "error";
}>;

export type SongSourceAcrCloudCatalogResponse = Readonly<{
  status: number;
  body: ReadableStream<Uint8Array>;
}>;

export type SongSourceAcrCloudCatalogOptions = Readonly<{
  origin: string;
  bucketId: string;
  token: string;
  maxResponseBytes: number;
  maxAudioBytes: number;
  request: (
    request: SongSourceAcrCloudCatalogRequest,
  ) => Promise<SongSourceAcrCloudCatalogResponse>;
}>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const state = (value: -1 | 0 | 1): SongSourceCatalogFile["state"] =>
  value === 1 ? "ready" : value === 0 ? "processing" : "error";

const normalize = (value: Schema.Schema.Type<typeof CatalogFile>): SongSourceCatalogFile => ({
  providerFileId: String(value.id),
  providerMatchId: value.acr_id,
  bucketId: String(value.bucket_id),
  opaqueTitle: value.title,
  state: state(value.state),
  registrationId: value.user_defined.registration_id,
  assetId: value.user_defined.asset_id,
  canonicalAudioSha256: value.user_defined.canonical_audio_sha256,
});

async function readBounded(
  response: SongSourceAcrCloudCatalogResponse,
  maximum: number,
): Promise<Uint8Array> {
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) throw new Error("catalog-response-too-large");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function configuration(options: SongSourceAcrCloudCatalogOptions):
  | Readonly<{
      ok: true;
      origin: string;
    }>
  | Readonly<{ ok: false }> {
  try {
    const parsed = new URL(options.origin);
    const validHost =
      parsed.hostname === "api-v2.acrcloud.com" ||
      /^api-[a-z0-9-]+\.acrcloud\.com$/u.test(parsed.hostname);
    if (
      parsed.protocol !== "https:" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      !validHost ||
      !/^[1-9][0-9]*$/u.test(options.bucketId) ||
      options.token.length < 8 ||
      !Number.isSafeInteger(options.maxResponseBytes) ||
      options.maxResponseBytes < 1 ||
      options.maxResponseBytes > 1_048_576 ||
      !Number.isSafeInteger(options.maxAudioBytes) ||
      options.maxAudioBytes < 1 ||
      options.maxAudioBytes > 100_000_000 ||
      typeof options.request !== "function"
    ) {
      return { ok: false };
    }
    return { ok: true, origin: parsed.origin };
  } catch {
    return { ok: false };
  }
}

/** Console API catalog adapter. Credential-bearing requests never redirect. */
export function makeSongSourceAcrCloudCatalog(
  options: SongSourceAcrCloudCatalogOptions,
): SongSourceCatalog {
  const config = configuration(options);
  const headers = { accept: "application/json", authorization: `Bearer ${options.token}` };
  const endpoint = (registration: SongSourceRegistration): string =>
    `${config.ok ? config.origin : "https://invalid.invalid"}/api/buckets/${encodeURIComponent(registration.bucketId)}/files`;

  const list = async (
    registration: SongSourceRegistration,
    signal: AbortSignal,
  ): Promise<SongSourceCatalogLookup> => {
    if (!config.ok || registration.bucketId !== options.bucketId) {
      return { outcome: "rejected", reason: "catalog_configuration_invalid" };
    }
    let response: SongSourceAcrCloudCatalogResponse;
    try {
      const url = new URL(endpoint(registration));
      url.searchParams.set("search", registration.opaqueTitle);
      url.searchParams.set("sort", "id");
      url.searchParams.set("order", "asc");
      url.searchParams.set("page", "1");
      url.searchParams.set("per_page", "3");
      response = await options.request({
        method: "GET",
        url: url.toString(),
        headers,
        signal,
        redirect: "error",
      });
    } catch {
      return { outcome: "retryable", reason: "transport" };
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return { outcome: "rejected", reason: "catalog_configuration_invalid" };
    }
    if (response.status === 429 || response.status >= 500) {
      return { outcome: "retryable", reason: "provider" };
    }
    if (response.status !== 200) return { outcome: "rejected", reason: "provider_rejected" };
    try {
      const bytes = await readBounded(response, options.maxResponseBytes);
      const decoded = Schema.decodeUnknownSync(ListResponse)(JSON.parse(decoder.decode(bytes)));
      const exact = decoded.data
        .map(normalize)
        .filter(
          (entry) =>
            entry.opaqueTitle === registration.opaqueTitle &&
            entry.bucketId === registration.bucketId &&
            entry.registrationId === registration.registrationId &&
            entry.assetId === registration.assetId &&
            entry.canonicalAudioSha256 === registration.canonicalAudioSha256,
        );
      return exact.length === 0
        ? { outcome: "none" }
        : exact.length === 1
          ? { outcome: "exact", file: exact[0] as SongSourceCatalogFile }
          : { outcome: "ambiguous" };
    } catch {
      return { outcome: "rejected", reason: "malformed_response" };
    }
  };

  return {
    findExact: list,
    get: async (registration, providerFileId, signal) => {
      const found = await list(registration, signal);
      if (found.outcome !== "exact") return found;
      return found.file.providerFileId === providerFileId ? found : { outcome: "ambiguous" };
    },
    upload: async (registration, audio, signal) => {
      if (!config.ok || registration.bucketId !== options.bucketId) {
        return {
          outcome: "rejected",
          reason: "catalog_configuration_invalid",
          evidenceDigest: await digest(encoder.encode("configuration-invalid")),
        };
      }
      if (audio.bytes.byteLength < 1 || audio.bytes.byteLength > options.maxAudioBytes) {
        return {
          outcome: "rejected",
          reason: "audio_size_invalid",
          evidenceDigest: await digest(encoder.encode("audio-size-invalid")),
        };
      }
      const body = new FormData();
      body.set("title", registration.opaqueTitle);
      body.set("data_type", "audio");
      body.set(
        "user_defined",
        JSON.stringify({
          registration_id: registration.registrationId,
          asset_id: registration.assetId,
          canonical_audio_sha256: registration.canonicalAudioSha256,
        }),
      );
      body.set("file", new Blob([audio.bytes], { type: audio.contentType }), audio.filename);
      let response: SongSourceAcrCloudCatalogResponse;
      try {
        response = await options.request({
          method: "POST",
          url: endpoint(registration),
          headers,
          body,
          signal,
          redirect: "error",
        });
      } catch {
        return {
          outcome: "ambiguous",
          evidenceDigest: await digest(encoder.encode("transport-outcome-unknown")),
        };
      }
      let bytes: Uint8Array;
      try {
        bytes = await readBounded(response, options.maxResponseBytes);
      } catch {
        return {
          outcome: "ambiguous",
          evidenceDigest: await digest(encoder.encode("response-outcome-unknown")),
        };
      }
      const evidenceDigest = await digest(bytes);
      if (response.status < 200 || response.status >= 300) {
        return response.status >= 400 && response.status < 500 && response.status !== 429
          ? { outcome: "rejected", reason: "provider_rejected", evidenceDigest }
          : { outcome: "ambiguous", evidenceDigest };
      }
      try {
        const decoded = Schema.decodeUnknownSync(UploadResponse)(JSON.parse(decoder.decode(bytes)));
        const file = normalize(decoded.data);
        return { outcome: "accepted", file, evidenceDigest };
      } catch {
        return { outcome: "ambiguous", evidenceDigest };
      }
    },
  };
}

export const songSourceCatalogResponse = (value: unknown): SongSourceAcrCloudCatalogResponse => ({
  status: 200,
  body: new Blob([encoder.encode(JSON.stringify(value))]).stream(),
});

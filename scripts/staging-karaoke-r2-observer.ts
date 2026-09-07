import { Schema } from "effect";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  HeadEvidence,
  UploadListEvidence,
} from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import { type StagingCredentials, signR2Request } from "./media/r2-seal-probe-staging-signing.ts";

export const STAGING_KARAOKE_BUCKET = "pirate-learner-audio-staging";
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const List = Schema.Struct({
  ListMultipartUploadsResult: Schema.Struct({
    Bucket: Schema.Literal(STAGING_KARAOKE_BUCKET),
    Prefix: Schema.String,
    IsTruncated: Schema.Literals(["true", "false"]),
    NextKeyMarker: Schema.optional(Schema.String),
    NextUploadIdMarker: Schema.optional(Schema.String),
    Upload: Schema.optional(
      Schema.Array(Schema.Struct({ Key: Text, UploadId: Text })).check(Schema.isMaxLength(1000)),
    ),
  }),
});
const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: false,
  processEntities: true,
  isArray: (name) => name === "Upload",
});

export function parseKaraokeMultipartPage(xml: string, expectedPrefix: string) {
  if (Buffer.byteLength(xml) > 1_048_576 || /<!/u.test(xml) || XMLValidator.validate(xml) !== true)
    throw new Error("karaoke_r2_xml_denied");
  const result = Schema.decodeUnknownSync(List)(parser.parse(xml)).ListMultipartUploadsResult;
  if (
    result.Prefix !== expectedPrefix ||
    (result.Upload ?? []).some((entry) => !entry.Key.startsWith(expectedPrefix))
  )
    throw new Error("karaoke_r2_prefix_denied");
  const next =
    result.IsTruncated === "true"
      ? { key: result.NextKeyMarker, uploadId: result.NextUploadIdMarker }
      : null;
  if (next !== null && (!next.key || !next.uploadId || !next.key.startsWith(expectedPrefix)))
    throw new Error("karaoke_r2_marker_missing");
  return {
    uploads: (result.Upload ?? []).map((entry) => ({ key: entry.Key, uploadId: entry.UploadId })),
    nextMarker:
      next === null
        ? null
        : Schema.decodeUnknownSync(Schema.Struct({ key: Text, uploadId: Text }))(next),
  };
}

async function boundedXml(response: Response) {
  if (response.status !== 200 || response.body === null) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("karaoke_r2_list_denied");
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(1_048_576);
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (length + next.value.byteLength > bytes.length) throw new Error("karaoke_r2_size");
      bytes.set(next.value, length);
      length += next.value.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

/** Exact frozen authority only. This reader has no PUT, abort or delete method. */
export function makeStagingKaraokeR2Observer(input: {
  readonly accountId: string;
  readonly credentials: StagingCredentials;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => Date;
}) {
  if (
    !/^[a-f0-9]{32}$/u.test(input.accountId) ||
    !input.credentials.accessKeyId ||
    !input.credentials.secretAccessKey
  )
    throw new Error("karaoke_r2_configuration_denied");
  const transport = input.fetch ?? globalThis.fetch;
  const request = async (
    method: "GET" | "HEAD",
    signal: AbortSignal,
    key?: string,
    query?: Record<string, string>,
  ) => {
    signal.throwIfAborted();
    const signed = await signR2Request({
      accountId: input.accountId,
      credentials: input.credentials,
      bucket: STAGING_KARAOKE_BUCKET,
      method,
      ...(key === undefined ? {} : { key }),
      ...(query === undefined ? {} : { query }),
      ...(input.now ? { now: input.now() } : {}),
    });
    return transport(signed.url, { method, headers: signed.headers, redirect: "manual", signal });
  };
  const metadata = (response: Response) => {
    const requestId = response.headers.get("x-amz-request-id") ?? response.headers.get("cf-ray");
    if (requestId === null || requestId.length < 1 || requestId.length > 1024) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("karaoke_r2_receipt_missing");
    }
    return {
      endpointKind: "staging-bucket-s3" as const,
      bucket: STAGING_KARAOKE_BUCKET,
      requestId,
      status: response.status,
    };
  };
  const verifyBucket = async (signal: AbortSignal) => {
    const response = await request("HEAD", signal);
    void response.body?.cancel().catch(() => undefined);
    if (response.status !== 200) throw new Error("karaoke_r2_bucket_unproven");
    return metadata(response);
  };
  return {
    async observe(authority: { readonly accountId: string; readonly attemptId: string }) {
      if (
        ![authority.accountId, authority.attemptId].every((value) =>
          /^[a-zA-Z0-9_-]{1,256}$/u.test(value),
        )
      )
        throw new Error("karaoke_r2_authority_denied");
      const key = `karaoke/${authority.accountId}/${authority.attemptId}.pcm`;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            await verifyBucket(controller.signal);
            const pages: (typeof UploadListEvidence.Type)["pages"][number][] = [];
            let marker: { key: string; uploadId: string } | null = null;
            const seen = new Set<string>();
            for (let page = 0; page < 64; page++) {
              const serialized = JSON.stringify(marker);
              if (seen.has(serialized)) throw new Error("karaoke_r2_pagination_cycle");
              seen.add(serialized);
              const response = await request("GET", controller.signal, undefined, {
                uploads: "",
                prefix: key,
                ...(marker === null
                  ? {}
                  : { "key-marker": marker.key, "upload-id-marker": marker.uploadId }),
              });
              const receipt = metadata(response);
              const parsed = parseKaraokeMultipartPage(await boundedXml(response), key);
              pages.push({
                marker,
                nextMarker: parsed.nextMarker,
                succeeded: true,
                response: receipt,
                prefix: key,
                uploads: parsed.uploads,
              });
              marker = parsed.nextMarker;
              if (marker === null) break;
            }
            if (marker !== null) throw new Error("karaoke_r2_pages_exhausted");
            const head = await request("HEAD", controller.signal, key);
            void head.body?.cancel().catch(() => undefined);
            if (head.status !== 200 && head.status !== 404)
              throw new Error("karaoke_r2_head_denied");
            const headReceipt = metadata(head);
            await verifyBucket(controller.signal);
            return {
              uploads: Schema.decodeUnknownSync(UploadListEvidence)({ key, pages }),
              head: Schema.decodeUnknownSync(HeadEvidence)({
                key,
                bucketVerified: true,
                response: headReceipt,
                state: head.status === 200 ? "present" : "absent",
              }),
            };
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("karaoke_r2_timeout"));
            }, 15_000);
          }),
        ]);
      } catch {
        throw new Error("karaoke_r2_observation_failed");
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        controller.abort();
      }
    },
  };
}

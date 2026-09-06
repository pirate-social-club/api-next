import type { VideoStreamIngestServices } from "@pirate/application/video/stream-ingest";
import { Schema } from "effect";
import { mediaProcessingPhysicalObjectKey } from "./media-immutable-object-key.ts";
import type { QencodeSourceGrantIssuer } from "./qencode-media-transform.ts";
import { makeVideoSourceUrl } from "./video-source-gateway.ts";

const Text = Schema.String.check(Schema.isPattern(/^\S+$/u));
const Video = Schema.Struct({
  uid: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
  creator: Text,
  meta: Schema.Struct({ source_sha256: Text, operation_id: Text }),
  requireSignedURLs: Schema.Boolean,
  readyToStream: Schema.optionalKey(Schema.Boolean),
  status: Schema.Struct({
    state: Schema.Literals([
      "pendingupload",
      "downloading",
      "queued",
      "inprogress",
      "ready",
      "error",
    ]),
  }),
});
const Videos = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Array(Video).check(Schema.isMaxLength(2)),
});
const Downloads = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Record(Schema.String, Schema.Unknown),
});
const Copy = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({ uid: Video.fields.uid }),
});

/** No SDK retries: only the interpreter's initial persisted intent permits POST. */
export function makeVideoStreamTransport(
  input: Readonly<{
    accountId: string;
    apiToken: string;
    sourceGatewayOrigin: string;
    grants: QencodeSourceGrantIssuer;
    fetch: typeof fetch;
    nowMs: () => number;
  }>,
): VideoStreamIngestServices["transport"] {
  if (
    !/^[a-f0-9]{32}$/u.test(input.accountId) ||
    typeof input.apiToken !== "string" ||
    !/^\S+$/u.test(input.apiToken)
  )
    throw new Error("Missing or invalid Stream deployment credentials");
  makeVideoSourceUrl(input.sourceGatewayOrigin, "a".repeat(43));
  const base = `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/stream`;
  async function request(path: string, body?: unknown): Promise<unknown> {
    // Bound both headers and body. Never retain provider bodies, source grants or tokens in errors.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await input.fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${input.apiToken}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("Stream request failed");
      }
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > 262_144)) {
        await response.body.cancel();
        throw new Error("Stream response exceeds bound");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 262_144) throw new Error("Stream response exceeds bound");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("Stream transport unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async copy(source) {
      if (
        !source.requireSignedURLs ||
        source.downloadsEnabled ||
        !Number.isSafeInteger(source.acceptanceDeadlineMs) ||
        source.acceptanceDeadlineMs <= input.nowMs()
      )
        throw new Error("Invalid Stream copy policy or expired intent");
      const grant = await input.grants.issue({
        objectKey: mediaProcessingPhysicalObjectKey(source.sealedSourceRef),
        requestId: source.identity.operationId,
        sha256: source.identity.sourceSha256,
        byteLength: source.sourceByteLength,
        mediaType: source.sourceMediaType,
        expiresAtMs: source.acceptanceDeadlineMs,
      });
      if (grant.expiresAtMs !== source.acceptanceDeadlineMs || grant.expiresAtMs <= input.nowMs())
        throw new Error("Stream source grant expired or mismatched");
      const capability = grant.url.slice(grant.url.lastIndexOf("/") + 1);
      if (
        !/^[A-Za-z0-9_-]{43}$/u.test(capability) ||
        grant.url !== makeVideoSourceUrl(input.sourceGatewayOrigin, capability)
      )
        throw new Error("Stream source grant origin or path mismatch");
      // Downloads are opt-in via a separate API; this adapter never creates them.
      const copied = await request("/copy", {
        input: grant.url,
        creator: source.identity.creator,
        meta: {
          source_sha256: source.identity.sourceSha256,
          operation_id: source.identity.operationId,
        },
        requireSignedURLs: true,
      });
      try {
        Schema.decodeUnknownSync(Copy)(copied);
      } catch {
        throw new Error("Stream copy acknowledgement unavailable");
      }
      // The copy response is deliberately not authority. Recovery always observes by creator.
    },
    async observe(identity) {
      try {
        // Two is sufficient to establish ambiguity; never silently select the first match.
        const data = Schema.decodeUnknownSync(Videos)(
          await request(`?creator=${encodeURIComponent(identity.creator)}&limit=2`),
        );
        const observations = [];
        for (const video of data.result) {
          const downloads = Schema.decodeUnknownSync(Downloads)(
            await request(`/${video.uid}/downloads`),
          );
          observations.push({
            providerVideoId: video.uid,
            creator: video.creator,
            sourceSha256:
              video.meta.operation_id === identity.operationId ? video.meta.source_sha256 : "",
            requireSignedURLs: video.requireSignedURLs,
            downloadsEnabled: Object.keys(downloads.result).length !== 0,
            encoding:
              video.status.state === "error"
                ? ("error" as const)
                : video.status.state === "ready" && video.readyToStream === true
                  ? ("ready" as const)
                  : ("pending" as const),
          });
        }
        return observations;
      } catch {
        throw new Error("Stream observation unavailable");
      }
    },
  };
}

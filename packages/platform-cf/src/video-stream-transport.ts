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
/** One bounded diagnostic event per failed Stream step. Never carries a URL,
 * source grant, token or response body beyond Stream's codes and messages. */
export type VideoStreamTransportEvent = Readonly<{
  event: "stream_step_failed";
  step: "copy" | "observe" | "downloads" | "grant_issue" | "copy_ack";
  status?: number;
  codes?: readonly number[];
  messages?: readonly string[];
  error?: string;
}>;

function streamOperation(path: string): "copy" | "observe" | "downloads" {
  return path === "/copy" ? "copy" : path.endsWith("/downloads") ? "downloads" : "observe";
}

/** Stream error text, with any URL removed and length bounded. */
function sanitizeStreamMessage(value: unknown): string {
  return String(value ?? "")
    .replace(/https?:\/\/\S+/gu, "<url>")
    .slice(0, 200);
}

async function readStreamFailure(
  response: Response,
): Promise<{ codes: number[]; messages: string[] }> {
  try {
    const reader = response.body?.getReader();
    if (!reader) return { codes: [], messages: [] };
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (size < 8_192) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const text = new TextDecoder().decode(
      Uint8Array.from(chunks.flatMap((c) => [...c])).slice(0, 8_192),
    );
    const parsed = JSON.parse(text) as { errors?: unknown; messages?: unknown };
    const list = (value: unknown) =>
      (Array.isArray(value) ? value : []) as { code?: unknown; message?: unknown }[];
    const entries = [...list(parsed.errors), ...list(parsed.messages)].slice(0, 5);
    return {
      codes: entries.map((e) => e.code).filter((c): c is number => Number.isSafeInteger(c)),
      messages: entries.map((e) => sanitizeStreamMessage(e.message)).filter((m) => m.length > 0),
    };
  } catch {
    return { codes: [], messages: [] };
  }
}

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
    /** Diagnostic sink; defaults to one JSON line on the Worker log. */
    log?: (event: VideoStreamTransportEvent) => void;
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
  // Called unbound: workerd rejects the global fetch invoked as a method of
  // another object ("Illegal invocation"), which Bun and Node allow.
  const send = input.fetch;
  const log =
    input.log ?? ((event: VideoStreamTransportEvent) => console.log(JSON.stringify(event)));
  async function request(path: string, body?: unknown): Promise<unknown> {
    // Bound both headers and body. Never retain provider bodies, source grants or tokens in errors.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const step = streamOperation(path);
    let logged = false;
    try {
      const response = await send(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${input.apiToken}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        // Workerd supports manual/follow, not error. Non-2xx below rejects every
        // redirect without forwarding credentials or a source grant to another host.
        redirect: "manual",
      });
      if (!response.ok || !response.body) {
        const failure = await readStreamFailure(response);
        log({ event: "stream_step_failed", step, status: response.status, ...failure });
        logged = true;
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
    } catch (error) {
      if (!logged) {
        log({
          event: "stream_step_failed",
          step,
          error: error instanceof Error ? error.name : "unknown",
        });
      }
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
        source.acceptanceDeadlineMs <= input.nowMs() ||
        !Number.isSafeInteger(source.encodingDeadlineMs) ||
        source.encodingDeadlineMs < source.acceptanceDeadlineMs
      )
        throw new Error("Invalid Stream copy policy or expired intent");
      let grant: Awaited<ReturnType<QencodeSourceGrantIssuer["issue"]>>;
      try {
        grant = await input.grants.issue({
          objectKey: mediaProcessingPhysicalObjectKey(source.sealedSourceRef),
          requestId: source.identity.operationId,
          sha256: source.identity.sourceSha256,
          byteLength: source.sourceByteLength,
          mediaType: source.sourceMediaType,
          expiresAtMs: source.encodingDeadlineMs,
        });
      } catch (error) {
        log({
          event: "stream_step_failed",
          step: "grant_issue",
          error: error instanceof Error ? error.name : "unknown",
        });
        throw error;
      }
      if (grant.expiresAtMs !== source.encodingDeadlineMs || grant.expiresAtMs <= input.nowMs())
        throw new Error("Stream source grant expired or mismatched");
      const capability = grant.url.slice(grant.url.lastIndexOf("/") + 1);
      if (
        !/^[A-Za-z0-9_-]{43}$/u.test(capability) ||
        grant.url !== makeVideoSourceUrl(input.sourceGatewayOrigin, capability)
      )
        throw new Error("Stream source grant origin or path mismatch");
      // Downloads are opt-in via a separate API; this adapter never creates them.
      // Stream's copy contract names the source link `url` ("Upload via link").
      const copied = await request("/copy", {
        url: grant.url,
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
        log({ event: "stream_step_failed", step: "copy_ack" });
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

import { Schema } from "effect";
import { ActionsEvidence } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import { type StagingCredentials, signR2Request } from "./media/r2-seal-probe-staging-signing.ts";
import {
  type makeStagingKaraokeR2Observer,
  STAGING_KARAOKE_BUCKET,
} from "./staging-karaoke-r2-observer.ts";

export type KaraokeR2CleanObservation = Awaited<
  ReturnType<ReturnType<typeof makeStagingKaraokeR2Observer>["observe"]>
>;

/** Exact frozen authority only. Every action derives from the caller's verified
 * before-observation; this module never invents keys, upload IDs or adjacent
 * keys sharing the exact-key prefix. Failed provider responses are recorded as
 * failed actions; a response without a request receipt aborts the command. */
export function makeStagingKaraokeR2Cleaner(input: {
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
    throw new Error("karaoke_r2_cleaner_configuration_denied");
  const transport = input.fetch ?? globalThis.fetch;
  const remove = async (key: string, query: Record<string, string> | undefined) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          controller.signal.throwIfAborted();
          const signed = await signR2Request({
            accountId: input.accountId,
            credentials: input.credentials,
            bucket: STAGING_KARAOKE_BUCKET,
            method: "DELETE",
            key,
            ...(query === undefined ? {} : { query }),
            ...(input.now ? { now: input.now() } : {}),
          });
          const response = await transport(signed.url, {
            method: "DELETE",
            headers: signed.headers,
            redirect: "manual",
            signal: controller.signal,
          });
          void response.body?.cancel().catch(() => undefined);
          const requestId =
            response.headers.get("x-amz-request-id") ?? response.headers.get("cf-ray");
          if (requestId === null || requestId.length < 1 || requestId.length > 1024)
            throw new Error("karaoke_r2_receipt_missing");
          return { status: response.status, requestId };
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("karaoke_r2_cleaner_timeout"));
          }, 15_000);
        }),
      ]);
    } catch {
      throw new Error("karaoke_r2_cleaner_failed");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  };
  return {
    /** Aborts every observed upload of the exact key and deletes the observed
     * head object. Adjacent keys sharing the prefix are never removed. */
    async clean(
      authority: { readonly accountId: string; readonly attemptId: string },
      observation: KaraokeR2CleanObservation,
    ) {
      if (
        ![authority.accountId, authority.attemptId].every((value) =>
          /^[a-zA-Z0-9_-]{1,256}$/u.test(value),
        )
      )
        throw new Error("karaoke_r2_cleaner_authority_denied");
      const key = `karaoke/${authority.accountId}/${authority.attemptId}.pcm`;
      if (observation.uploads.key !== key || observation.head.key !== key)
        throw new Error("karaoke_r2_cleaner_observation_denied");
      const outcome = (status: number) =>
        status === 404
          ? ("not-found" as const)
          : status >= 200 && status < 300
            ? ("succeeded" as const)
            : ("failed" as const);
      const actions: (typeof ActionsEvidence.Type)[number][] = [];
      const aborted = new Set<string>();
      for (const page of observation.uploads.pages)
        for (const upload of page.uploads) {
          if (upload.key !== key || aborted.has(upload.uploadId)) continue;
          const { status, requestId } = await remove(key, { uploadId: upload.uploadId });
          aborted.add(upload.uploadId);
          actions.push({
            kind: "abort",
            key,
            uploadId: upload.uploadId,
            outcome: outcome(status),
            response: {
              endpointKind: "staging-bucket-s3",
              bucket: STAGING_KARAOKE_BUCKET,
              requestId,
              status,
            },
          });
        }
      if (observation.head.state === "present") {
        const { status, requestId } = await remove(key, undefined);
        actions.push({
          kind: "delete",
          key,
          uploadId: null,
          outcome: outcome(status),
          response: {
            endpointKind: "staging-bucket-s3",
            bucket: STAGING_KARAOKE_BUCKET,
            requestId,
            status,
          },
        });
      }
      return Schema.decodeUnknownSync(ActionsEvidence)(actions);
    },
  };
}

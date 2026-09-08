import {
  decodeReconciliation,
  reconciliationMillis,
} from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import { KaraokeResetSnapshotSchema } from "../packages/platform-cf/src/karaoke-reset-inspection.ts";
import { KaraokeResetTarget } from "../packages/platform-cf/src/karaoke-reset-installation.ts";

/** Read-only Access-protected caller. No apply fallback, redirects or token logs. */
export async function inspectStagingKaraokeObject(input: {
  readonly origin: string;
  readonly assertion: string;
  readonly target: typeof KaraokeResetTarget.Type;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}) {
  const origin = new URL(input.origin);
  const target = decodeReconciliation(KaraokeResetTarget, input.target);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== input.origin ||
    origin.port !== "" ||
    origin.username !== "" ||
    origin.password !== "" ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(input.assertion) ||
    input.assertion.length > 16_384
  )
    throw new Error("karaoke_inspection_configuration_denied");
  const clock = input.now ?? Date.now;
  const started = clock();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel"> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await (input.fetch ?? globalThis.fetch)(`${input.origin}/inspect`, {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            origin: input.origin,
            "content-type": "application/json",
            accept: "application/json",
            cookie: `CF_Authorization=${input.assertion}`,
          },
          body: JSON.stringify(target),
        });
        if (
          response.status !== 200 ||
          response.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
        ) {
          void response.body?.cancel().catch(() => undefined);
          throw new Error("karaoke_inspection_response_denied");
        }
        reader = response.body?.getReader();
        if (reader === undefined) throw new Error("karaoke_inspection_body_missing");
        const bytes = new Uint8Array(32_768);
        let size = 0;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          if (size + next.value.byteLength > bytes.byteLength)
            throw new Error("karaoke_inspection_body_limit");
          bytes.set(next.value, size);
          size += next.value.byteLength;
        }
        const snapshot = decodeReconciliation(
          KaraokeResetSnapshotSchema,
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))),
        );
        const observed = reconciliationMillis(snapshot.observedAt);
        if (
          Object.entries(target).some(([key, value]) => Reflect.get(snapshot, key) !== value) ||
          observed < started ||
          observed > clock()
        )
          throw new Error("karaoke_inspection_identity_or_time_denied");
        return snapshot;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("karaoke_inspection_timeout"));
        }, 5_000);
      }),
    ]);
  } catch {
    // Provider and transport errors may carry bearer data; do not propagate them.
    throw new Error("karaoke_inspection_failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    if (reader !== undefined) void reader.cancel().catch(() => undefined);
  }
}

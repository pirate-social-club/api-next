import { Schema } from "effect";
import { readBoundedStream } from "./media-processing-runtime.ts";
import { makeModeratedDancePublicationInput } from "./moderated-dance-publication-input.ts";

const Id = Schema.NonEmptyString.check(Schema.isMaxLength(192));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Millis = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8.64e15 }));
const Plan = Schema.Struct({
  key: Id,
  sha256: Hash,
  size: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16_777_216 })),
  sourceSha256: Hash,
  bodyStartMs: Millis,
  bodyEndMs: Millis,
  durationMs: Millis,
  transformRevision: Schema.Literal("dance-publication-body-v1"),
});
const Journal = Schema.Struct({
  review_id: Id,
  token: Id,
  destination_key: Id,
  state: Schema.Literals(["preparing", "stored", "adopted", "cleanup", "cleaned"]),
  body_plan: Schema.NullOr(Plan),
});
const Grant = Schema.Union([
  Schema.Struct({ status: Schema.Literal("put"), body: Plan }),
  Schema.Struct({ status: Schema.Literal("unknown") }),
]);
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "ignore" })(value);
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const digest = async (bytes: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", bytes));
type Call = (label: string, sql: string, values: readonly unknown[]) => Promise<unknown>;

/** The body producer must have measured the trimmed video before calling this
 * adapter. SQL rechecks its frozen capture and deadline. Storage proves bytes,
 * not duration, content safety or permission to publish. */
export function makeModeratedDancePublicationStorage(
  input: Readonly<{
    call: Call;
    reviewId: string;
    token: string;
    videoTrackEnabled: boolean;
    bucket: Pick<R2Bucket, "get" | "head" | "put">;
    signal: AbortSignal;
  }>,
) {
  const protocol = makeModeratedDancePublicationInput(input);
  const scoped = (plan: typeof Plan.Type) => {
    if (
      plan.key !== `immutable/dance-post-operation:${input.reviewId}/video/1` ||
      plan.durationMs !== plan.bodyEndMs - plan.bodyStartMs ||
      plan.durationMs < 6000 ||
      plan.durationMs > 30_000
    )
      throw new Error("Dance Post storage binding changed");
    return plan;
  };
  const recover = async (plan: typeof Plan.Type) => {
    input.signal.throwIfAborted();
    const head = await input.bucket.head(plan.key);
    if (
      head === null ||
      head.size !== plan.size ||
      head.httpMetadata?.contentType !== "video/mp4" ||
      head.customMetadata?.dancePublicationInput !== input.token ||
      head.customMetadata?.dancePublicationReview !== input.reviewId
    )
      return { outcome: "unknown" as const };
    // Use the service-verified checksum when supplied by PUT. Older/missing
    // checksum metadata requires a conditional, bounded byte read and digest.
    let sha = head.checksums.sha256 === undefined ? undefined : hex(head.checksums.sha256);
    if (sha === undefined) {
      const object = await input.bucket.get(plan.key, { onlyIf: { etagMatches: head.etag } });
      if (object === null || !("body" in object)) return { outcome: "unknown" as const };
      if (
        object.version !== head.version ||
        object.etag !== head.etag ||
        object.size !== plan.size
      ) {
        await object.body.cancel();
        return { outcome: "unknown" as const };
      }
      const bytes = await readBoundedStream(object.body, plan.size, input.signal);
      if (bytes.byteLength !== plan.size) return { outcome: "unknown" as const };
      sha = await digest(bytes);
    }
    if (sha !== plan.sha256) return { outcome: "unknown" as const };
    // Observe runs through the original lifecycle locks. A concurrent cleanup
    // wins even if this HEAD saw valid bytes; no separate Post is adopted here.
    await protocol.observe({ ...plan, version: head.version, etag: head.etag });
    return { outcome: "stored" as const };
  };
  return {
    async store(rawPlan: unknown, rawBytes: Uint8Array) {
      const plan = scoped(decode(Plan, rawPlan));
      input.signal.throwIfAborted();
      // Snapshot the bounded body across awaits. A caller cannot mutate it
      // between hash validation and the single conditional PUT.
      if (rawBytes.byteLength !== plan.size) throw new Error("Dance Post body size changed");
      const bytes = rawBytes.slice();
      if ((await digest(bytes)) !== plan.sha256) throw new Error("Dance Post body digest changed");
      const saved = scoped(decode(Plan, await protocol.plan(plan)));
      if (JSON.stringify(saved) !== JSON.stringify(plan))
        throw new Error("Dance Post plan changed");
      // Retained COMMIT must succeed before I/O. An unknown COMMIT escapes;
      // recovery only observes and never dispatches the already-consumed PUT.
      const grant = decode(Grant, await protocol.put());
      if (grant.status === "put") {
        if (JSON.stringify(grant.body) !== JSON.stringify(plan))
          throw new Error("Dance Post PUT grant changed");
        input.signal.throwIfAborted();
        try {
          await input.bucket.put(plan.key, bytes, {
            onlyIf: { etagDoesNotMatch: "*" },
            sha256: plan.sha256,
            httpMetadata: { contentType: "video/mp4" },
            customMetadata: {
              dancePublicationInput: input.token,
              dancePublicationReview: input.reviewId,
            },
          });
        } catch {
          // Ambiguous storage effect: recovery may HEAD it, never resend it.
          return { outcome: "unknown" as const };
        }
      }
      return recover(plan);
    },
    async recover() {
      const journal = decode(Journal, await protocol.inspect());
      if (journal.review_id !== input.reviewId || journal.token !== input.token)
        throw new Error("Dance Post journal changed");
      if (journal.state === "adopted") return { outcome: "adopted" as const };
      if (journal.state === "cleanup" || journal.state === "cleaned")
        return { outcome: "closed" as const };
      if (journal.body_plan === null) return { outcome: "unknown" as const };
      if (journal.destination_key !== journal.body_plan.key)
        throw new Error("Dance Post destination changed");
      return recover(scoped(journal.body_plan));
    },
  };
}

const Cleanup = Schema.Struct({
  reviewId: Id,
  key: Id,
  body: Schema.NullOr(Schema.Struct({ version: Id, etag: Id, size: Schema.Int })),
  plan: Schema.NullOr(Plan),
  inputToken: Id,
  fenceToken: Id,
  delivery: Schema.Literals(["fresh_grant", "recovery_only"]),
});
const FENCE = '{"version":"dance-publication-erasure-fence-v1"}';
type CleanupHead = Readonly<{
  version: string;
  etag: string;
  size: number;
  httpMetadata?: Readonly<{ contentType?: string }>;
  customMetadata?: Readonly<Record<string, string>>;
  checksums?: Readonly<{ sha256?: ArrayBuffer; toJSON?: () => unknown }>;
}>;
export type DancePublicationCleanupBucket = Readonly<{
  head: (key: string) => Promise<CleanupHead | null>;
  put: (
    key: string,
    body: string,
    options: Readonly<{
      onlyIf: Readonly<{ etagMatches: string }> | Readonly<{ etagDoesNotMatch: string }>;
      httpMetadata: Readonly<{ contentType: string }>;
      customMetadata: Readonly<Record<string, string>>;
    }>,
  ) => Promise<CleanupHead | null>;
}>;

/** Composed independently of media intake and Rewards. The first committed
 * cleanup claim may use CAS; every successor is observation-only. An adopted
 * normal Post is outside this consumer's authority. The small retained fence
 * contains no recording and closes a late If-None-Match writer permanently. */
export function makeModeratedDancePublicationCleanup(
  input: Readonly<{
    call: Call;
    bucket: DancePublicationCleanupBucket;
    randomId?: (() => string) | undefined;
  }>,
) {
  return {
    async run() {
      const raw = await input.call(
        "dance-publication.cleanup.claim",
        "SELECT claim_moderated_dance_publication_cleanup_v1($1) packet",
        [(input.randomId ?? (() => crypto.randomUUID()))()],
      );
      if (raw === null) return;
      const item = decode(Cleanup, raw);
      if (item.key !== `immutable/dance-post-operation:${item.reviewId}/video/1`)
        throw new Error("Dance Post cleanup scope changed");
      let result: Record<string, unknown> = { outcome: "unknown" };
      try {
        let head = await input.bucket.head(item.key);
        const isFence = (o: CleanupHead | null) =>
          o !== null &&
          o.size === FENCE.length &&
          o.httpMetadata?.contentType === "application/vnd.pirate.erasure-fence+json" &&
          o.customMetadata?.dancePublicationErasureFence === item.fenceToken;
        // At most two writes. Only a KNOWN conditional refusal permits a
        // second CAS. A thrown PUT leaves the original authorization unknown.
        if (!isFence(head) && item.delivery === "fresh_grant") {
          for (let n = 0; n < 2; n++) {
            if (head !== null) {
              const owned =
                item.plan !== null &&
                head.size === item.plan.size &&
                head.httpMetadata?.contentType === "video/mp4" &&
                head.customMetadata?.dancePublicationInput === item.inputToken &&
                head.customMetadata?.dancePublicationReview === item.reviewId &&
                head.checksums?.sha256 !== undefined &&
                hex(head.checksums.sha256) === item.plan.sha256 &&
                (item.body === null ||
                  (head.version === item.body.version && head.etag === item.body.etag));
              if (!owned) break;
            }
            const written = await input.bucket.put(item.key, FENCE, {
              onlyIf: head === null ? { etagDoesNotMatch: "*" } : { etagMatches: head.etag },
              httpMetadata: { contentType: "application/vnd.pirate.erasure-fence+json" },
              customMetadata: { dancePublicationErasureFence: item.fenceToken },
            });
            head = await input.bucket.head(item.key);
            if (isFence(head) || written !== null) break;
          }
        }
        if (isFence(head) && head !== null)
          result = {
            outcome: "fenced",
            key: item.key,
            version: head.version,
            etag: head.etag,
            size: head.size,
            fenceToken: item.fenceToken,
          };
      } catch {
        // Missing objects, transport errors and absent proof retain liability.
      }
      await input.call(
        "dance-publication.cleanup.finish",
        "SELECT finish_moderated_dance_publication_cleanup_v1($1,$2,$3::jsonb) packet",
        [item.reviewId, item.fenceToken, JSON.stringify(result)],
      );
    },
  };
}

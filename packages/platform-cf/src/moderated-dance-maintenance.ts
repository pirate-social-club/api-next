import { Effect, type Layer, Schema } from "effect";
import type { ControlPlaneDb, ControlPlaneError } from "../../application/src/ports.ts";
import { canonicalBodyHash } from "../../application/src/use-cases/content/common.ts";
import {
  DanceReviewServiceFailure,
  processDanceReviewTask,
} from "../../application/src/use-cases/dance/moderator-review-services.ts";
import { withRetainedControlPlaneCommandTransaction } from "./control-plane-command-transaction.ts";
import { makeControlPlaneModeratorReviewStore } from "./dance-moderator-review-repository.ts";
import { makeModeratedDanceProviderCleanup } from "./moderated-dance-provider-cleanup.ts";
import { makeModeratedDancePublicReplay } from "./moderated-dance-public-replay.ts";
import {
  type DancePublicationCleanupBucket,
  makeModeratedDancePublicationCleanup,
} from "./moderated-dance-publication-storage.ts";
import type { makeSongVideoCloudConvertTransport } from "./song-video-cloudconvert-transport.ts";

const Id = Schema.NonEmptyString,
  NumberId = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Task = Schema.Struct({
  communityId: Id,
  reviewId: Id,
  revision: NumberId,
  operation: Schema.Literals(["screen", "expire", "erase", "publication_failed"]),
  generation: NumberId,
});
const Identity = Schema.Struct({
  key: Id,
  version: Schema.NullOr(Id),
  etag: Schema.NullOr(Id),
  size: Schema.NullOr(NumberId),
});
const Cleanup = Schema.Struct({
  uploadId: Id,
  kind: Schema.Literals(["ingress", "original", "derived"]),
  identity: Schema.Unknown,
  token: Id,
  delivery: Schema.Literals(["fresh_grant", "recovery_only"]),
});
const Original = Schema.Union([
  Identity,
  Schema.Struct({
    destination_ref: Id,
    version: Id,
    etag: Id,
    size_bytes: NumberId,
  }),
]);
const Derived = Schema.Struct({
  frames: Schema.Array(Schema.Struct({ identity: Identity })).check(
    Schema.isMinLength(3),
    Schema.isMaxLength(3),
  ),
});

const ERASURE_FENCE = '{"version":"private-dance-erasure-fence-v1"}';
type PrivateCleanupHead = Readonly<{
  version: string;
  etag: string;
  size: number;
  customMetadata?: Readonly<Record<string, string>>;
}>;
type PrivateCleanupBucket = Readonly<{
  head: (key: string) => Promise<PrivateCleanupHead | null>;
  put: (
    key: string,
    value: string,
    options: Readonly<{
      onlyIf: Readonly<{ etagMatches: string }> | Readonly<{ etagDoesNotMatch: string }>;
      customMetadata: Readonly<Record<string, string>>;
      httpMetadata: Readonly<{ contentType: string }>;
    }>,
  ) => Promise<PrivateCleanupHead | null>;
}>;
/** Real nonfinancial consumer. It remains composed when new media intake or
 * Rewards is disabled. Conditional fences remove owned payloads and close late
 * conditional writers. Provider copies and unknown effects remain liabilities;
 * an observation never grants a second storage write authorization. */
export function makeModeratedDanceMaintenance(
  input: Readonly<{
    runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>;
    ingress: PrivateCleanupBucket;
    originals: PrivateCleanupBucket & DancePublicationCleanupBucket;
    provider?:
      | Pick<
          ReturnType<typeof makeSongVideoCloudConvertTransport>,
          "inspect" | "findByTag" | "remove"
        >
      | undefined;
    replayKeys?: ReadonlyMap<string, Uint8Array> | undefined;
    randomId?: () => string;
  }>,
) {
  const call = (label: string, text: string, values: readonly unknown[]) =>
    Effect.runPromise(
      withRetainedControlPlaneCommandTransaction((tx) =>
        Effect.gen(function* () {
          const r = yield* tx.execute<{ packet: unknown }>({
            label,
            text,
            values,
            readonly: false,
          });
          if (r.rows.length !== 1 || r.rows[0] === undefined || !Object.hasOwn(r.rows[0], "packet"))
            throw new Error("Private maintenance outcome unknown");
          return r.rows[0].packet;
        }),
      ).pipe(Effect.provide(input.runtime)),
    );
  const reviewStore = makeControlPlaneModeratorReviewStore(input.runtime, {
    account: () => Effect.fail(new DanceReviewServiceFailure({ reason: "unauthorized" })),
    worker: () => Effect.succeed({ kind: "worker", accountId: "moderated-dance-maintenance" }),
  });
  const providerCleanup = makeModeratedDanceProviderCleanup({
    call,
    provider: input.provider,
    randomId: input.randomId,
  });
  const publicReplay =
    input.replayKeys === undefined
      ? undefined
      : makeModeratedDancePublicReplay({ call, keys: input.replayKeys, randomId: input.randomId });
  const publicationCleanup = makeModeratedDancePublicationCleanup({
    call,
    bucket: input.originals,
    randomId: input.randomId,
  });
  const run = async () => {
    const raw = await call(
      "dance.maintenance.next-review",
      "SELECT next_moderated_dance_review_task_v1() AS packet",
      [],
    );
    if (raw !== null) {
      const task = Schema.decodeUnknownSync(Task, { onExcessProperty: "error" })(raw);
      const key = await Effect.runPromise(
        canonicalBodyHash(["moderated-dance-maintenance-v1", task]),
      );
      const command = {
        version: "dance-review-task-v1",
        operation: task.operation,
        idempotency_key: key,
        community_id: task.communityId,
        review_id: task.reviewId,
        expected_review_revision: task.revision,
        ...(task.operation === "publication_failed" ? { handoff_generation: task.generation } : {}),
      };
      // The existing command reducer owns all terminal/notification semantics.
      // A lost COMMIT response escapes; no callback or command replay loop.
      await Effect.runPromise(processDanceReviewTask(command, reviewStore));
    }
    const value = await call(
      "dance.maintenance.cleanup.claim",
      "SELECT claim_moderated_dance_owned_cleanup_v1($1) AS packet",
      [(input.randomId ?? (() => crypto.randomUUID()))()],
    );
    if (value !== null) {
      const cleanup = Schema.decodeUnknownSync(Cleanup, { onExcessProperty: "error" })(value);
      let identities: readonly (typeof Identity.Type)[];
      if (cleanup.kind === "original") {
        const o = Schema.decodeUnknownSync(Original, { onExcessProperty: "ignore" })(
          cleanup.identity,
        );
        identities = [
          "destination_ref" in o
            ? { key: o.destination_ref, version: o.version, etag: o.etag, size: o.size_bytes }
            : o,
        ];
      } else if (cleanup.kind === "derived")
        identities = Schema.decodeUnknownSync(Derived, { onExcessProperty: "error" })(
          cleanup.identity,
        ).frames.map((f) => f.identity);
      else
        identities = [
          Schema.decodeUnknownSync(Identity, { onExcessProperty: "error" })(cleanup.identity),
        ];
      let outcome: "owned_payload_fenced" | "unknown" = "owned_payload_fenced";
      const observations: Array<{ key: string; outcome: string; version?: string; etag?: string }> =
        [];
      for (const target of identities) {
        const inScope =
          cleanup.kind === "ingress"
            ? /^moderated-dance\/ingress\/[a-f0-9-]{36}\/source$/u.test(target.key)
            : cleanup.kind === "original"
              ? target.key === `moderated-dance/originals/${cleanup.uploadId}/source`
              : [0, 1, 2].some(
                  (index) =>
                    target.key === `moderated-dance/derived/${cleanup.uploadId}/frame-${index}.jpg`,
                );
        if (!inScope) {
          outcome = "unknown";
          observations.push({ key: target.key, outcome: "scope_refused" });
          continue;
        }
        const bucket = cleanup.kind === "ingress" ? input.ingress : input.originals;
        try {
          let head = await bucket.head(target.key);
          // A retained fence is authoritative storage evidence; neither elapsed
          // time nor a missing hash proves the original writer never submitted.
          const isFence = (value: Awaited<ReturnType<PrivateCleanupBucket["head"]>>) =>
            value !== null &&
            value.customMetadata?.privateDanceErasureFence === cleanup.token &&
            value.size === ERASURE_FENCE.length;
          if (!isFence(head) && cleanup.delivery === "fresh_grant") {
            // At most two CAS writes, only after known conditional refusal.
            // No ambiguous PUT is replayed. A nonempty fence closes every late
            // If-None-Match source/derived/ingress writer without an empty-key gap.
            for (let n = 0; n < 2; n++) {
              if (
                head !== null &&
                target.version !== null &&
                (head.version !== target.version ||
                  head.etag !== target.etag ||
                  head.size !== target.size)
              )
                break;
              const put = await bucket.put(target.key, ERASURE_FENCE, {
                onlyIf: head === null ? { etagDoesNotMatch: "*" } : { etagMatches: head.etag },
                customMetadata: { privateDanceErasureFence: cleanup.token },
                httpMetadata: { contentType: "application/vnd.pirate.erasure-fence+json" },
              });
              head = await bucket.head(target.key);
              if (isFence(head) || put !== null) break;
            }
          }
          if (!isFence(head)) {
            outcome = "unknown";
            observations.push({ key: target.key, outcome: "fence_unresolved" });
            continue;
          }
          observations.push({
            key: target.key,
            outcome: "payload_fenced",
            version: head?.version ?? "",
            etag: head?.etag ?? "",
          });
        } catch {
          outcome = "unknown";
          observations.push({ key: target.key, outcome: "storage_unknown" });
        }
      }
      await call(
        "dance.maintenance.cleanup.commit",
        "SELECT finish_moderated_dance_owned_cleanup_v1($1,$2,$3,$4::jsonb) AS packet",
        [cleanup.uploadId, cleanup.kind, cleanup.token, JSON.stringify({ outcome, observations })],
      );
    }
    await providerCleanup.run();
    await publicationCleanup.run();
    await call(
      "dance.maintenance.replay-drain",
      "SELECT drain_moderated_dance_replay_v1() AS packet",
      [],
    );
    await call(
      "dance.maintenance.compatible-replay-drain",
      "SELECT drain_moderated_dance_compatible_replay_v1() AS packet",
      [],
    );
    // Missing or changed keys never skip already-due payload/provider/private
    // retention. Indexing runs only after those independent drains complete.
    await publicReplay?.run();
    await call(
      "dance.maintenance.publication-intents",
      "SELECT drain_moderated_dance_publication_intents_v1() AS packet",
      [],
    );
    await call(
      "dance.maintenance.readiness",
      "SELECT record_moderated_dance_maintenance_v1() AS packet",
      [],
    );
    return { outcome: "maintained" as const };
  };
  return { run };
}

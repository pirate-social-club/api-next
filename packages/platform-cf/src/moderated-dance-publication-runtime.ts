import { Effect, type Layer, Schema } from "effect";
import type { ControlPlaneDb, ControlPlaneError } from "../../application/src/ports.ts";
import { withRetainedControlPlaneCommandTransaction } from "./control-plane-command-transaction.ts";
import {
  makeModeratedDancePublicationBodyJob,
  readModeratedDancePublicationBody,
} from "./moderated-dance-publication-body.ts";
import { makeModeratedDancePublicationInput } from "./moderated-dance-publication-input.ts";
import {
  type DancePublicationStorageBucket,
  makeModeratedDancePublicationStorage,
} from "./moderated-dance-publication-storage.ts";
import type { makeSongVideoCloudConvertTransport } from "./song-video-cloudconvert-transport.ts";
import { videoSourceCapabilityDigest } from "./video-source-capability.ts";
import { makeVideoSourceUrl } from "./video-source-gateway.ts";

const Id = Schema.NonEmptyString.check(Schema.isMaxLength(192));
const Natural = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8.64e15 }));
const Work = Schema.Struct({
  reviewId: Id,
  inputToken: Id,
  leaseToken: Id,
  action: Schema.Literals(["create", "observe", "recover", "adopt"]),
  tag: Id,
  jobId: Schema.NullOr(Id),
  timeoutSeconds: Natural,
  deadlineMs: Natural,
  bodyStartMs: Natural,
  bodyEndMs: Natural,
  sourceSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
const Create = Schema.Union([
  Schema.Struct({ status: Schema.Literal("create"), tag: Id, timeoutSeconds: Natural }),
  Schema.Struct({ status: Schema.Literals(["unknown", "budget_refused"]) }),
]);
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);

/** One bounded handoff, with separate retained grants before each effect.
 * SQL failures escape, including uncertain COMMIT. They cannot become retries
 * of provider creation or R2 writes. Only original-job observations repeat. */
export function makeModeratedDancePublicationRuntime(
  input: Readonly<{
    runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>;
    bucket: DancePublicationStorageBucket;
    provider: Pick<
      ReturnType<typeof makeSongVideoCloudConvertTransport>,
      "create" | "findByTag" | "showPrivatePublication"
    >;
    gatewayOrigin: string;
    runtimeRevision: string;
    videoTrackEnabled: boolean;
    now?: () => number;
    randomId?: () => string;
    readBody?: typeof readModeratedDancePublicationBody;
  }>,
) {
  const call = (label: string, text: string, values: readonly unknown[]) =>
    Effect.runPromise(
      withRetainedControlPlaneCommandTransaction((tx) =>
        Effect.gen(function* () {
          const result = yield* tx.execute<{ packet: unknown }>({
            label,
            text,
            values,
            readonly: false,
          });
          if (
            result.rows.length !== 1 ||
            result.rows[0] === undefined ||
            !Object.hasOwn(result.rows[0], "packet")
          )
            throw new Error("Dance publication persistence outcome unknown");
          return result.rows[0].packet;
        }),
      ).pipe(Effect.provide(input.runtime)),
    );
  return {
    async run() {
      const raw = await call(
        "dance-publication.claim",
        "SELECT claim_moderated_dance_publication_v1($1,$2,$3) packet",
        [
          (input.randomId ?? (() => crypto.randomUUID()))(),
          input.runtimeRevision,
          input.videoTrackEnabled,
        ],
      );
      if (raw === null) return { outcome: "idle" as const };
      const work = decode(Work, raw),
        protocol = makeModeratedDancePublicationInput({
          call,
          reviewId: work.reviewId,
          token: work.inputToken,
          videoTrackEnabled: input.videoTrackEnabled,
        }),
        command = (action: string, fields: Readonly<Record<string, unknown>> = {}) =>
          call(
            `dance-publication.provider.${action}`,
            "SELECT moderated_dance_publication_provider_v1($1,$2,$3::jsonb) packet",
            [
              work.reviewId,
              action,
              JSON.stringify({
                ...fields,
                inputToken: work.inputToken,
                leaseToken: work.leaseToken,
                videoTrackEnabled: input.videoTrackEnabled,
              }),
            ],
          );
      const remaining = work.deadlineMs - (input.now ?? Date.now)();
      if (remaining < 1) {
        await command("release");
        return { outcome: "waiting" as const };
      }
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), Math.min(remaining, 300_000));
      try {
        const storage = makeModeratedDancePublicationStorage({
          call,
          reviewId: work.reviewId,
          token: work.inputToken,
          videoTrackEnabled: input.videoTrackEnabled,
          bucket: input.bucket,
          signal: controller.signal,
        });
        if (work.action === "adopt") {
          await protocol.adopt();
          await command("release");
          return { outcome: "transferred" as const };
        }
        if (work.action === "recover") {
          const recovered = await storage.recover();
          if (recovered.outcome === "stored" || recovered.outcome === "adopted") {
            await protocol.adopt();
            await command("release");
            return { outcome: "transferred" as const };
          }
          await command("release");
          return { outcome: "waiting" as const };
        }
        let jobId = work.jobId;
        if (work.action === "create") {
          const cap = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replaceAll("=", "");
          const capabilitySha256 = await videoSourceCapabilityDigest(cap);
          // A source COMMIT failure escapes before consuming create or making I/O.
          await command("source", { capabilitySha256 });
          const grant = decode(Create, await command("create", { capabilitySha256 }));
          if (grant.status !== "create") {
            await command("release");
            return {
              outcome:
                grant.status === "budget_refused"
                  ? ("budget_refused" as const)
                  : ("waiting" as const),
            };
          }
          if (grant.tag !== work.tag) throw new Error("Dance publication create identity changed");
          const request = makeModeratedDancePublicationBodyJob(
            work,
            makeVideoSourceUrl(input.gatewayOrigin, cap),
            grant.timeoutSeconds,
          );
          let created: Awaited<ReturnType<typeof input.provider.create>>;
          try {
            created = await input.provider.create(request);
          } catch {
            await command("release");
            return { outcome: "waiting" as const };
          }
          // Late identity is historical cleanup evidence, even after erasure.
          await command("identify", { jobId: created.id, tag: created.tag });
          jobId = created.id;
        }
        await command("observe");
        if (jobId === null) {
          let found: Awaited<ReturnType<typeof input.provider.findByTag>>;
          try {
            found = await input.provider.findByTag(work.tag);
          } catch {
            await command("release");
            return { outcome: "waiting" as const };
          }
          if (found === null) {
            await command("release");
            return { outcome: "waiting" as const };
          }
          await command("identify", { jobId: found.id, tag: found.tag });
          jobId = found.id;
        }
        await command("observe");
        let observation: Awaited<ReturnType<typeof input.provider.showPrivatePublication>>;
        try {
          observation = await input.provider.showPrivatePublication(jobId);
        } catch {
          await command("release");
          return { outcome: "waiting" as const };
        }
        if (observation.id !== jobId || observation.tag !== work.tag)
          throw new Error("Dance publication observation identity changed");
        if (observation.status === "error") {
          await protocol.abandon();
          await command("release");
          return { outcome: "cleanup" as const };
        }
        if (observation.status !== "finished") {
          await command("release");
          return { outcome: "waiting" as const };
        }
        await command("observe");
        let body: Awaited<ReturnType<typeof readModeratedDancePublicationBody>>;
        try {
          body = await (input.readBody ?? readModeratedDancePublicationBody)({
            binding: work,
            jobId,
            observation,
            signal: controller.signal,
          });
        } catch {
          await command("release");
          return { outcome: "waiting" as const };
        }
        const stored = await storage.store(body.plan, body.bytes);
        if (stored.outcome === "stored") {
          await protocol.adopt();
          await command("release");
          return { outcome: "transferred" as const };
        }
        await command("release");
        return { outcome: "waiting" as const };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

import { Effect, type Layer, Schema } from "effect";
import type { ControlPlaneDb, ControlPlaneError } from "../../application/src/ports.ts";
import { CreateModeratedDanceMediaAccess } from "../../contracts/src/dance-moderated-intake.ts";
import { withRetainedControlPlaneCommandTransaction } from "./control-plane-command-transaction.ts";

const Id = Schema.NonEmptyString,
  N = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Grant = Schema.Struct({
  expiresAtMs: N,
  object: Schema.Struct({
    key: Id,
    identity: Schema.Literal("upload_version"),
    version: Id,
    etag: Id,
    size: N,
    contentType: Schema.Literals(["video/mp4", "video/quicktime"]),
    canonicalSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  }),
});
export function makeModeratedDanceMediaAccessStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>,
  account: string,
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
            throw new Error("Private media authorization outcome unknown");
          return r.rows[0].packet;
        }),
      ).pipe(Effect.provide(runtime)),
    );
  return {
    async issue(community: string, review: string, revision: number, audience: "owner" | "dancer") {
      const bytes = crypto.getRandomValues(new Uint8Array(32)),
        lease = btoa(String.fromCharCode(...bytes))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replaceAll("=", "");
      const raw = await call(
        "dance.media.lease.issue",
        "SELECT issue_moderated_dance_media_lease_v1($1,$2,$3,$4,$5,$6) AS packet",
        [account, community, review, revision, audience, lease],
      );
      return Schema.decodeUnknownSync(CreateModeratedDanceMediaAccess.response, {
        onExcessProperty: "error",
      })(raw);
    },
    async resolve(community: string, review: string, lease: string, charge: boolean) {
      const raw = await call(
        "dance.media.lease.resolve",
        "SELECT resolve_moderated_dance_media_lease_v1($1,$2,$3,$4,$5) AS packet",
        [account, community, review, lease, charge],
      );
      return raw === null
        ? null
        : Schema.decodeUnknownSync(Grant, { onExcessProperty: "error" })(raw);
    },
  };
}

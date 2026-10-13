// Independent current-public egress predicate. Uses reviewed public-read role;
// no Guest/account rows, source grants, disclosure or paid policy required.
import {
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
  type OwnerGuestStudyPublicVisibilityStore,
} from "@pirate/application";
import { Effect, type Layer, Schema } from "effect";
export function makeOwnerGuestStudyPublicVisibilityStore(
  publicReadRuntime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): OwnerGuestStudyPublicVisibilityStore {
  return {
    isPublic: Effect.fn("OwnerGuestStudyPublicVisibilityStore.isPublic")(function* (
      input: Parameters<OwnerGuestStudyPublicVisibilityStore["isPublic"]>[0],
    ) {
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute({
        label: "guest-study.public-egress",
        text: "SELECT can_guest_access_activity_song_v1($1,$2) AS visible",
        values: [input.communityId, input.postId],
        readonly: true,
      });
      return yield* Effect.try({
        try: () => {
          if (result.rows.length !== 1) throw new Error();
          return Schema.decodeUnknownSync(Schema.Struct({ visible: Schema.Boolean }), {
            onExcessProperty: "error",
          })(result.rows[0]).visible;
        },
        catch: () =>
          new ControlPlaneStatementFailed({
            label: "guest-study.public-egress.decode",
            sqlState: null,
            constraint: null,
            outcomeCertainty: "completed",
          }),
      });
    }, Effect.provide(publicReadRuntime)),
  };
}

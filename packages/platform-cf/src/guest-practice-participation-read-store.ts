// OUTSIDE SOURCE PROPOSAL. Frozen practice-only reader; no endpoint activation.

import type { ControlPlaneDb } from "@pirate/application";
import { type ControlPlaneError, ControlPlaneStatementFailed } from "@pirate/application";
import {
  type GuestParticipationReadStore,
  GuestParticipationStoreRejected,
} from "@pirate/application/guest-participation-authority";
import {
  GuestCredentialIdV1,
  GuestIdentifierV1,
  GuestParticipationProjectionV1,
} from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";
import { boundedLearnerAudioTransaction } from "./bounded-audio-transaction.ts";

const Origin = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value
        ? undefined
        : "Canonical HTTPS origin required";
    } catch {
      return "Canonical HTTPS origin required";
    }
  }),
);
const Input = Schema.Struct({
  access: Schema.Struct({
    kind: Schema.Literal("guest"),
    ownerId: GuestIdentifierV1,
    credentialId: GuestCredentialIdV1,
    origin: Origin,
  }),
  cursor: Schema.NullOr(GuestIdentifierV1),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
});
const Result = Schema.Struct({
  items: Schema.Array(GuestParticipationProjectionV1).check(Schema.isMaxLength(0)),
  nextCursor: Schema.Null,
});
const invalid = (started: boolean) =>
  new ControlPlaneStatementFailed({
    label: "guest-participations.practice.decode",
    sqlState: null,
    constraint: null,
    outcomeCertainty: started ? "completed" : "not-started",
  });

export function makeControlPlaneGuestPracticeParticipationReadStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): GuestParticipationReadStore {
  return {
    list: Effect.fn("GuestPracticeParticipationReadStore.list")(function* (
      input: Parameters<GuestParticipationReadStore["list"]>[0],
    ) {
      // Successful account attachment is not implemented in this phase. An
      // ordinary account session alone cannot enumerate an unbound guest.
      if (input.access.kind !== "guest")
        return yield* new GuestParticipationStoreRejected({
          reason: "resource-policy-unavailable",
        });
      const checked = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(Input, { onExcessProperty: "error" })(input),
        catch: () => invalid(false),
      });
      return yield* boundedLearnerAudioTransaction((transaction) =>
        transaction
          .execute<unknown>({
            label: "guest-participations.practice.list",
            text: "SELECT list_guest_practice_participations_v1($1::jsonb,$2,$3) AS result",
            values: [JSON.stringify(checked.access), checked.cursor, checked.limit],
            readonly: false,
          })
          .pipe(
            Effect.flatMap((response) =>
              Effect.try({
                try: () => {
                  if (response.rows.length !== 1) throw new Error();
                  return Schema.decodeUnknownSync(Schema.Struct({ result: Result }), {
                    onExcessProperty: "error",
                  })(response.rows[0]).result;
                },
                catch: () => invalid(true),
              }),
            ),
          ),
      ).pipe(
        Effect.provide(runtime),
        Effect.catchTag(
          "ControlPlaneStatementFailed",
          (error): Effect.Effect<never, ControlPlaneError | GuestParticipationStoreRejected> => {
            switch (error.sqlState) {
              case "GP001":
                return Effect.fail(
                  new GuestParticipationStoreRejected({ reason: "proof-revoked" }),
                );
              case "GP002":
                return Effect.fail(
                  new GuestParticipationStoreRejected({ reason: "owner-mismatch" }),
                );
              case "GP003":
                return Effect.fail(
                  new GuestParticipationStoreRejected({ reason: "authority-conflict" }),
                );
              default:
                return Effect.fail(error);
            }
          },
        ),
      );
    }),
  };
}

import { ControlPlaneDb } from "@pirate/application";
import { Effect, Schema } from "effect";

const Result = Schema.Struct({ credited: Schema.Boolean });

/** Only a confirmed empty drawing under frozen treasury terms is handled here.
 * Qualified drawings continue through the existing participant allocation path. */
export const creditEmptySafeTreasury = Effect.fn("creditEmptySafeTreasury")(function* (input: {
  readonly poolLegId: string;
  readonly drawingId: bigint;
}) {
  const db = yield* ControlPlaneDb;
  return yield* db.withTransaction((transaction) =>
    Effect.gen(function* () {
      const result = yield* transaction.execute({
        label: "safe-treasury.credit-empty-drawing",
        text: "SELECT credit_empty_safe_treasury_v1($1,$2::numeric) AS credited",
        values: [input.poolLegId, input.drawingId.toString()],
        readonly: false,
      });
      const row = yield* Schema.decodeUnknownEffect(Result)(
        result.rows.length === 1 ? result.rows[0] : null,
      );
      return row.credited;
    }),
  );
});

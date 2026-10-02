import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import {
  HnsWalletPublicationRejected,
  type HnsWalletPublicationStore,
} from "@pirate/application/namespace-ownership";
import { HnsWalletPublicationAttemptV1, HnsWalletPublicationResultV1 } from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";

const Row = Schema.Struct({ outcome: Schema.String, attempt: Schema.Unknown });
const Rejection = Schema.Literals([
  "not_found",
  "stale",
  "publication_unresolved",
  "invalid_command",
]);

export function makeControlPlaneHnsWalletPublicationStore(
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError>,
): HnsWalletPublicationStore {
  const query = (text: string, values: readonly unknown[]) =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute({
        label: "hns.wallet-publication",
        text,
        values,
        readonly: false,
      });
      if (result.rows.length !== 1)
        return yield* Effect.fail(new Error("Invalid publication result count"));
      const row = yield* Schema.decodeUnknownEffect(Row)(result.rows[0]);
      if (Schema.is(Rejection)(row.outcome)) {
        return yield* Effect.fail(new HnsWalletPublicationRejected({ reason: row.outcome }));
      }
      return row;
    }).pipe(Effect.provide(layer));
  return {
    read: (input) =>
      query("SELECT * FROM read_hns_wallet_publication_v1($1,$2,$3)", [
        input.actor_id,
        input.community_id,
        input.root_import_session_id,
      ]).pipe(
        Effect.flatMap((row) =>
          row.outcome === "found"
            ? Schema.decodeUnknownEffect(
                Schema.Struct({ attempt: Schema.NullOr(HnsWalletPublicationAttemptV1) }),
              )({ attempt: row.attempt })
            : Effect.fail(new Error("Invalid publication read outcome")),
        ),
      ),
    command: (input) =>
      query("SELECT * FROM command_hns_wallet_publication_v1($1,$2,$3,$4,$5::jsonb)", [
        input.actor_id,
        input.community_id,
        input.root_import_session_id,
        crypto.randomUUID(),
        JSON.stringify(input.command),
      ]).pipe(Effect.flatMap(Schema.decodeUnknownEffect(HnsWalletPublicationResultV1))),
  };
}

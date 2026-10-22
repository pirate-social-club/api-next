import { Effect, type Layer, Schema } from "effect";
import type { ControlPlaneDb, ControlPlaneError } from "../../application/src/ports.ts";
import { GetSharedSongMegapotSummaryV2 } from "../../contracts/src/shared-song-megapot.ts";
import { withRetainedControlPlaneCommandTransaction } from "./control-plane-command-transaction.ts";
export function makeSharedSongMegapotSummaryReader(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>,
) {
  return async (account: string, community: string, post: string) => {
    const value = await Effect.runPromise(
      withRetainedControlPlaneCommandTransaction((tx) =>
        Effect.gen(function* () {
          const result = yield* tx.execute<{ packet: unknown }>({
            label: "shared-song.summary.read",
            text: "SELECT read_shared_song_megapot_summary_v2($1,$2,$3) AS packet",
            values: [account, community, post],
            readonly: true,
          });
          if (
            result.rows.length !== 1 ||
            result.rows[0] === undefined ||
            !Object.hasOwn(result.rows[0], "packet")
          )
            throw new Error("Shared pot read unavailable");
          return result.rows[0].packet;
        }),
      ).pipe(Effect.provide(runtime)),
    );
    return Schema.decodeUnknownSync(GetSharedSongMegapotSummaryV2.response, {
      onExcessProperty: "error",
    })(value);
  };
}

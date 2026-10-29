import { Effect, Layer } from "effect";
import type { Client } from "pg";
import {
  ControlPlaneDb,
  ControlPlaneStatementFailed,
  type ControlPlaneTransaction,
} from "../../packages/application/src/ports.ts";
import { makeControlPlaneHnsHandlePersonaHostAuthoritySource } from "../../packages/platform-cf/src/hns-handle-host-authority-repository.ts";
import { makeControlPlaneHnsCommunityAppHostAuthoritySource } from "../../packages/platform-cf/src/hns-host-persistence-repository.ts";

/** Keep the maintained SQL decoders and effective serving predicates. This
 * adapter can only read through the caller's already-fenced transaction. */
export function transactionAuthoritySources(client: Client) {
  const transaction: ControlPlaneTransaction = {
    execute: (statement) =>
      Effect.tryPromise({
        try: async () => {
          if (!statement.readonly) throw new Error("Authority census attempted a write");
          const result = await client.query(statement.text, [...statement.values]);
          return { rows: result.rows, rowCount: result.rowCount ?? 0 };
        },
        catch: () =>
          new ControlPlaneStatementFailed({
            label: "hns.cookie-profile.authority-census",
            sqlState: null,
            constraint: null,
            outcomeCertainty: "unknown",
          }),
      }),
  };
  const layer = Layer.succeed(ControlPlaneDb, {
    ...transaction,
    withTransaction: () => Effect.die("Authority census cannot open a transaction"),
  });
  const app = makeControlPlaneHnsCommunityAppHostAuthoritySource(layer);
  const handle = makeControlPlaneHnsHandlePersonaHostAuthoritySource(layer);
  return {
    app: (host: string) => Effect.runPromise(app.resolve(host)),
    handle: (host: string) => Effect.runPromise(handle.resolve(host)),
  };
}

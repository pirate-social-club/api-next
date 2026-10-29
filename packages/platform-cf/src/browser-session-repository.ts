import {
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
} from "@pirate/application";
import {
  BrowserSessionFailure,
  type BrowserSessionStore,
} from "@pirate/application/use-cases/browser-sessions";
import { Effect, type Layer, Schema } from "effect";

const natural = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const record = Schema.Struct({
  sessionId: Schema.String.check(Schema.isPattern(/^bs_[a-f0-9]{32}$/u)),
  accountId: Schema.NonEmptyString,
  credentialUserId: Schema.NonEmptyString,
  scope: Schema.NonEmptyString,
  origin: Schema.String,
  renewable: Schema.Boolean,
  idleExpiresAt: natural,
  absoluteExpiresAt: natural,
  now: natural,
});

/** Runtime has EXECUTE on five narrow facades and no raw session-table access. */
export function makeControlPlaneBrowserSessionStore(
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): BrowserSessionStore {
  const execute = Effect.fn("BrowserSessionStore.execute")(function* (
    label: string,
    text: string,
    values: readonly unknown[],
    readonly: boolean,
  ) {
    const db = yield* ControlPlaneDb;
    const statement = { label, text, values, readonly };
    const result = readonly
      ? yield* db.execute<{ packet: unknown }>(statement)
      : yield* db.withTransaction((tx) => tx.execute<{ packet: unknown }>(statement));
    if (result.rows.length !== 1)
      return yield* new BrowserSessionFailure({ reason: "unavailable" });
    return result.rows[0]!.packet;
  });
  const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    effect.pipe(
      Effect.provide(layer),
      Effect.mapError((error) =>
        error instanceof BrowserSessionFailure
          ? error
          : new BrowserSessionFailure({
              reason:
                error instanceof ControlPlaneStatementFailed && error.sqlState === "28000"
                  ? "invalid"
                  : "unavailable",
            }),
      ),
    );
  const packet = (effect: Effect.Effect<unknown, unknown, ControlPlaneDb>) =>
    run(
      effect.pipe(
        Effect.flatMap((value) =>
          value === null ? Effect.succeed(null) : Schema.decodeUnknownEffect(record)(value),
        ),
      ),
    );
  const proofValues = (p: Parameters<BrowserSessionStore["renew"]>[0]) => [
    p.sessionId,
    p.secretHash,
    p.csrfHash,
    p.origin,
  ];
  return {
    create: (input) =>
      run(
        execute(
          "browser-session.create",
          "SELECT create_browser_session_v1($1::jsonb) AS packet",
          [JSON.stringify(input)],
          false,
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(record))),
      ),
    access: (input) =>
      packet(
        execute(
          "browser-session.access",
          "SELECT read_browser_session_access_v1($1,$2,$3) AS packet",
          [input.sessionId, input.accountId, input.scope],
          true,
        ),
      ),
    loadRenewal: (input) =>
      packet(
        execute(
          "browser-session.renewal-read",
          "SELECT read_browser_session_renewal_v1($1,$2,$3,$4) AS packet",
          proofValues(input),
          true,
        ),
      ),
    renew: (input) =>
      packet(
        execute(
          "browser-session.renew",
          "SELECT renew_browser_session_v1($1,$2,$3,$4) AS packet",
          proofValues(input),
          false,
        ),
      ),
    revoke: (input) =>
      run(
        execute(
          "browser-session.revoke",
          "SELECT revoke_browser_session_v1($1,$2,$3,$4,$5) AS packet",
          [input.sessionId, input.secretHash, input.accountId, input.csrfHash, input.origin],
          false,
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Boolean))),
      ),
  };
}

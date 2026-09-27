import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Effect, type Layer } from "effect";
import { instant, mapped, type Row, storage, text } from "./handle-sales-internals.ts";
import { spacesDelegationScriptV1 } from "./spaces-operator-assignment-repository.ts";

export type SpacesRootObservationTarget = Readonly<{
  canonicalRoot: string;
  delegationAddress: string;
  delegationScript: string;
}>;

export type SpacesRootObservationTargets = Readonly<{
  list: () => Effect.Effect<readonly SpacesRootObservationTarget[], unknown>;
  databaseNow: () => Effect.Effect<string, unknown>;
}>;

// Three supervised staging roots fit below the 90-second job deadline even
// when each verifier call reaches its 20-second timeout.
const MAX_ROOTS = 3;

/** Current active assignments are the only roots eligible for observation. */
export function makeSpacesRootObservationTargets(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): SpacesRootObservationTargets {
  const list = Effect.gen(function* () {
    const db = yield* ControlPlaneDb;
    const result = yield* db.execute<Row>({
      label: "spaces-root-observation.targets.read",
      text: `SELECT canonical_root,delegation_address
               FROM spaces_operator_assignment_current
              WHERE network='mainnet' AND status='active'
              ORDER BY canonical_root
              LIMIT $1`,
      values: [MAX_ROOTS + 1],
      readonly: true,
    });
    if (result.rows.length > MAX_ROOTS) return yield* Effect.fail(storage("invalid-row"));
    return yield* Effect.try({
      try: () =>
        result.rows.map((row) => {
          const delegationAddress = text(row, "delegation_address");
          return {
            canonicalRoot: text(row, "canonical_root"),
            delegationAddress,
            delegationScript: spacesDelegationScriptV1(delegationAddress),
          };
        }),
      catch: () => storage("invalid-row"),
    });
  });
  const databaseNow = Effect.gen(function* () {
    const db = yield* ControlPlaneDb;
    const result = yield* db.execute<Row>({
      label: "spaces-root-observation.clock.read",
      text: "SELECT clock_timestamp() AS now",
      values: [],
      readonly: true,
    });
    return yield* Effect.try({
      try: () => {
        if (result.rows.length !== 1 || result.rows[0] === undefined) {
          throw new Error("invalid database clock");
        }
        return instant(result.rows[0].now);
      },
      catch: () => storage("invalid-row"),
    });
  });
  return {
    list: () => mapped(Effect.provide(runtime)(list)),
    databaseNow: () => mapped(Effect.provide(runtime)(databaseNow)),
  };
}

import { ControlPlaneAcquireFailed, ControlPlaneDb } from "@pirate/application";
import { Effect, Layer, Schema } from "effect";
import {
  type HyperdriveConnection,
  makeHyperdriveControlPlaneLayer,
  type PostgresControlPlaneOptions,
} from "./postgres.ts";

export type SongFundingLane = "eoa" | "safe" | null;

/** Called after the owning Worker's environment, RPC and attestation checks. */
export function songFundingLane(config: {
  readonly MEGAPOT_REWARDS_ENABLED: boolean;
  readonly SAFE_POOL_PILOT_ENABLED: boolean;
  readonly API_NEXT_ENV: string;
  readonly SAFE_POOL_PRODUCTION_ENABLED: boolean;
}): SongFundingLane {
  if (config.MEGAPOT_REWARDS_ENABLED && config.SAFE_POOL_PILOT_ENABLED)
    throw Error("Reward lanes are mutually exclusive");
  if (config.MEGAPOT_REWARDS_ENABLED) return "eoa";
  return config.SAFE_POOL_PILOT_ENABLED &&
    (config.API_NEXT_ENV !== "production" || config.SAFE_POOL_PRODUCTION_ENABLED)
    ? "safe"
    : null;
}

const bindingSchema = Schema.Struct({ connectionString: Schema.NonEmptyString });

/** A missing funding capability never borrows the general/Dance connection.
 * Keep a configured funding reader when disabled, for immutable receipt replay.
 * With no binding, unrelated Rewards-off requests can still be served. */
export function makeSongFundingConnection(
  binding: unknown,
  general: HyperdriveConnection,
  lane: SongFundingLane,
  options: PostgresControlPlaneOptions = {},
) {
  if (binding === undefined && lane === null)
    return Layer.effect(
      ControlPlaneDb,
      Effect.fail(
        new ControlPlaneAcquireFailed({ phase: "acquisition", limitMs: 0, elapsedMs: 0 }),
      ),
    );
  try {
    const funding = Schema.decodeUnknownSync(bindingSchema)(binding);
    if (funding.connectionString === general.connectionString) throw Error("aliased binding");
    return makeHyperdriveControlPlaneLayer(funding, options);
  } catch {
    // Neither binding values nor database credentials belong in a public error.
    throw Error("Dedicated song funding connection is missing or invalid");
  }
}

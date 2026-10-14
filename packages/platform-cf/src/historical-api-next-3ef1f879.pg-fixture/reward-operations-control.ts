import {
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
  RewardOperationsPaused,
  RewardRunAuthorityUnavailable,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

/** A missing row never authorizes admission. SQL errors remain failures. */
export const makeRewardOperationsRunningReader =
  (layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>) => () =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<{ readonly paused: boolean }>({
        label: "reward-operations.control.read",
        text: "SELECT paused FROM reward_operations_control WHERE singleton",
        values: [],
        readonly: true,
      });
      return result.rows.length === 1 && result.rows[0]?.paused === false;
    }).pipe(Effect.provide(layer));

/** Preserve a database admission refusal before a repository maps storage errors. */
export function mapRewardAdmissionFailure<E>(
  error: E | ControlPlaneError,
): E | ControlPlaneError | RewardOperationsPaused {
  return error instanceof ControlPlaneStatementFailed && error.sqlState === "PR001"
    ? new RewardOperationsPaused({ reason: "paused" })
    : error;
}

/**
 * Whether new work may still be authorized, asked immediately before each signer
 * call and each send. Where the database requires a run lease this needs a live
 * lease and a running brake; where it does not, it is always granted.
 */
export interface RewardRunAuthority {
  readonly ensure: () => Effect.Effect<
    void,
    RewardOperationsPaused | RewardRunAuthorityUnavailable
  >;
}

/**
 * One statement in its own transaction, finished before the caller signs or
 * sends: the answer authorizes the next action, it holds nothing still. Any
 * failure to get an answer refuses, and is told apart from a deliberate hold.
 */
export const makeControlPlaneRewardRunAuthority = (
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): RewardRunAuthority => ({
  ensure: () =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      yield* db.execute({
        label: "reward-run-authority.require",
        text: "SELECT require_reward_run_authority_v1()",
        values: [],
        // The function takes shared row locks, which a read-only transaction may not.
        readonly: false,
      });
    }).pipe(
      Effect.provide(layer),
      Effect.mapError((error) =>
        error instanceof ControlPlaneStatementFailed && error.sqlState === "PR001"
          ? new RewardOperationsPaused({ reason: "paused" })
          : new RewardRunAuthorityUnavailable({ reason: "unavailable" }),
      ),
    ),
});

/**
 * Whether a transaction that was signed and stored has already reached the
 * chain. A stored signature does not show it was never sent: a send can succeed
 * and the record of it fail. Only a receipt is evidence. A missing receipt or a
 * failed read proves nothing either way, so both answer false and leave the
 * decision to send with whoever must then ask for authority.
 */
export const preparedTransactionLanded = (
  rpc: { readonly readReceipt: (transactionHash: string) => Promise<unknown> },
  signedTransactionHash: string,
): Effect.Effect<boolean> =>
  Effect.tryPromise(() => rpc.readReceipt(signedTransactionHash)).pipe(
    Effect.map((receipt) => receipt !== null && receipt !== undefined),
    Effect.catch(() => Effect.succeed(false)),
  );

/**
 * The one thing a job may do about an expired run lease: pause. The database
 * function takes no argument and cannot resume. True means this call paused the
 * brake; false means there was nothing to pause.
 */
export const makeControlPlaneRewardLeaseExpiryPause =
  (layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>) =>
  (): Effect.Effect<boolean, ControlPlaneError> =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<{ readonly paused: boolean }>({
        label: "reward-run-lease.expiry.pause",
        text: "SELECT pause_reward_operations_on_lease_expiry_v1() AS paused",
        values: [],
        readonly: false,
      });
      return result.rows[0]?.paused === true;
    }).pipe(Effect.provide(layer));

import { Context, Data, type Effect } from "effect";

/**
 * Initial service-tag catalog (api-next 000 §7; 001 phase 0 step 4).
 *
 * Tags are interfaces — exactly what phase 0 exists to freeze. Lanes
 * implement these ports (platform-cf in production, testing in tests)
 * without editing this file; post-freeze changes are coordinator-mediated
 * and announced in the workspace register (001 §2). Service shapes are
 * deliberately minimal here: operations sharpen when lanes implement them,
 * via the same mediated rule.
 */

export class Clock extends Context.Service<
  Clock,
  {
    readonly now: Effect.Effect<number>;
  }
>()("Clock") {}

export class IdGen extends Context.Service<
  IdGen,
  {
    readonly next: Effect.Effect<string>;
  }
>()("IdGen") {}

/** Alert vocabulary shared by emitters and the collector (000 §12). */
export type AlertSeverity = "low" | "medium" | "high";

export interface Alert {
  readonly key: string;
  readonly severity: AlertSeverity;
  readonly body: string;
  readonly entity?: string;
}

/** Code never sends; it emits Alert values. Aggregation is downstream. */
export class AlertCollector extends Context.Service<
  AlertCollector,
  {
    readonly emit: (alert: Alert) => Effect.Effect<void>;
  }
>()("AlertCollector") {}

/** Safe outcome states used when a deadline races with driver I/O. */
export type ControlPlaneOutcomeCertainty = "not-started" | "completed" | "aborted" | "unknown";

/** Connection and acquisition failures contain no driver-specific detail. */
export class ControlPlaneAcquireFailed extends Data.TaggedError("ControlPlaneAcquireFailed")<{
  readonly phase: "connection" | "acquisition";
  readonly limitMs: number;
  readonly elapsedMs: number;
}> {}

/** A timed-out operation is only retryable after its outcome is proven safe. */
export class ControlPlaneOperationTimedOut extends Data.TaggedError(
  "ControlPlaneOperationTimedOut",
)<{
  readonly label: string;
  readonly limitMs: number;
  readonly elapsedMs: number;
  readonly outcomeCertainty: ControlPlaneOutcomeCertainty;
}> {}

/** Statement failures expose only safe Postgres classification fields. */
export class ControlPlaneStatementFailed extends Data.TaggedError("ControlPlaneStatementFailed")<{
  readonly label: string;
  readonly sqlState: string | null;
  readonly constraint: string | null;
  readonly outcomeCertainty: ControlPlaneOutcomeCertainty;
}> {}

/** Commit and rollback uncertainty is never an ordinary retryable query error. */
export class ControlPlaneTransactionOutcomeUnknown extends Data.TaggedError(
  "ControlPlaneTransactionOutcomeUnknown",
)<{
  readonly phase: "commit" | "rollback";
  readonly label: string;
  readonly limitMs: number;
  readonly elapsedMs: number;
}> {}

export type ControlPlaneError =
  | ControlPlaneAcquireFailed
  | ControlPlaneOperationTimedOut
  | ControlPlaneStatementFailed
  | ControlPlaneTransactionOutcomeUnknown;

/** A parameterized PostgreSQL statement with safe logging metadata. */
export interface ControlPlaneStatement {
  readonly label: string;
  readonly text: string;
  readonly values: readonly unknown[];
  readonly readonly: boolean;
}

export interface ControlPlaneResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface ControlPlaneTransaction {
  readonly execute: <Row = unknown>(
    statement: ControlPlaneStatement,
  ) => Effect.Effect<ControlPlaneResult<Row>, ControlPlaneError>;
}

/** Control-plane (Postgres) access; transactions via scoped acquire. */
export class ControlPlaneDb extends Context.Service<
  ControlPlaneDb,
  ControlPlaneTransaction & {
    readonly withTransaction: <A, E, R>(
      use: (transaction: ControlPlaneTransaction) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ControlPlaneError, R>;
  }
>()("ControlPlaneDb") {}

/** Per-community D1 shard access; resolution and fencing are lane C's. */
export class CommunityShard extends Context.Service<
  CommunityShard,
  {
    readonly shardFor: (communityId: string) => Effect.Effect<unknown>;
  }
>()("CommunityShard") {}

/** Operator key custody and signing decisions (money paths only). */
export class OperatorSigner extends Context.Service<
  OperatorSigner,
  {
    readonly sign: (request: unknown) => Effect.Effect<unknown>;
  }
>()("OperatorSigner") {}

/** Per-chain clients resolved by chain id; one tag, no provider if-chains. */
export class ChainClient extends Context.Service<
  ChainClient,
  {
    readonly forChain: (chainId: number) => Effect.Effect<unknown>;
  }
>()("ChainClient") {}

/** Verification providers (zkPassport &c.) as per-provider Layers. */
export class VerificationProvider extends Context.Service<
  VerificationProvider,
  {
    readonly verify: (input: unknown) => Effect.Effect<unknown>;
  }
>()("VerificationProvider") {}

export class TelegramBot extends Context.Service<
  TelegramBot,
  {
    readonly call: (method: string, payload: unknown) => Effect.Effect<unknown>;
  }
>()("TelegramBot") {}

export class MediaStore extends Context.Service<
  MediaStore,
  {
    readonly store: (bytes: Uint8Array) => Effect.Effect<string>;
  }
>()("MediaStore") {}

export class Analytics extends Context.Service<
  Analytics,
  {
    readonly track: (event: string, properties?: unknown) => Effect.Effect<void>;
  }
>()("Analytics") {}

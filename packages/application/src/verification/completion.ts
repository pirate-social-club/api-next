import {
  type EvidenceBundle,
  type ProofSession,
  Sha256Hex,
  type Sha256Hex as Sha256HexValue,
} from "@pirate/domain/verification";
import { Data, Effect, Option, Schema } from "effect";
import {
  type VerificationProviderFailure,
  VerificationProviderUnboundRejected,
  VerificationSubmission,
} from "./adapter.ts";
import type {
  VerificationProviderRegistryService,
  VerificationProviderUnknown,
} from "./registry.ts";

export const CompleteVerificationInput = Schema.Struct({
  actor_id: Schema.NonEmptyString,
  proof_session_id: Schema.NonEmptyString,
  idempotency_key: Schema.NonEmptyString,
  submission: VerificationSubmission,
});
export type CompleteVerificationInput = Schema.Schema.Type<typeof CompleteVerificationInput>;

export interface StoredVerificationCompletion {
  readonly session: ProofSession;
  readonly terminal: null | {
    readonly status: "completed" | "failed" | "expired";
    readonly idempotency_key: string;
    readonly result_hash: Sha256HexValue;
  };
}

export type VerificationCompletionCommitOutcome =
  | {
      readonly kind: "committed" | "replay";
      readonly result_hash: Sha256HexValue;
    }
  | {
      readonly kind: "rejected";
      readonly reason: "unavailable" | "expired" | "terminal" | "binding_conflict";
    };

export const VERIFICATION_COMPLETION_MAX_ATTEMPTS = 3 as const;
export const VERIFICATION_COMPLETION_ATTEMPT_LEASE_MARGIN_MS = 1_000 as const;

export type VerificationCompletionAttemptReservation = Readonly<{
  readonly attempt_id: string;
  readonly fence_token: number;
  readonly lease_expires_at: string;
}>;

export type VerificationCompletionAttemptReservationOutcome =
  | {
      readonly kind: "acquired";
      readonly reservation: VerificationCompletionAttemptReservation;
    }
  | { readonly kind: "in_flight"; readonly retry_after_seconds: number }
  | { readonly kind: "consumed" }
  | { readonly kind: "budget_exhausted" }
  | { readonly kind: "expired" }
  | { readonly kind: "unavailable" };

export interface VerificationCompletionStore {
  readonly load: (input: {
    readonly proof_session_id: string;
  }) => Effect.Effect<StoredVerificationCompletion | null, VerificationCompletionStorageFailed>;

  /**
   * Reserve one provider invocation in a short transaction. The reservation
   * is idempotent by proof session and public idempotency key; implementations
   * must not hold this transaction while provider work runs.
   */
  readonly reserveAttempt: (input: {
    readonly proof_session_id: string;
    readonly idempotency_key: string;
    readonly lease_ms: number;
    readonly max_consumed_attempts: number;
  }) => Effect.Effect<
    VerificationCompletionAttemptReservationOutcome,
    VerificationCompletionStorageFailed
  >;
  /** Release only this reservation generation after a positively identified upstream outage. */
  readonly releaseAttempt: (
    reservation: VerificationCompletionAttemptReservation,
  ) => Effect.Effect<void, VerificationCompletionStorageFailed>;
  /** Consume only this reservation generation after a cryptographically bound rejection. */
  readonly consumeAttempt: (
    reservation: VerificationCompletionAttemptReservation,
  ) => Effect.Effect<void, VerificationCompletionStorageFailed>;

  /**
   * Repair provider-independent projections for an exact completed replay.
   * This must not invoke the provider or append duplicate evidence.
   */
  readonly settleCompleted: (input: {
    readonly actor_id: string;
    readonly proof_session_id: string;
    readonly idempotency_key: string;
    readonly result_hash: Sha256HexValue;
  }) => Effect.Effect<void, VerificationCompletionStorageFailed>;

  /**
   * Implementations must lock the proof session and perform every write in one
   * local database transaction: resolve/create stable subject keys, advance
   * account-binding epochs, append receipts/bindings/assertions, transition the
   * session, and append its completion event. A concurrent terminal session is
   * returned as replay; evidence is never partially committed.
   */
  readonly commit: (input: {
    readonly actor_id: string;
    readonly idempotency_key: string;
    readonly attempt: VerificationCompletionAttemptReservation;
    readonly expected_session: ProofSession;
    readonly result_hash: Sha256HexValue;
    readonly bundle: EvidenceBundle;
  }) => Effect.Effect<VerificationCompletionCommitOutcome, VerificationCompletionStorageFailed>;
}

export interface VerificationCompletionHasher {
  readonly hash: (
    bundle: EvidenceBundle,
  ) => Effect.Effect<string, VerificationCompletionHashFailed>;
}

export interface VerificationCompletionServices {
  readonly registry: VerificationProviderRegistryService;
  readonly store: VerificationCompletionStore;
  readonly hasher: VerificationCompletionHasher;
  readonly now?: () => number;
}

export interface CompleteVerificationResult {
  readonly proof_session_id: string;
  readonly status: "completed";
  readonly result_hash: Sha256HexValue;
  readonly replayed: boolean;
}

export class VerificationCompletionRejected extends Data.TaggedError(
  "VerificationCompletionRejected",
)<{
  readonly reason:
    | "invalid"
    | "unavailable"
    | "expired"
    | "terminal"
    | "binding_conflict"
    | "attempt_in_flight"
    | "attempt_consumed"
    | "attempt_budget_exhausted";
  readonly retry_after_seconds?: number;
}> {}

export class VerificationCompletionStorageFailed extends Data.TaggedError(
  "VerificationCompletionStorageFailed",
) {}

export class VerificationCompletionHashFailed extends Data.TaggedError(
  "VerificationCompletionHashFailed",
) {}

export type VerificationCompletionFailure =
  | VerificationCompletionRejected
  | VerificationCompletionStorageFailed
  | VerificationCompletionHashFailed
  | VerificationProviderFailure
  | VerificationProviderUnknown;

function decodeInput(
  input: unknown,
): Effect.Effect<CompleteVerificationInput, VerificationCompletionRejected> {
  const decoded = Schema.decodeUnknownOption(CompleteVerificationInput)(input);
  if (
    Option.isNone(decoded) ||
    decoded.value.actor_id.trim() !== decoded.value.actor_id ||
    decoded.value.proof_session_id.trim() !== decoded.value.proof_session_id ||
    decoded.value.idempotency_key.trim() !== decoded.value.idempotency_key
  ) {
    return Effect.fail(new VerificationCompletionRejected({ reason: "invalid" }));
  }
  return Effect.succeed(decoded.value);
}

function completedResult(
  proof_session_id: string,
  result_hash: string,
  replayed: boolean,
): Effect.Effect<CompleteVerificationResult, VerificationCompletionRejected> {
  if (Option.isNone(Schema.decodeUnknownOption(Sha256Hex)(result_hash))) {
    return Effect.fail(new VerificationCompletionRejected({ reason: "terminal" }));
  }
  const validResultHash = Schema.decodeUnknownSync(Sha256Hex)(result_hash);
  return Effect.succeed({
    proof_session_id,
    status: "completed",
    result_hash: validResultHash,
    replayed,
  });
}

function terminalReplay(
  input: CompleteVerificationInput,
  stored: StoredVerificationCompletion | null,
): Effect.Effect<CompleteVerificationResult | null, VerificationCompletionRejected> {
  if (stored === null || stored.session.actor_id !== input.actor_id) {
    return Effect.fail(new VerificationCompletionRejected({ reason: "unavailable" }));
  }
  if (stored.terminal === null) return Effect.succeed(null);
  if (stored.terminal.status !== "completed") {
    return Effect.fail(
      new VerificationCompletionRejected({
        reason: stored.terminal.status === "expired" ? "expired" : "terminal",
      }),
    );
  }
  if (stored.terminal.idempotency_key !== input.idempotency_key) {
    return Effect.fail(new VerificationCompletionRejected({ reason: "terminal" }));
  }
  return completedResult(stored.session.id, stored.terminal.result_hash, true);
}

/**
 * Provider completion is deliberately transport-neutral. HTTP callbacks,
 * polled credentials, and SDK tokens arrive in the explicit `submission`
 * channel; the provider
 * adapter authenticates and decodes that value. This use case owns session
 * authorization, expiry, replay behavior, result hashing, and the atomic
 * evidence-ledger commit.
 */
export const completeVerification = Effect.fn("completeVerification")(function* (
  untrustedInput: unknown,
  services: VerificationCompletionServices,
): Effect.fn.Return<CompleteVerificationResult, VerificationCompletionFailure> {
  const input = yield* decodeInput(untrustedInput);
  const stored = yield* services.store.load({ proof_session_id: input.proof_session_id });
  const initialReplay = yield* terminalReplay(input, stored);
  if (initialReplay !== null) {
    yield* services.store.settleCompleted({
      actor_id: input.actor_id,
      proof_session_id: initialReplay.proof_session_id,
      idempotency_key: input.idempotency_key,
      result_hash: initialReplay.result_hash,
    });
    return initialReplay;
  }
  if (stored === null) return yield* new VerificationCompletionRejected({ reason: "unavailable" });

  const startedAt = services.now?.() ?? Date.now();
  const expiresAt = Date.parse(stored.session.expires_at);
  if (
    stored.session.status !== "pending" ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= startedAt
  ) {
    return yield* new VerificationCompletionRejected({ reason: "expired" });
  }

  const adapter = yield* services.registry.resolve(stored.session.provider_id);
  const attempt = yield* services.store.reserveAttempt({
    proof_session_id: stored.session.id,
    idempotency_key: input.idempotency_key,
    lease_ms:
      adapter.manifest.operation_deadlines.complete_ms +
      VERIFICATION_COMPLETION_ATTEMPT_LEASE_MARGIN_MS,
    max_consumed_attempts: VERIFICATION_COMPLETION_MAX_ATTEMPTS,
  });
  if (attempt.kind === "in_flight") {
    return yield* new VerificationCompletionRejected({
      reason: "attempt_in_flight",
      retry_after_seconds: attempt.retry_after_seconds,
    });
  }
  if (attempt.kind === "consumed") {
    return yield* new VerificationCompletionRejected({ reason: "attempt_consumed" });
  }
  if (attempt.kind === "budget_exhausted") {
    return yield* new VerificationCompletionRejected({ reason: "attempt_budget_exhausted" });
  }
  if (attempt.kind === "unavailable") {
    const raced = yield* services.store.load({ proof_session_id: input.proof_session_id });
    const replay = yield* terminalReplay(input, raced);
    if (replay !== null) {
      yield* services.store.settleCompleted({
        actor_id: input.actor_id,
        proof_session_id: replay.proof_session_id,
        idempotency_key: input.idempotency_key,
        result_hash: replay.result_hash,
      });
      return replay;
    }
    return yield* new VerificationCompletionRejected({ reason: "unavailable" });
  }
  if (attempt.kind === "expired") {
    return yield* new VerificationCompletionRejected({ reason: "expired" });
  }

  const releaseOrConsume = (
    error: VerificationProviderFailure,
  ): Effect.Effect<never, VerificationCompletionFailure> => {
    if (error instanceof VerificationProviderUnboundRejected) {
      // Keep the short lease as a temporary public-compute admission slot.
      // It expires automatically and never counts as a durable user failure.
      return Effect.fail(error);
    }
    const settle =
      error._tag === "VerificationProviderRejected"
        ? services.store.consumeAttempt(attempt.reservation)
        : services.store.releaseAttempt(attempt.reservation);
    return settle.pipe(
      Effect.mapError(() => new VerificationCompletionStorageFailed()),
      Effect.flatMap(() => Effect.fail(error)),
    );
  };
  const bundle = yield* adapter
    .complete({ session: stored.session, submission: input.submission })
    .pipe(
      Effect.matchEffect({
        onSuccess: Effect.succeed,
        onFailure: releaseOrConsume,
      }),
    );
  const resultHash = yield* services.hasher.hash(bundle).pipe(
    Effect.matchEffect({
      onSuccess: Effect.succeed,
      onFailure: (error) =>
        services.store.releaseAttempt(attempt.reservation).pipe(
          Effect.mapError(() => new VerificationCompletionStorageFailed()),
          Effect.flatMap(() => Effect.fail(error)),
        ),
    }),
  );
  if (Option.isNone(Schema.decodeUnknownOption(Sha256Hex)(resultHash))) {
    yield* services.store.releaseAttempt(attempt.reservation);
    return yield* new VerificationCompletionHashFailed();
  }
  const completedAt = services.now?.() ?? Date.now();
  if (expiresAt <= completedAt) {
    yield* services.store.consumeAttempt(attempt.reservation);
    return yield* new VerificationCompletionRejected({ reason: "expired" });
  }
  const validResultHash = Schema.decodeUnknownSync(Sha256Hex)(resultHash);

  const outcome = yield* services.store.commit({
    actor_id: input.actor_id,
    idempotency_key: input.idempotency_key,
    attempt: attempt.reservation,
    expected_session: stored.session,
    result_hash: validResultHash,
    bundle,
  });
  if (outcome.kind === "rejected") {
    yield* services.store.consumeAttempt(attempt.reservation);
    return yield* new VerificationCompletionRejected({ reason: outcome.reason });
  }
  return yield* completedResult(stored.session.id, outcome.result_hash, outcome.kind === "replay");
});

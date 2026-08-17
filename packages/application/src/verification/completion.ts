import {
  type EvidenceBundle,
  type ProofSession,
  Sha256Hex,
  type Sha256Hex as Sha256HexValue,
} from "@pirate/domain/verification";
import { Data, Effect, Option, Schema } from "effect";
import { type VerificationProviderFailure, VerificationSubmission } from "./adapter.ts";
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

export interface VerificationCompletionStore {
  readonly load: (input: {
    readonly proof_session_id: string;
  }) => Effect.Effect<StoredVerificationCompletion | null, VerificationCompletionStorageFailed>;

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
  readonly reason: "invalid" | "unavailable" | "expired" | "terminal" | "binding_conflict";
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
  if (stored === null || stored.session.actor_id !== input.actor_id) {
    return yield* new VerificationCompletionRejected({ reason: "unavailable" });
  }

  if (stored.terminal !== null) {
    if (stored.terminal.status !== "completed") {
      return yield* new VerificationCompletionRejected({
        reason: stored.terminal.status === "expired" ? "expired" : "terminal",
      });
    }
    if (stored.terminal.idempotency_key !== input.idempotency_key) {
      return yield* new VerificationCompletionRejected({ reason: "terminal" });
    }
    return yield* completedResult(stored.session.id, stored.terminal.result_hash, true);
  }

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
  const bundle = yield* adapter.complete({ session: stored.session, submission: input.submission });
  const resultHash = yield* services.hasher.hash(bundle);
  if (Option.isNone(Schema.decodeUnknownOption(Sha256Hex)(resultHash))) {
    return yield* new VerificationCompletionHashFailed();
  }
  const completedAt = services.now?.() ?? Date.now();
  if (expiresAt <= completedAt) {
    return yield* new VerificationCompletionRejected({ reason: "expired" });
  }
  const validResultHash = Schema.decodeUnknownSync(Sha256Hex)(resultHash);

  const outcome = yield* services.store.commit({
    actor_id: input.actor_id,
    idempotency_key: input.idempotency_key,
    expected_session: stored.session,
    result_hash: validResultHash,
    bundle,
  });
  if (outcome.kind === "rejected") {
    return yield* new VerificationCompletionRejected({ reason: outcome.reason });
  }
  return yield* completedResult(stored.session.id, outcome.result_hash, outcome.kind === "replay");
});

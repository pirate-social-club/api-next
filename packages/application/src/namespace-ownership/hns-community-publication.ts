import { Cause, Effect, Option, Schema } from "effect";
import {
  type HnsCommunityRootImportPollServices,
  HnsCommunityRootImportRejected,
  type HnsCommunityRootImportStorageFailed,
  PollHnsCommunityRootImportInput,
  pollHnsCommunityRootImport,
} from "./hns-community-root-import.ts";

export interface HnsCommunityPublicationClaim {
  readonly input: PollHnsCommunityRootImportInput;
  readonly fence: number;
  readonly authorized: boolean;
  /** Why an unauthorized claim stops, when it is more specific than authority. */
  readonly refusal_code?: "publication_window_closed";
}
type HnsCommunityPublicationEnqueueOutcome =
  | Readonly<{ readonly kind: "queued" | "conflict" }>
  /** The exposed plan's publication window is closed or held for recovery. */
  | Readonly<{ readonly kind: "window_closed"; readonly reason: string }>;

export interface HnsCommunityPublicationQueue {
  readonly enqueue: (
    input: PollHnsCommunityRootImportInput,
  ) => Effect.Effect<HnsCommunityPublicationEnqueueOutcome, HnsCommunityRootImportStorageFailed>;
  readonly claim: () => Effect.Effect<
    HnsCommunityPublicationClaim | null,
    HnsCommunityRootImportStorageFailed
  >;
  readonly settle: (
    claim: HnsCommunityPublicationClaim,
    state: "pending" | "completed" | "failed",
    failure: string | null,
  ) => Effect.Effect<void, HnsCommunityRootImportStorageFailed>;
}

// The HTTP command acknowledges publication; scheduled work owns continuation.
// Name signatures remain synchronous and keep their existing revision guard.
export const requestHnsCommunityPublicationCheck = Effect.fn("requestHnsCommunityPublicationCheck")(
  function* (
    untrusted: unknown,
    services: HnsCommunityRootImportPollServices,
    queue: HnsCommunityPublicationQueue,
  ) {
    const decoded = Schema.decodeUnknownOption(PollHnsCommunityRootImportInput, {
      onExcessProperty: "error",
    })(untrusted);
    if (Option.isNone(decoded))
      return yield* new HnsCommunityRootImportRejected({ reason: "invalid" });
    const input = decoded.value;
    if (input.provisioning_name_signature !== undefined)
      return yield* pollHnsCommunityRootImport(input, services);
    const current = yield* services.store.get(input);
    if (current === null) return yield* new HnsCommunityRootImportRejected({ reason: "not_found" });
    if (current.revision !== input.expected_revision)
      return yield* new HnsCommunityRootImportRejected({ reason: "conflict" });
    if (current.status !== "awaiting_owner_update")
      return yield* new HnsCommunityRootImportRejected({ reason: "invalid" });
    const queued = yield* queue.enqueue(input);
    if (queued.kind === "window_closed")
      return yield* new HnsCommunityRootImportRejected({
        reason: "publication_window_closed",
        window_reason: queued.reason,
      });
    if (queued.kind !== "queued")
      return yield* new HnsCommunityRootImportRejected({ reason: "conflict" });
    return { ...current, publication_check_pending: true, retry_after_seconds: 2 };
  },
);

export const continueHnsCommunityPublication = Effect.fn("continueHnsCommunityPublication")(
  function* (services: HnsCommunityRootImportPollServices, queue: HnsCommunityPublicationQueue) {
    const claim = yield* queue.claim();
    if (claim === null) return false;
    if (!claim.authorized) {
      yield* queue.settle(claim, "failed", claim.refusal_code ?? "authority_or_expiry");
      return true;
    }
    const result = yield* Effect.exit(
      Effect.gen(function* () {
        const current = yield* services.store.get(claim.input);
        if (current === null)
          return yield* new HnsCommunityRootImportRejected({ reason: "not_found" });
        if (current.status !== "awaiting_owner_update") return current;
        return yield* pollHnsCommunityRootImport(claim.input, services);
      }),
    );
    if (result._tag === "Failure") {
      // Transient provider/storage failures retry under the durable lease.
      // Permanent errors stop visibly instead of spinning indefinitely.
      const failure = Cause.findErrorOption(result.cause);
      const error = Option.isSome(failure) ? failure.value : undefined;
      const permanent =
        error instanceof HnsCommunityRootImportRejected && error.reason !== "ownership_unavailable";
      yield* queue.settle(
        claim,
        permanent ? "failed" : "pending",
        permanent ? error.reason : "temporary_failure",
      );
    } else {
      const status = result.value.status;
      yield* queue.settle(
        claim,
        status === "awaiting_owner_update"
          ? "pending"
          : status === "failed" || status === "expired"
            ? "failed"
            : "completed",
        null,
      );
    }
    return true;
  },
);

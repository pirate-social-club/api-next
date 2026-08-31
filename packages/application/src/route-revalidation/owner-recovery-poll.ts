import { canonicalJson } from "@pirate/domain";
import { Data, DateTime, Effect, Option, Schema } from "effect";
import type { HnsEvidenceLeasePolicy } from "../namespace-ownership/hns-control-observer.ts";
import {
  buildHnsOwnerRecoveryEvidence,
  classifyHnsOwnerRecoveryTargetResponse,
  HNS_OWNER_RECOVERY_DEFAULT_RETRY_SECONDS,
  type HnsOwnerRecoveryEvidenceEnvelopeV1,
  type HnsOwnerRecoveryPollOutcome,
  type HnsOwnerRecoveryPollRequestV1,
  type HnsOwnerRecoveryPollResponseV1,
  type HnsOwnerRecoveryResultHashInput,
  type HnsOwnerRecoveryTerminalResult,
  type HnsOwnerSameRootRecoveryProviderPollV1,
  hnsOwnerRecoveryPollHash,
  hnsOwnerRecoveryPollResponse,
  hnsOwnerRecoveryTerminalResultHash,
  planHnsOwnerRecoveryPoll,
} from "./owner-recovery.ts";
import {
  HnsOwnerRecoveryProviderFailed,
  type HnsOwnerRecoveryStoredStart,
} from "./owner-recovery-start.ts";

const CanonicalIdentifier = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.trim() === value &&
    new TextEncoder().encode(value).byteLength <= 256 &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
    })
      ? undefined
      : "Expected a canonical owner-recovery poll identifier",
  ),
);
const PositiveSafeInteger = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value > 0 ? undefined : "Expected a positive safe integer",
  ),
);

export const HNS_OWNER_RECOVERY_POLL_PROVIDER_DEADLINE_MS = 15_000;
export const HNS_OWNER_RECOVERY_POLL_LEASE_MS = 16_000;

export const PollHnsOwnerRecoveryInput = Schema.Struct({
  actor_id: CanonicalIdentifier,
  community_id: CanonicalIdentifier,
  route_recovery_id: CanonicalIdentifier,
  session_id: CanonicalIdentifier,
  expected_generation: PositiveSafeInteger,
  idempotency_key: CanonicalIdentifier,
  channel: Schema.Literal("poll_result"),
});
export type PollHnsOwnerRecoveryInput = Schema.Schema.Type<typeof PollHnsOwnerRecoveryInput>;

export type HnsOwnerRecoveryStoredTerminal = Readonly<{
  readonly idempotency_key: string;
  readonly poll_hash: string;
  readonly result_hash: string;
  readonly result: HnsOwnerRecoveryTerminalResult;
}>;

export type HnsOwnerRecoveryStoredPoll = HnsOwnerRecoveryStoredStart &
  Readonly<{
    readonly terminal: HnsOwnerRecoveryStoredTerminal | null;
  }>;

export type HnsOwnerRecoveryPollAttempt = Readonly<{
  readonly recovery_attempt_id: string;
  readonly evidence_ref: string;
  readonly observation_id: string;
  readonly fence_token: number;
  readonly database_now: string;
  readonly lease_expires_at: string;
}>;

export type HnsOwnerRecoveryPollReservationOutcome =
  | Readonly<{
      readonly kind: "acquired";
      readonly attempt: HnsOwnerRecoveryPollAttempt;
      /** Session and authority re-read under the durable reservation lock. */
      readonly stored: HnsOwnerRecoveryStoredPoll;
    }>
  | Readonly<{ readonly kind: "replay"; readonly stored: HnsOwnerRecoveryStoredPoll }>
  | Readonly<{ readonly kind: "in_flight"; readonly retry_after_seconds: number }>
  | Readonly<{ readonly kind: "not_found" }>
  | Readonly<{ readonly kind: "conflict" }>
  | Readonly<{ readonly kind: "budget_exhausted" }>;

export type HnsOwnerRecoveryPollReleaseOutcome =
  | Readonly<{ readonly kind: "released" }>
  | Readonly<{ readonly kind: "replay"; readonly stored: HnsOwnerRecoveryStoredPoll }>
  | Readonly<{ readonly kind: "lease_lost" }>
  | Readonly<{ readonly kind: "conflict" }>;

export type HnsOwnerRecoveryPollFinalizeOutcome =
  | Readonly<{ readonly kind: "committed"; readonly stored: HnsOwnerRecoveryStoredPoll }>
  | Readonly<{ readonly kind: "replay"; readonly stored: HnsOwnerRecoveryStoredPoll }>
  | Readonly<{ readonly kind: "lease_lost" }>
  | Readonly<{ readonly kind: "conflict" }>;

export interface HnsOwnerRecoveryPollStore {
  /**
   * Returns a session only after proving the actor is the exact community
   * creator. Different actors and missing community/session ids are the same
   * enumeration-safe absence.
   */
  readonly load: (
    input: Readonly<{
      readonly actor_id: string;
      readonly community_id: string;
      readonly route_recovery_id: string;
      readonly session_id: string;
    }>,
  ) => Effect.Effect<HnsOwnerRecoveryStoredPoll | null, HnsOwnerRecoveryPollStorageFailed>;
  /**
   * Under community-then-binding lock, re-proves creator and complete session
   * authority, then returns database time and a lease at least `lease_ms`
   * long. A released same-key retry with the same poll hash must reacquire the
   * same durable attempt, `evidence_ref`, and `observation_id`; new proposals
   * cannot allocate a second identity. No transaction may span the provider
   * call.
   */
  readonly reserve: (
    input: Readonly<{
      readonly request: PollHnsOwnerRecoveryInput;
      readonly expected: HnsOwnerRecoveryStoredPoll;
      readonly poll_hash: string;
      readonly recovery_attempt_id: string;
      readonly evidence_ref: string;
      readonly observation_id: string;
      readonly lease_ms: number;
    }>,
  ) => Effect.Effect<HnsOwnerRecoveryPollReservationOutcome, HnsOwnerRecoveryPollStorageFailed>;
  readonly release: (
    input: Readonly<{
      readonly request: PollHnsOwnerRecoveryInput;
      readonly expected: HnsOwnerRecoveryStoredPoll;
      readonly poll_hash: string;
      readonly attempt: HnsOwnerRecoveryPollAttempt;
    }>,
  ) => Effect.Effect<HnsOwnerRecoveryPollReleaseOutcome, HnsOwnerRecoveryPollStorageFailed>;
  /**
   * Locks community then binding; rechecks creator, session, generation,
   * current evidence, poll hash, and live fence; recomputes the provider-byte,
   * evidence, and result hashes from the exact supplied bytes/documents; and
   * atomically writes the immutable response/evidence, terminal attempt, and
   * next binding generation. It returns the exact committed or replayed row.
   */
  readonly finalize: (
    input: Readonly<{
      readonly request: PollHnsOwnerRecoveryInput;
      readonly expected: HnsOwnerRecoveryStoredPoll;
      readonly poll_hash: string;
      readonly attempt: HnsOwnerRecoveryPollAttempt;
      readonly result: HnsOwnerRecoveryTerminalResult;
      readonly evidence: HnsOwnerRecoveryEvidenceEnvelopeV1 | null;
      readonly provider_response_bytes: Uint8Array | null;
    }>,
  ) => Effect.Effect<HnsOwnerRecoveryPollFinalizeOutcome, HnsOwnerRecoveryPollStorageFailed>;
}

export interface HnsOwnerRecoveryPollProvider {
  /** Bound-only provider call; the adapter enforces the supplied deadline. */
  readonly poll: (
    request: HnsOwnerSameRootRecoveryProviderPollV1,
    options: Readonly<{ readonly deadline_ms: number; readonly observation_id: string }>,
  ) => Effect.Effect<Uint8Array, HnsOwnerRecoveryProviderFailed>;
}

export interface HnsOwnerRecoveryPollServices {
  readonly store: HnsOwnerRecoveryPollStore;
  readonly provider: HnsOwnerRecoveryPollProvider;
  readonly policy: HnsEvidenceLeasePolicy;
  readonly ids?: Readonly<{
    readonly attempt: () => string;
    readonly evidence: () => string;
    readonly observation: () => string;
  }>;
}

export class HnsOwnerRecoveryPollRejected extends Data.TaggedError("HnsOwnerRecoveryPollRejected")<{
  readonly reason: "invalid" | "not_found" | "conflict" | "in_flight" | "budget_exhausted";
  readonly retry_after_seconds?: number;
}> {}

export class HnsOwnerRecoveryPollStorageFailed extends Data.TaggedError(
  "HnsOwnerRecoveryPollStorageFailed",
) {}

export type HnsOwnerRecoveryPollFailure =
  | HnsOwnerRecoveryPollRejected
  | HnsOwnerRecoveryPollStorageFailed
  | HnsOwnerRecoveryProviderFailed;

const exactParseOptions = { onExcessProperty: "error" } as const;

function decodeInput(
  input: unknown,
): Effect.Effect<PollHnsOwnerRecoveryInput, HnsOwnerRecoveryPollRejected> {
  const decoded = Schema.decodeUnknownOption(PollHnsOwnerRecoveryInput, exactParseOptions)(input);
  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(new HnsOwnerRecoveryPollRejected({ reason: "invalid" }));
}

function generatedId(
  services: HnsOwnerRecoveryPollServices,
  kind: "attempt" | "evidence" | "observation",
): string {
  return services.ids?.[kind]() ?? `hns-owner-${kind}_${crypto.randomUUID()}`;
}

function leaseCoversProviderBoundary(attempt: HnsOwnerRecoveryPollAttempt): boolean {
  const started = DateTime.make(attempt.database_now);
  const expires = DateTime.make(attempt.lease_expires_at);
  return (
    Option.isSome(started) &&
    Option.isSome(expires) &&
    DateTime.toEpochMillis(expires.value) - DateTime.toEpochMillis(started.value) >=
      HNS_OWNER_RECOVERY_POLL_LEASE_MS
  );
}

function pollRequest(input: PollHnsOwnerRecoveryInput): HnsOwnerRecoveryPollRequestV1 {
  return {
    route_recovery_id: input.route_recovery_id,
    session_id: input.session_id,
    expected_generation: input.expected_generation,
    idempotency_key: input.idempotency_key,
    channel: input.channel,
  };
}

function validateStoredIdentity(
  input: PollHnsOwnerRecoveryInput,
  stored: HnsOwnerRecoveryStoredPoll,
): HnsOwnerRecoveryPollRejected | null {
  const session = stored.session;
  return session.actor_id === input.actor_id &&
    session.community_id === input.community_id &&
    session.route_recovery_id === input.route_recovery_id &&
    session.session_id === input.session_id &&
    session.expected_binding_generation === input.expected_generation
    ? null
    : new HnsOwnerRecoveryPollRejected({ reason: "not_found" });
}

function terminalReplay(
  input: PollHnsOwnerRecoveryInput,
  pollHash: string,
  stored: HnsOwnerRecoveryStoredPoll,
): Effect.Effect<HnsOwnerRecoveryPollResponseV1 | null, HnsOwnerRecoveryPollRejected> {
  const identityFailure = validateStoredIdentity(input, stored);
  if (identityFailure !== null) return Effect.fail(identityFailure);
  const terminal = stored.terminal;
  if (terminal === null) return Effect.succeed(null);
  if (
    terminal.idempotency_key !== input.idempotency_key ||
    terminal.poll_hash !== pollHash ||
    terminal.result.idempotency_key !== terminal.idempotency_key ||
    terminal.result.poll_hash !== terminal.poll_hash
  ) {
    return Effect.fail(new HnsOwnerRecoveryPollRejected({ reason: "conflict" }));
  }
  return Effect.tryPromise({
    try: async () => {
      if ((await terminalResultHash(terminal.result)) !== terminal.result_hash) {
        throw new Error("stored terminal result hash mismatch");
      }
      return hnsOwnerRecoveryPollResponse({
        session: stored.session,
        session_authority: stored.session_authority,
        outcome: { kind: "terminal", result: terminal.result },
        replayed: true,
      });
    },
    catch: () => new HnsOwnerRecoveryPollRejected({ reason: "conflict" }),
  });
}

function resultInput(
  input: PollHnsOwnerRecoveryInput,
  stored: HnsOwnerRecoveryStoredPoll,
  attempt: HnsOwnerRecoveryPollAttempt,
  pollHash: string,
  outcome:
    | Extract<
        HnsOwnerRecoveryPollOutcome,
        { readonly kind: "rejected" | "verified" | "source_ineligible" }
      >
    | Readonly<{ readonly kind: "expired" }>,
  evidence: HnsOwnerRecoveryEvidenceEnvelopeV1 | null,
): HnsOwnerRecoveryTerminalResult {
  if (outcome.kind === "source_ineligible") {
    return {
      route_recovery_id: stored.session.route_recovery_id,
      session_id: stored.session.session_id,
      recovery_attempt_id: attempt.recovery_attempt_id,
      route_binding_id: stored.session.route_binding_id,
      expected_binding_generation: stored.session.expected_binding_generation,
      idempotency_key: input.idempotency_key,
      poll_hash: pollHash as HnsOwnerRecoveryResultHashInput["poll_hash"],
      outcome_status: "owner_authoritative_source_ineligible",
      evidence_ref_or_null: null,
      evidence_digest_or_null: null,
      provider_response_sha256_or_null: outcome.provider_response_sha256,
      ownership_status_or_null: "disputed",
      route_lifecycle_status_or_null: "suspended",
    };
  }
  const terminalStatus =
    outcome.kind === "expired"
      ? "session_expired"
      : outcome.kind === "rejected"
        ? outcome.outcome_status
        : "verified";
  const ownershipStatus =
    terminalStatus === "verified"
      ? "verified"
      : terminalStatus === "expiry_horizon_insufficient" || terminalStatus === "session_expired"
        ? "expired"
        : "revoked";
  return {
    route_recovery_id: stored.session.route_recovery_id,
    session_id: stored.session.session_id,
    recovery_attempt_id: attempt.recovery_attempt_id,
    route_binding_id: stored.session.route_binding_id,
    expected_binding_generation: stored.session.expected_binding_generation,
    idempotency_key: input.idempotency_key,
    poll_hash: pollHash as HnsOwnerRecoveryResultHashInput["poll_hash"],
    outcome_status: terminalStatus,
    evidence_ref_or_null: evidence?.evidence_ref ?? null,
    evidence_digest_or_null: evidence?.evidence_digest ?? null,
    provider_response_sha256_or_null:
      outcome.kind === "rejected" || outcome.kind === "verified"
        ? outcome.provider_response_sha256
        : null,
    ownership_status_or_null: ownershipStatus,
    route_lifecycle_status_or_null: terminalStatus === "verified" ? "active" : "suspended",
  };
}

function terminalResultHash(result: HnsOwnerRecoveryTerminalResult): Promise<string> {
  return hnsOwnerRecoveryTerminalResultHash(result);
}

function finalizedResponse(
  input: PollHnsOwnerRecoveryInput,
  pollHash: string,
  expected: HnsOwnerRecoveryStoredPoll,
  outcome:
    | Exclude<HnsOwnerRecoveryPollReleaseOutcome, { readonly kind: "released" }>
    | HnsOwnerRecoveryPollFinalizeOutcome,
  expectedResult?: HnsOwnerRecoveryTerminalResult,
): Effect.Effect<HnsOwnerRecoveryPollResponseV1, HnsOwnerRecoveryPollRejected> {
  if (outcome.kind === "conflict") {
    return Effect.fail(new HnsOwnerRecoveryPollRejected({ reason: "conflict" }));
  }
  if (outcome.kind === "lease_lost") {
    return Effect.tryPromise({
      try: () =>
        hnsOwnerRecoveryPollResponse({
          session: expected.session,
          session_authority: expected.session_authority,
          outcome: {
            kind: "unavailable",
            retry_after_seconds: HNS_OWNER_RECOVERY_DEFAULT_RETRY_SECONDS,
            reason_code: "lease_lost",
            diagnostic_ref: null,
          },
        }),
      catch: () => new HnsOwnerRecoveryPollRejected({ reason: "conflict" }),
    });
  }
  const terminal = outcome.stored.terminal;
  if (
    terminal === null ||
    validateStoredIdentity(input, outcome.stored) !== null ||
    terminal.idempotency_key !== input.idempotency_key ||
    terminal.poll_hash !== pollHash ||
    terminal.result.idempotency_key !== terminal.idempotency_key ||
    terminal.result.poll_hash !== terminal.poll_hash ||
    (outcome.kind === "committed" &&
      (expectedResult === undefined ||
        canonicalJson(terminal.result) !== canonicalJson(expectedResult)))
  ) {
    return Effect.fail(new HnsOwnerRecoveryPollRejected({ reason: "conflict" }));
  }
  return Effect.tryPromise({
    try: async () => {
      if ((await terminalResultHash(terminal.result)) !== terminal.result_hash) {
        throw new Error("stored terminal result hash mismatch");
      }
      return hnsOwnerRecoveryPollResponse({
        session: outcome.stored.session,
        session_authority: outcome.stored.session_authority,
        outcome: { kind: "terminal", result: terminal.result },
        replayed: outcome.kind === "replay",
      });
    },
    catch: () => new HnsOwnerRecoveryPollRejected({ reason: "conflict" }),
  });
}

function settleRetryable(
  input: PollHnsOwnerRecoveryInput,
  stored: HnsOwnerRecoveryStoredPoll,
  pollHash: string,
  attempt: HnsOwnerRecoveryPollAttempt,
  store: HnsOwnerRecoveryPollStore,
): Effect.Effect<
  HnsOwnerRecoveryPollResponseV1 | null,
  HnsOwnerRecoveryPollRejected | HnsOwnerRecoveryPollStorageFailed
> {
  return store
    .release({ request: input, expected: stored, poll_hash: pollHash, attempt })
    .pipe(
      Effect.flatMap((outcome) =>
        outcome.kind === "released"
          ? Effect.succeed(null)
          : finalizedResponse(input, pollHash, stored, outcome),
      ),
    );
}

function releaseBestEffort(
  store: HnsOwnerRecoveryPollStore,
  input: Parameters<HnsOwnerRecoveryPollStore["release"]>[0],
): Effect.Effect<void> {
  return Effect.try({
    try: () => store.release(input),
    catch: () => new HnsOwnerRecoveryPollStorageFailed(),
  }).pipe(Effect.flatten, Effect.ignoreCause);
}

function finalizeWithRelease(
  store: HnsOwnerRecoveryPollStore,
  input: Parameters<HnsOwnerRecoveryPollStore["finalize"]>[0],
): Effect.Effect<HnsOwnerRecoveryPollFinalizeOutcome, HnsOwnerRecoveryPollStorageFailed> {
  return Effect.try({
    try: () => store.finalize(input),
    catch: () => new HnsOwnerRecoveryPollStorageFailed(),
  }).pipe(
    Effect.flatten,
    Effect.catchDefect(() => Effect.fail(new HnsOwnerRecoveryPollStorageFailed())),
    Effect.tapError(() => releaseBestEffort(store, input)),
  );
}

/**
 * Polls only a store-loaded owner recovery. The store owns creator checks,
 * database time, reservation fences, replay, and terminal compare-and-set.
 * The browser and scheduler may poll already-open sessions; neither may use
 * this operation to mint a recovery challenge.
 */
export const pollHnsOwnerRecovery = Effect.fn("pollHnsOwnerRecovery")(function* (
  untrustedInput: unknown,
  services: HnsOwnerRecoveryPollServices,
) {
  const input = yield* decodeInput(untrustedInput);
  const request = pollRequest(input);
  const pollHash = yield* Effect.tryPromise({
    try: () => hnsOwnerRecoveryPollHash(request),
    catch: () => new HnsOwnerRecoveryPollRejected({ reason: "invalid" }),
  });
  const stored = yield* services.store.load({
    actor_id: input.actor_id,
    community_id: input.community_id,
    route_recovery_id: input.route_recovery_id,
    session_id: input.session_id,
  });
  if (stored === null) return yield* new HnsOwnerRecoveryPollRejected({ reason: "not_found" });
  const replay = yield* terminalReplay(input, pollHash, stored);
  if (replay !== null) return replay;

  const reservation = yield* services.store.reserve({
    request: input,
    expected: stored,
    poll_hash: pollHash,
    recovery_attempt_id: generatedId(services, "attempt"),
    evidence_ref: generatedId(services, "evidence"),
    observation_id: generatedId(services, "observation"),
    lease_ms: HNS_OWNER_RECOVERY_POLL_LEASE_MS,
  });
  if (reservation.kind === "replay") {
    const reservedReplay = yield* terminalReplay(input, pollHash, reservation.stored);
    return reservedReplay === null
      ? yield* new HnsOwnerRecoveryPollRejected({ reason: "conflict" })
      : reservedReplay;
  }
  if (reservation.kind === "not_found") {
    return yield* new HnsOwnerRecoveryPollRejected({ reason: "not_found" });
  }
  if (reservation.kind === "conflict") {
    return yield* new HnsOwnerRecoveryPollRejected({ reason: "conflict" });
  }
  if (reservation.kind === "budget_exhausted") {
    return yield* new HnsOwnerRecoveryPollRejected({ reason: "budget_exhausted" });
  }
  if (reservation.kind === "in_flight") {
    return yield* new HnsOwnerRecoveryPollRejected({
      reason: "in_flight",
      retry_after_seconds: reservation.retry_after_seconds,
    });
  }
  const attempt = reservation.attempt;
  const reservedStored = reservation.stored;
  const leaseCoversBoundary = leaseCoversProviderBoundary(attempt);
  if (
    reservedStored.terminal !== null ||
    validateStoredIdentity(input, reservedStored) !== null ||
    canonicalJson(reservedStored) !== canonicalJson(stored)
  ) {
    const settled = yield* settleRetryable(
      input,
      reservedStored,
      pollHash,
      attempt,
      services.store,
    );
    if (settled !== null) return settled;
    return yield* new HnsOwnerRecoveryPollRejected({ reason: "conflict" });
  }
  if (!leaseCoversBoundary) {
    yield* releaseBestEffort(services.store, {
      request: input,
      expected: reservedStored,
      poll_hash: pollHash,
      attempt,
    });
    return yield* new HnsOwnerRecoveryPollStorageFailed();
  }
  const planBuild = yield* Effect.tryPromise({
    try: () =>
      planHnsOwnerRecoveryPoll({
        session: reservedStored.session,
        session_authority: reservedStored.session_authority,
        database_now: attempt.database_now,
      }),
    catch: () => new HnsOwnerRecoveryPollRejected({ reason: "conflict" }),
  }).pipe(
    Effect.matchEffect({
      onSuccess: (plan) => Effect.succeed({ kind: "success" as const, plan }),
      onFailure: (error) => Effect.succeed({ kind: "failure" as const, error }),
    }),
  );
  if (planBuild.kind === "failure") {
    const settled = yield* settleRetryable(
      input,
      reservedStored,
      pollHash,
      attempt,
      services.store,
    );
    if (settled !== null) return settled;
    return yield* planBuild.error;
  }
  const plan = planBuild.plan;
  if (plan.kind === "expired") {
    const result = resultInput(input, reservedStored, attempt, pollHash, plan, null);
    const finalized = yield* finalizeWithRelease(services.store, {
      request: input,
      expected: reservedStored,
      poll_hash: pollHash,
      attempt,
      result,
      evidence: null,
      provider_response_bytes: null,
    });
    return yield* finalizedResponse(input, pollHash, reservedStored, finalized, result);
  }

  const providerEffect = Effect.try({
    try: () =>
      services.provider.poll(plan.request, {
        deadline_ms: HNS_OWNER_RECOVERY_POLL_PROVIDER_DEADLINE_MS,
        observation_id: attempt.observation_id,
      }),
    catch: () => new HnsOwnerRecoveryProviderFailed({ reason: "invalid_response" }),
  });
  const providerResult = yield* providerEffect.pipe(
    Effect.flatten,
    Effect.catchDefect(() =>
      Effect.fail(new HnsOwnerRecoveryProviderFailed({ reason: "invalid_response" })),
    ),
    Effect.matchEffect({
      onSuccess: (bytes) => Effect.succeed({ kind: "success" as const, bytes }),
      onFailure: (error) => Effect.succeed({ kind: "failure" as const, error }),
    }),
  );
  if (providerResult.kind === "failure") {
    const settled = yield* settleRetryable(
      input,
      reservedStored,
      pollHash,
      attempt,
      services.store,
    );
    if (settled !== null) return settled;
    return yield* providerResult.error;
  }
  const providerResponseBytes = new Uint8Array(providerResult.bytes);
  const classified = yield* Effect.tryPromise({
    try: () =>
      classifyHnsOwnerRecoveryTargetResponse({
        session: reservedStored.session,
        session_authority: reservedStored.session_authority,
        response_bytes: providerResponseBytes,
        policy: services.policy,
        database_now: attempt.database_now,
      }),
    catch: () => new HnsOwnerRecoveryProviderFailed({ reason: "invalid_response" }),
  }).pipe(
    Effect.matchEffect({
      onSuccess: (outcome) => Effect.succeed({ kind: "success" as const, outcome }),
      onFailure: (error) => Effect.succeed({ kind: "failure" as const, error }),
    }),
  );
  if (classified.kind === "failure") {
    const settled = yield* settleRetryable(
      input,
      reservedStored,
      pollHash,
      attempt,
      services.store,
    );
    if (settled !== null) return settled;
    return yield* classified.error;
  }
  if (classified.outcome.kind === "pending" || classified.outcome.kind === "unavailable") {
    const retryOutcome = classified.outcome;
    const settled = yield* settleRetryable(
      input,
      reservedStored,
      pollHash,
      attempt,
      services.store,
    );
    if (settled !== null) return settled;
    return yield* Effect.tryPromise({
      try: () =>
        hnsOwnerRecoveryPollResponse({
          session: reservedStored.session,
          session_authority: reservedStored.session_authority,
          outcome: retryOutcome,
        }),
      catch: () => new HnsOwnerRecoveryPollRejected({ reason: "conflict" }),
    });
  }

  const terminalOutcome = classified.outcome;
  const evidenceBuild =
    terminalOutcome.kind === "verified"
      ? yield* Effect.tryPromise({
          try: () =>
            buildHnsOwnerRecoveryEvidence({
              session: reservedStored.session,
              session_authority: reservedStored.session_authority,
              recovery_attempt_id: attempt.recovery_attempt_id,
              poll_request: request,
              response_bytes: providerResponseBytes,
              policy: services.policy,
              database_now: attempt.database_now,
              binding_generation: reservedStored.session.expected_binding_generation + 1,
              evidence_ref: attempt.evidence_ref,
            }),
          catch: () => new HnsOwnerRecoveryProviderFailed({ reason: "invalid_response" }),
        }).pipe(
          Effect.matchEffect({
            onSuccess: (evidence) => Effect.succeed({ kind: "success" as const, evidence }),
            onFailure: (error) => Effect.succeed({ kind: "failure" as const, error }),
          }),
        )
      : ({ kind: "success", evidence: null } as const);
  if (evidenceBuild.kind === "failure") {
    const settled = yield* settleRetryable(
      input,
      reservedStored,
      pollHash,
      attempt,
      services.store,
    );
    if (settled !== null) return settled;
    return yield* evidenceBuild.error;
  }
  const evidence = evidenceBuild.evidence;
  const result = resultInput(input, reservedStored, attempt, pollHash, terminalOutcome, evidence);
  const finalized = yield* finalizeWithRelease(services.store, {
    request: input,
    expected: reservedStored,
    poll_hash: pollHash,
    attempt,
    result,
    evidence,
    provider_response_bytes: providerResponseBytes,
  });
  return yield* finalizedResponse(input, pollHash, reservedStored, finalized, result);
});

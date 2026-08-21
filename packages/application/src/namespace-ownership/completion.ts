import type { HnsPollResultCompletionResponseV1 } from "@pirate/contracts";
import { Data, Effect, Option, Schema } from "effect";
import {
  type NamespaceOwnershipProviderFailure,
  NamespaceOwnershipProviderInvalidResponse,
  NamespaceOwnershipProviderObservationRejected,
  NamespaceOwnershipProviderRejected,
  NamespaceOwnershipProviderUnavailable,
  type NamespaceOwnershipSession,
} from "./adapter.ts";
import {
  buildHnsOwnershipEvidence,
  decodeHnsOwnerResponseBytes,
  type HnsOwnershipEvidenceEnvelope,
  sha256Utf8,
} from "./hns-evidence.ts";
import type {
  NamespaceOwnershipProviderRegistryService,
  NamespaceOwnershipProviderUnknown,
} from "./registry.ts";

const CanonicalIdentifier = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.trim() === value &&
    new TextEncoder().encode(value).byteLength <= 256 &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
    })
      ? undefined
      : "Expected a canonical namespace-completion identifier",
  ),
);

const PositiveInteger = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value > 0 ? undefined : "Expected a positive safe integer",
  ),
);

export const CompleteNamespaceOwnershipInput = Schema.Struct({
  actor_id: CanonicalIdentifier,
  creation_intent_id: CanonicalIdentifier,
  ceremony_intent_id: CanonicalIdentifier,
  session_id: CanonicalIdentifier,
  expected_revision: PositiveInteger,
  idempotency_key: CanonicalIdentifier,
  channel: Schema.Literal("poll_result"),
});
export type CompleteNamespaceOwnershipInput = Schema.Schema.Type<
  typeof CompleteNamespaceOwnershipInput
>;

export const NAMESPACE_OWNERSHIP_COMPLETION_MAX_ATTEMPTS = 3 as const;
export const NAMESPACE_OWNERSHIP_COMPLETION_LEASE_MARGIN_MS = 1_000 as const;
export const NAMESPACE_OWNERSHIP_COMPLETION_RETRY_AFTER_SECONDS = 1 as const;

export type NamespaceOwnershipTerminalStatus = "rejected" | "verified" | "expired";

export type NamespaceOwnershipStoredCompletion = Readonly<{
  readonly namespace_session_id: string;
  readonly revision: number;
  readonly session: NamespaceOwnershipSession;
  readonly status: "pending" | "completed" | "failed" | "expired";
  readonly terminal: null | Readonly<{
    readonly status: NamespaceOwnershipTerminalStatus;
    readonly idempotency_key: string;
    readonly completion_request_hash: string;
    readonly result_hash: string;
  }>;
}>;

export type NamespaceOwnershipCompletionAttemptReservation = Readonly<{
  readonly completion_attempt_id: string;
  readonly namespace_session_id: string;
  readonly actor_id: string;
  readonly ceremony_intent_id: string;
  readonly evidence_ref: string;
  readonly fence_token: number;
  readonly lease_expires_at: string;
}>;

export type NamespaceOwnershipCompletionReservationOutcome =
  | {
      readonly kind: "acquired";
      readonly reservation: NamespaceOwnershipCompletionAttemptReservation;
    }
  | { readonly kind: "replay"; readonly stored: NamespaceOwnershipStoredCompletion }
  | { readonly kind: "expired"; readonly result_hash: string }
  | { readonly kind: "in_flight"; readonly retry_after_seconds: number }
  | { readonly kind: "consumed" }
  | { readonly kind: "budget_exhausted" }
  | { readonly kind: "idempotency_conflict" }
  | { readonly kind: "binding_conflict" }
  | { readonly kind: "not_found" };

export type NamespaceOwnershipCompletionFinalizeOutcome =
  | { readonly kind: "committed"; readonly result_hash: string }
  | {
      readonly kind: "replay";
      readonly status: NamespaceOwnershipTerminalStatus;
      readonly result_hash: string;
    }
  | { readonly kind: "expired"; readonly result_hash: string }
  | { readonly kind: "consumed" }
  | { readonly kind: "lease_lost" }
  | { readonly kind: "binding_conflict" };

export type NamespaceOwnershipCompletionReleaseOutcome =
  | { readonly kind: "released" }
  | { readonly kind: "expired"; readonly result_hash: string }
  | { readonly kind: "replay"; readonly stored: NamespaceOwnershipStoredCompletion }
  | { readonly kind: "lease_lost" }
  | { readonly kind: "binding_conflict" };

export type NamespaceOwnershipVerifiedCompletion = Readonly<{
  readonly envelope: HnsOwnershipEvidenceEnvelope;
  readonly observation: unknown;
  readonly raw_response_bytes: Uint8Array;
}>;

export interface NamespaceOwnershipCompletionStore {
  readonly load: (input: {
    readonly actor_id: string;
    readonly creation_intent_id: string;
    readonly ceremony_intent_id: string;
    readonly session_id: string;
  }) => Effect.Effect<
    NamespaceOwnershipStoredCompletion | null,
    NamespaceOwnershipCompletionStorageFailed
  >;
  readonly reserve: (input: {
    readonly actor_id: string;
    readonly creation_intent_id: string;
    readonly ceremony_intent_id: string;
    readonly session_id: string;
    readonly expected_revision: number;
    readonly idempotency_key: string;
    readonly completion_request_hash: string;
    readonly expired_result_hash: string;
    readonly completion_attempt_id: string;
    readonly evidence_ref: string;
    readonly lease_ms: number;
    readonly max_consumed_attempts: number;
  }) => Effect.Effect<
    NamespaceOwnershipCompletionReservationOutcome,
    NamespaceOwnershipCompletionStorageFailed
  >;
  readonly release: (input: {
    readonly actor_id: string;
    readonly expected: NamespaceOwnershipStoredCompletion;
    readonly idempotency_key: string;
    readonly completion_request_hash: string;
    readonly expired_result_hash: string;
    readonly attempt: NamespaceOwnershipCompletionAttemptReservation;
  }) => Effect.Effect<
    NamespaceOwnershipCompletionReleaseOutcome,
    NamespaceOwnershipCompletionStorageFailed
  >;
  readonly reject: (input: {
    readonly actor_id: string;
    readonly expected: NamespaceOwnershipStoredCompletion;
    readonly idempotency_key: string;
    readonly completion_request_hash: string;
    readonly result_hash: string;
    readonly expired_result_hash: string;
    readonly attempt: NamespaceOwnershipCompletionAttemptReservation;
  }) => Effect.Effect<
    NamespaceOwnershipCompletionFinalizeOutcome,
    NamespaceOwnershipCompletionStorageFailed
  >;
  readonly consume: (input: {
    readonly actor_id: string;
    readonly expected: NamespaceOwnershipStoredCompletion;
    readonly idempotency_key: string;
    readonly completion_request_hash: string;
    readonly expired_result_hash: string;
    readonly attempt: NamespaceOwnershipCompletionAttemptReservation;
  }) => Effect.Effect<
    NamespaceOwnershipCompletionFinalizeOutcome,
    NamespaceOwnershipCompletionStorageFailed
  >;
  readonly verify: (input: {
    readonly actor_id: string;
    readonly expected: NamespaceOwnershipStoredCompletion;
    readonly idempotency_key: string;
    readonly completion_request_hash: string;
    readonly result_hash: string;
    readonly expired_result_hash: string;
    readonly attempt: NamespaceOwnershipCompletionAttemptReservation;
    readonly verified: NamespaceOwnershipVerifiedCompletion;
  }) => Effect.Effect<
    NamespaceOwnershipCompletionFinalizeOutcome,
    NamespaceOwnershipCompletionStorageFailed
  >;
}

export interface NamespaceOwnershipCompletionServices {
  readonly registry: NamespaceOwnershipProviderRegistryService;
  readonly store: NamespaceOwnershipCompletionStore;
  readonly ids?: Readonly<{
    readonly attempt: () => string;
    readonly evidence: () => string;
  }>;
}

export class NamespaceOwnershipCompletionRejected extends Data.TaggedError(
  "NamespaceOwnershipCompletionRejected",
)<{
  readonly reason:
    | "invalid"
    | "not_found"
    | "stale_revision"
    | "binding_conflict"
    | "idempotency_conflict"
    | "completion_in_progress"
    | "attempt_consumed"
    | "attempt_budget_exhausted";
  readonly retry_after_seconds?: number;
}> {}

export class NamespaceOwnershipCompletionStorageFailed extends Data.TaggedError(
  "NamespaceOwnershipCompletionStorageFailed",
) {}

export type NamespaceOwnershipCompletionFailure =
  | NamespaceOwnershipCompletionRejected
  | NamespaceOwnershipCompletionStorageFailed
  | NamespaceOwnershipProviderFailure
  | NamespaceOwnershipProviderUnknown;

const exactParseOptions = { onExcessProperty: "error" } as const;

function decodeInput(
  input: unknown,
): Effect.Effect<CompleteNamespaceOwnershipInput, NamespaceOwnershipCompletionRejected> {
  const decoded = Schema.decodeUnknownOption(
    CompleteNamespaceOwnershipInput,
    exactParseOptions,
  )(input);
  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(new NamespaceOwnershipCompletionRejected({ reason: "invalid" }));
}

export function hnsCompletionRequestPreimage(
  input: Pick<
    CompleteNamespaceOwnershipInput,
    | "creation_intent_id"
    | "ceremony_intent_id"
    | "session_id"
    | "expected_revision"
    | "idempotency_key"
    | "channel"
  >,
): string {
  return JSON.stringify([
    "pirate-hns-completion-request-v2",
    input.creation_intent_id,
    input.ceremony_intent_id,
    input.session_id,
    input.expected_revision,
    input.idempotency_key,
    input.channel,
    {},
  ]);
}

export function hnsCompletionRequestHash(
  input: Pick<
    CompleteNamespaceOwnershipInput,
    | "creation_intent_id"
    | "ceremony_intent_id"
    | "session_id"
    | "expected_revision"
    | "idempotency_key"
    | "channel"
  >,
): Promise<string> {
  return sha256Utf8(hnsCompletionRequestPreimage(input));
}

export function hnsTerminalResultPreimage(input: {
  readonly ceremony_intent_id: string;
  readonly session_id: string;
  readonly expected_revision: number;
  readonly idempotency_key: string;
  readonly completion_request_hash: string;
  readonly status: NamespaceOwnershipTerminalStatus;
  readonly evidence_ref: string | null;
  readonly evidence_digest: string | null;
  readonly provider_identity_digest: string | null;
}): string {
  return JSON.stringify([
    "pirate-hns-terminal-result-v1",
    input.ceremony_intent_id,
    input.session_id,
    input.expected_revision,
    input.idempotency_key,
    input.completion_request_hash,
    input.status,
    input.evidence_ref,
    input.evidence_digest,
    input.provider_identity_digest,
  ]);
}

export function hnsTerminalResultHash(
  input: Parameters<typeof hnsTerminalResultPreimage>[0],
): Promise<string> {
  return sha256Utf8(hnsTerminalResultPreimage(input));
}

function response(
  stored: Pick<NamespaceOwnershipStoredCompletion, "namespace_session_id" | "revision" | "session">,
  status: HnsPollResultCompletionResponseV1["status"],
  replayed: boolean,
  resultHash: string | null,
  retryAfterSeconds: number | null,
): HnsPollResultCompletionResponseV1 {
  return {
    ceremony_intent_id: stored.session.ceremony_intent_id,
    session_id: stored.namespace_session_id,
    revision: stored.revision,
    status,
    replayed,
    result_hash: resultHash,
    retry_after_seconds: retryAfterSeconds,
  };
}

function validateStoredIdentity(
  input: CompleteNamespaceOwnershipInput,
  stored: NamespaceOwnershipStoredCompletion,
): NamespaceOwnershipCompletionRejected | null {
  if (
    stored.namespace_session_id !== input.session_id ||
    stored.session.actor_id !== input.actor_id ||
    stored.session.creation_intent_id !== input.creation_intent_id ||
    stored.session.ceremony_intent_id !== input.ceremony_intent_id
  ) {
    return new NamespaceOwnershipCompletionRejected({ reason: "not_found" });
  }
  if (
    stored.revision !== input.expected_revision ||
    stored.session.creation_intent_id.length === 0
  ) {
    return new NamespaceOwnershipCompletionRejected({ reason: "stale_revision" });
  }
  return null;
}

function terminalReplay(
  input: CompleteNamespaceOwnershipInput,
  requestHash: string,
  stored: NamespaceOwnershipStoredCompletion,
): Effect.Effect<HnsPollResultCompletionResponseV1 | null, NamespaceOwnershipCompletionRejected> {
  const identityFailure = validateStoredIdentity(input, stored);
  if (identityFailure !== null) return Effect.fail(identityFailure);
  if (stored.terminal === null) {
    return stored.status === "pending"
      ? Effect.succeed(null)
      : Effect.fail(new NamespaceOwnershipCompletionRejected({ reason: "binding_conflict" }));
  }
  if (stored.terminal.idempotency_key !== input.idempotency_key) {
    return Effect.fail(
      new NamespaceOwnershipCompletionRejected({ reason: "idempotency_conflict" }),
    );
  }
  if (stored.terminal.completion_request_hash !== requestHash) {
    return Effect.fail(
      new NamespaceOwnershipCompletionRejected({ reason: "idempotency_conflict" }),
    );
  }
  return Effect.succeed(
    response(stored, stored.terminal.status, true, stored.terminal.result_hash, null),
  );
}

function generatedId(
  ids: NamespaceOwnershipCompletionServices["ids"],
  kind: "attempt" | "evidence",
): string {
  const supplied = ids?.[kind]();
  if (supplied !== undefined) return supplied;
  return `namespace-${kind}_${crypto.randomUUID()}`;
}

function terminalHashInput(
  input: CompleteNamespaceOwnershipInput,
  completionRequestHash: string,
  status: NamespaceOwnershipTerminalStatus,
  evidence: HnsOwnershipEvidenceEnvelope | null,
): Parameters<typeof hnsTerminalResultHash>[0] {
  return {
    ceremony_intent_id: input.ceremony_intent_id,
    session_id: input.session_id,
    expected_revision: input.expected_revision,
    idempotency_key: input.idempotency_key,
    completion_request_hash: completionRequestHash,
    status,
    evidence_ref: evidence?.evidence_ref ?? null,
    evidence_digest: evidence?.evidence_digest ?? null,
    provider_identity_digest: evidence?.provider_identity_digest ?? null,
  };
}

function finalizeResponse(
  stored: NamespaceOwnershipStoredCompletion,
  outcome: NamespaceOwnershipCompletionFinalizeOutcome,
  requestedStatus: "rejected" | "verified",
): Effect.Effect<HnsPollResultCompletionResponseV1, NamespaceOwnershipCompletionRejected> {
  if (outcome.kind === "binding_conflict") {
    return Effect.fail(new NamespaceOwnershipCompletionRejected({ reason: "binding_conflict" }));
  }
  if (outcome.kind === "lease_lost") {
    return Effect.succeed(
      response(
        stored,
        "unavailable",
        false,
        null,
        NAMESPACE_OWNERSHIP_COMPLETION_RETRY_AFTER_SECONDS,
      ),
    );
  }
  if (outcome.kind === "consumed") {
    return Effect.fail(new NamespaceOwnershipCompletionRejected({ reason: "attempt_consumed" }));
  }
  const status =
    outcome.kind === "expired"
      ? "expired"
      : outcome.kind === "replay"
        ? outcome.status
        : requestedStatus;
  return Effect.succeed(
    response(stored, status, outcome.kind === "replay", outcome.result_hash, null),
  );
}

function settleRetryableAttempt(
  input: CompleteNamespaceOwnershipInput,
  stored: NamespaceOwnershipStoredCompletion,
  completionRequestHash: string,
  expiredResultHash: string,
  attempt: NamespaceOwnershipCompletionAttemptReservation,
  store: NamespaceOwnershipCompletionStore,
): Effect.Effect<
  HnsPollResultCompletionResponseV1 | null,
  NamespaceOwnershipCompletionRejected | NamespaceOwnershipCompletionStorageFailed
> {
  return store
    .release({
      actor_id: input.actor_id,
      expected: stored,
      idempotency_key: input.idempotency_key,
      completion_request_hash: completionRequestHash,
      expired_result_hash: expiredResultHash,
      attempt,
    })
    .pipe(
      Effect.flatMap((outcome) => {
        if (outcome.kind === "released") return Effect.succeed(null);
        if (outcome.kind === "expired") {
          return Effect.succeed(response(stored, "expired", false, outcome.result_hash, null));
        }
        if (outcome.kind === "lease_lost") {
          return Effect.succeed(
            response(
              stored,
              "unavailable",
              false,
              null,
              NAMESPACE_OWNERSHIP_COMPLETION_RETRY_AFTER_SECONDS,
            ),
          );
        }
        if (outcome.kind === "binding_conflict") {
          return Effect.fail(
            new NamespaceOwnershipCompletionRejected({ reason: "binding_conflict" }),
          );
        }
        return terminalReplay(input, completionRequestHash, outcome.stored).pipe(
          Effect.flatMap((replay) =>
            replay === null
              ? Effect.fail(
                  new NamespaceOwnershipCompletionRejected({ reason: "binding_conflict" }),
                )
              : Effect.succeed(replay),
          ),
        );
      }),
    );
}

/**
 * Polls one target-owned namespace session. Durable replay happens before
 * registry resolution, and every provider call runs outside the reservation
 * and finalize transactions.
 */
export const completeNamespaceOwnership = Effect.fn("completeNamespaceOwnership")(function* (
  untrustedInput: unknown,
  services: NamespaceOwnershipCompletionServices,
): Effect.fn.Return<HnsPollResultCompletionResponseV1, NamespaceOwnershipCompletionFailure> {
  const input = yield* decodeInput(untrustedInput);
  const completionRequestHash = yield* Effect.promise(() => hnsCompletionRequestHash(input));
  const expiredResultHash = yield* Effect.promise(() =>
    hnsTerminalResultHash(terminalHashInput(input, completionRequestHash, "expired", null)),
  );
  const stored = yield* services.store.load({
    actor_id: input.actor_id,
    creation_intent_id: input.creation_intent_id,
    ceremony_intent_id: input.ceremony_intent_id,
    session_id: input.session_id,
  });
  if (stored === null) {
    return yield* new NamespaceOwnershipCompletionRejected({ reason: "not_found" });
  }
  const replay = yield* terminalReplay(input, completionRequestHash, stored);
  if (replay !== null) return replay;

  const adapter = yield* services.registry.resolve(stored.session.route.family);
  if (adapter.manifest.provider_id !== stored.session.provider_id) {
    return yield* new NamespaceOwnershipCompletionRejected({ reason: "binding_conflict" });
  }

  const reservationOutcome = yield* services.store.reserve({
    actor_id: input.actor_id,
    creation_intent_id: input.creation_intent_id,
    ceremony_intent_id: input.ceremony_intent_id,
    session_id: input.session_id,
    expected_revision: input.expected_revision,
    idempotency_key: input.idempotency_key,
    completion_request_hash: completionRequestHash,
    expired_result_hash: expiredResultHash,
    completion_attempt_id: generatedId(services.ids, "attempt"),
    evidence_ref: generatedId(services.ids, "evidence"),
    lease_ms:
      adapter.manifest.operation_deadlines.complete_ms +
      NAMESPACE_OWNERSHIP_COMPLETION_LEASE_MARGIN_MS,
    max_consumed_attempts: NAMESPACE_OWNERSHIP_COMPLETION_MAX_ATTEMPTS,
  });
  if (reservationOutcome.kind === "replay") {
    const reservedReplay = yield* terminalReplay(
      input,
      completionRequestHash,
      reservationOutcome.stored,
    );
    if (reservedReplay === null) {
      return yield* new NamespaceOwnershipCompletionRejected({ reason: "binding_conflict" });
    }
    return reservedReplay;
  }
  if (reservationOutcome.kind === "expired") {
    return response(stored, "expired", false, reservationOutcome.result_hash, null);
  }
  if (reservationOutcome.kind === "in_flight") {
    return yield* new NamespaceOwnershipCompletionRejected({
      reason: "completion_in_progress",
      retry_after_seconds: reservationOutcome.retry_after_seconds,
    });
  }
  if (reservationOutcome.kind === "consumed") {
    return yield* new NamespaceOwnershipCompletionRejected({ reason: "attempt_consumed" });
  }
  if (reservationOutcome.kind === "budget_exhausted") {
    return yield* new NamespaceOwnershipCompletionRejected({
      reason: "attempt_budget_exhausted",
    });
  }
  if (reservationOutcome.kind === "idempotency_conflict") {
    return yield* new NamespaceOwnershipCompletionRejected({ reason: "idempotency_conflict" });
  }
  if (reservationOutcome.kind === "binding_conflict") {
    return yield* new NamespaceOwnershipCompletionRejected({ reason: "binding_conflict" });
  }
  if (reservationOutcome.kind === "not_found") {
    return yield* new NamespaceOwnershipCompletionRejected({ reason: "not_found" });
  }
  const attempt = reservationOutcome.reservation;

  const providerResult = yield* adapter
    .complete({ session: stored.session, submission: { channel: "poll_result", payload: {} } })
    .pipe(
      Effect.matchEffect({
        onSuccess: (value) => Effect.succeed({ kind: "success" as const, value }),
        onFailure: (error) => Effect.succeed({ kind: "failure" as const, error }),
      }),
    );

  if (providerResult.kind === "failure") {
    if (providerResult.error instanceof NamespaceOwnershipProviderObservationRejected) {
      const outcome = yield* services.store.consume({
        actor_id: input.actor_id,
        expected: stored,
        idempotency_key: input.idempotency_key,
        completion_request_hash: completionRequestHash,
        expired_result_hash: expiredResultHash,
        attempt,
      });
      if (outcome.kind === "expired") {
        return response(stored, "expired", false, outcome.result_hash, null);
      }
      if (outcome.kind === "lease_lost") {
        return response(
          stored,
          "unavailable",
          false,
          null,
          NAMESPACE_OWNERSHIP_COMPLETION_RETRY_AFTER_SECONDS,
        );
      }
      if (outcome.kind === "binding_conflict") {
        return yield* new NamespaceOwnershipCompletionRejected({ reason: "binding_conflict" });
      }
      if (outcome.kind === "replay" || outcome.kind === "committed") {
        return yield* new NamespaceOwnershipCompletionRejected({ reason: "binding_conflict" });
      }
      return yield* providerResult.error;
    }
    if (providerResult.error instanceof NamespaceOwnershipProviderRejected) {
      const resultHash = yield* Effect.promise(() =>
        hnsTerminalResultHash(terminalHashInput(input, completionRequestHash, "rejected", null)),
      );
      const outcome = yield* services.store.reject({
        actor_id: input.actor_id,
        expected: stored,
        idempotency_key: input.idempotency_key,
        completion_request_hash: completionRequestHash,
        result_hash: resultHash,
        expired_result_hash: expiredResultHash,
        attempt,
      });
      return yield* finalizeResponse(stored, outcome, "rejected");
    }
    const settled = yield* settleRetryableAttempt(
      input,
      stored,
      completionRequestHash,
      expiredResultHash,
      attempt,
      services.store,
    );
    if (settled !== null) return settled;
    if (providerResult.error instanceof NamespaceOwnershipProviderUnavailable) {
      return response(
        stored,
        "unavailable",
        false,
        null,
        NAMESPACE_OWNERSHIP_COMPLETION_RETRY_AFTER_SECONDS,
      );
    }
    return yield* providerResult.error;
  }

  if (providerResult.value.status === "pending") {
    const settled = yield* settleRetryableAttempt(
      input,
      stored,
      completionRequestHash,
      expiredResultHash,
      attempt,
      services.store,
    );
    if (settled !== null) return settled;
    return response(
      stored,
      "pending",
      false,
      null,
      NAMESPACE_OWNERSHIP_COMPLETION_RETRY_AFTER_SECONDS,
    );
  }
  const verifiedProviderResult = providerResult.value;

  const evidenceBuild = yield* Effect.tryPromise({
    try: async () => {
      const decodedRaw = decodeHnsOwnerResponseBytes(verifiedProviderResult.raw_response_bytes);
      if (
        decodedRaw.response.status !== "verified" ||
        decodedRaw.response.provider_evidence_ref !==
          verifiedProviderResult.provider_evidence_ref ||
        decodedRaw.response.observed_at !== verifiedProviderResult.observed_at ||
        decodedRaw.response.expires_at !== verifiedProviderResult.expires_at
      ) {
        throw new TypeError("HNS completion metadata does not match its exact response bytes");
      }
      const envelope = await buildHnsOwnershipEvidence({
        actor_id: stored.session.actor_id,
        creation_intent_id: stored.session.creation_intent_id,
        ceremony_intent_id: stored.session.ceremony_intent_id,
        requirement_hash: stored.session.requirement_hash,
        generation: stored.session.generation,
        provider_id: stored.session.provider_id,
        provider_binding_hash: stored.session.provider_binding_hash,
        provider_configuration: stored.session.provider_configuration,
        protocol_version: stored.session.protocol_version,
        environment: stored.session.environment,
        route: stored.session.route,
        request_hash: stored.session.request_hash,
        upstream_session_ref: stored.session.upstream_session_ref,
        evidence_ref: attempt.evidence_ref,
        raw_response_bytes: verifiedProviderResult.raw_response_bytes,
      });
      return { envelope, observation: decodedRaw.response };
    },
    catch: () => undefined,
  }).pipe(
    Effect.matchEffect({
      onSuccess: (value) => Effect.succeed({ kind: "success" as const, value }),
      onFailure: () => Effect.succeed({ kind: "failure" as const }),
    }),
  );
  if (evidenceBuild.kind === "failure") {
    const settled = yield* settleRetryableAttempt(
      input,
      stored,
      completionRequestHash,
      expiredResultHash,
      attempt,
      services.store,
    );
    if (settled !== null) return settled;
    return yield* new NamespaceOwnershipProviderInvalidResponse({
      provider_id: stored.session.provider_id,
      operation: "complete",
    });
  }
  const envelope: HnsOwnershipEvidenceEnvelope = evidenceBuild.value.envelope;
  const resultHash = yield* Effect.promise(() =>
    hnsTerminalResultHash(terminalHashInput(input, completionRequestHash, "verified", envelope)),
  );
  const outcome = yield* services.store.verify({
    actor_id: input.actor_id,
    expected: stored,
    idempotency_key: input.idempotency_key,
    completion_request_hash: completionRequestHash,
    result_hash: resultHash,
    expired_result_hash: expiredResultHash,
    attempt,
    verified: {
      envelope,
      observation: evidenceBuild.value.observation,
      raw_response_bytes: verifiedProviderResult.raw_response_bytes,
    },
  });
  return yield* finalizeResponse(stored, outcome, "verified");
});

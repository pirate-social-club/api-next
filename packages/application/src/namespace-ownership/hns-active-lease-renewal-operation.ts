import { canonicalJson } from "@pirate/domain";
import { Data, DateTime, Effect, Option, Schema } from "effect";
import {
  buildHnsActiveLeaseRenewalEvidence,
  classifyHnsActiveLeaseRenewalResponse,
  decodeHnsActiveLeaseRenewalResponseBytes,
  encodeHnsActiveLeaseRenewalRequest,
  type HnsActiveLeaseRenewalAuthorityV1,
  type HnsActiveLeaseRenewalEvidenceEnvelopeV1,
  type HnsActiveLeaseRenewalPersistedControlIdentityV1,
  type HnsActiveLeaseRenewalResultV2HashInput,
  type HnsOwnerActiveLeaseRenewalRequestV1,
  hnsActiveLeaseRenewalResultV2Hash,
  hnsActiveLeaseRenewalResultV2Preimage,
} from "./hns-active-lease-renewal.ts";
import type { HnsEvidenceLeasePolicy } from "./hns-control-observer.ts";
import {
  decodeHnsActiveLeaseRenewalIneligibleResponseV2Bytes,
  hnsActiveLeaseRenewalSourceIneligibleResultV3Hash,
  hnsActiveLeaseRenewalSourceIneligibleResultV3Preimage,
} from "./hns-control-observer-v2.ts";

const CanonicalIdentifier = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.trim() === value &&
    new TextEncoder().encode(value).byteLength <= 256 &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
    })
      ? undefined
      : "Expected a canonical active-renewal identifier",
  ),
);

export const HNS_ACTIVE_LEASE_RENEWAL_PROVIDER_DEADLINE_MS = 12_000;
export const HNS_ACTIVE_LEASE_RENEWAL_ATTEMPT_LEASE_MS = 16_000;

export const RunHnsActiveLeaseRenewalInput = Schema.Struct({
  route_binding_id: CanonicalIdentifier,
  idempotency_key: CanonicalIdentifier,
});
export type RunHnsActiveLeaseRenewalInput = Schema.Schema.Type<
  typeof RunHnsActiveLeaseRenewalInput
>;

export type HnsActiveLeaseRenewalSourceIneligibleTerminalResult = Readonly<{
  readonly active_lease_renewal_id: string;
  readonly active_lease_renewal_attempt_id: string;
  readonly route_binding_id: string;
  readonly expected_binding_generation: number;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly outcome_status: "owner_authoritative_source_ineligible";
  readonly evidence_ref_or_null: null;
  readonly evidence_digest_or_null: null;
  readonly provider_response_sha256_or_null: string;
  readonly ownership_status_or_null: "disputed";
  readonly route_lifecycle_status_or_null: "suspended";
}>;

export type HnsActiveLeaseRenewalTerminalResult =
  | HnsActiveLeaseRenewalResultV2HashInput
  | HnsActiveLeaseRenewalSourceIneligibleTerminalResult;

export type HnsActiveLeaseRenewalStoredTerminal = Readonly<{
  readonly result: HnsActiveLeaseRenewalTerminalResult;
  readonly result_hash: string;
}>;

export type HnsActiveLeaseRenewalStoredOperation = Readonly<{
  readonly authority: HnsActiveLeaseRenewalAuthorityV1;
  readonly control_identity: HnsActiveLeaseRenewalPersistedControlIdentityV1;
  readonly terminal: HnsActiveLeaseRenewalStoredTerminal | null;
}>;

export type HnsActiveLeaseRenewalAttempt = Readonly<{
  readonly active_lease_renewal_attempt_id: string;
  readonly evidence_ref: string;
  readonly observation_id: string;
  readonly fence_token: number;
  readonly attempt_number: number;
  readonly database_now: string;
  readonly lease_expires_at: string;
}>;

export type HnsActiveLeaseRenewalReservation = Readonly<{
  readonly stored: HnsActiveLeaseRenewalStoredOperation;
  readonly request: HnsOwnerActiveLeaseRenewalRequestV1;
  readonly attempt: HnsActiveLeaseRenewalAttempt;
  readonly idempotency_key: string;
}>;

export type HnsActiveLeaseRenewalReserveOutcome =
  | Readonly<{ readonly kind: "acquired"; readonly reservation: HnsActiveLeaseRenewalReservation }>
  | Readonly<{ readonly kind: "replay"; readonly stored: HnsActiveLeaseRenewalStoredOperation }>
  | Readonly<{ readonly kind: "in_flight"; readonly retry_after_seconds: number }>
  | Readonly<{ readonly kind: "not_found" | "conflict" | "budget_exhausted" }>;

export type HnsActiveLeaseRenewalReleaseOutcome =
  | Readonly<{ readonly kind: "released" }>
  | Readonly<{ readonly kind: "replay"; readonly stored: HnsActiveLeaseRenewalStoredOperation }>
  | Readonly<{ readonly kind: "lease_lost" | "conflict" }>;

export type HnsActiveLeaseRenewalFinalizeOutcome =
  | Readonly<{
      readonly kind: "committed" | "replay";
      readonly stored: HnsActiveLeaseRenewalStoredOperation;
    }>
  | Readonly<{ readonly kind: "lease_lost" | "conflict" }>;

export interface HnsActiveLeaseRenewalStore {
  readonly resolve: (input: Readonly<{ readonly route_binding_id: string }>) => Effect.Effect<
    Readonly<{
      readonly authority: HnsActiveLeaseRenewalAuthorityV1;
      readonly control_identity: HnsActiveLeaseRenewalPersistedControlIdentityV1;
    }> | null,
    HnsActiveLeaseRenewalStorageFailed
  >;
  readonly reserve: (
    input: Readonly<{
      readonly expected: Readonly<{
        readonly authority: HnsActiveLeaseRenewalAuthorityV1;
        readonly control_identity: HnsActiveLeaseRenewalPersistedControlIdentityV1;
      }>;
      readonly active_lease_renewal_id: string;
      readonly active_lease_renewal_attempt_id: string;
      readonly evidence_ref: string;
      readonly observation_id: string;
      readonly idempotency_key: string;
      readonly lease_ms: number;
    }>,
  ) => Effect.Effect<HnsActiveLeaseRenewalReserveOutcome, HnsActiveLeaseRenewalStorageFailed>;
  readonly release: (
    reservation: HnsActiveLeaseRenewalReservation,
  ) => Effect.Effect<HnsActiveLeaseRenewalReleaseOutcome, HnsActiveLeaseRenewalStorageFailed>;
  readonly finalize: (
    input: Readonly<{
      readonly reservation: HnsActiveLeaseRenewalReservation;
      readonly result: HnsActiveLeaseRenewalTerminalResult;
      readonly evidence: HnsActiveLeaseRenewalEvidenceEnvelopeV1 | null;
      readonly provider_response_bytes: Uint8Array | null;
    }>,
  ) => Effect.Effect<HnsActiveLeaseRenewalFinalizeOutcome, HnsActiveLeaseRenewalStorageFailed>;
}

export interface HnsActiveLeaseRenewalProvider {
  readonly renew: (
    request: HnsOwnerActiveLeaseRenewalRequestV1,
    authority: HnsActiveLeaseRenewalAuthorityV1,
    options: Readonly<{ readonly deadline_ms: number; readonly observation_id: string }>,
  ) => Effect.Effect<Uint8Array, HnsActiveLeaseRenewalProviderFailed>;
}

export interface HnsActiveLeaseRenewalServices {
  readonly store: HnsActiveLeaseRenewalStore;
  readonly provider: HnsActiveLeaseRenewalProvider;
  readonly policy: HnsEvidenceLeasePolicy;
  readonly ids?: Readonly<{
    readonly renewal: () => string;
    readonly attempt: () => string;
    readonly evidence: () => string;
    readonly observation: () => string;
  }>;
}

export class HnsActiveLeaseRenewalRejected extends Data.TaggedError(
  "HnsActiveLeaseRenewalRejected",
)<{
  readonly reason: "invalid" | "not_found" | "conflict" | "in_flight" | "budget_exhausted";
  readonly retry_after_seconds?: number;
}> {}

export class HnsActiveLeaseRenewalStorageFailed extends Data.TaggedError(
  "HnsActiveLeaseRenewalStorageFailed",
) {}

export class HnsActiveLeaseRenewalProviderFailed extends Data.TaggedError(
  "HnsActiveLeaseRenewalProviderFailed",
)<{
  readonly reason:
    | "unavailable"
    | "misconfigured"
    | "invalid_response"
    | "renewal_evidence_ineligible";
}> {}

export type HnsActiveLeaseRenewalRunResult = Readonly<{
  readonly status: "verified" | "rejected" | "ineligible" | "unchanged";
  readonly outcome_status: HnsActiveLeaseRenewalTerminalResult["outcome_status"];
  readonly result_hash: string;
  readonly replayed: boolean;
}>;

function generatedId(
  services: HnsActiveLeaseRenewalServices,
  kind: "renewal" | "attempt" | "evidence" | "observation",
): string {
  return services.ids?.[kind]() ?? `hns-renewal-${kind}_${crypto.randomUUID()}`;
}

function leaseCoversBoundary(attempt: HnsActiveLeaseRenewalAttempt): boolean {
  const now = DateTime.make(attempt.database_now);
  const expires = DateTime.make(attempt.lease_expires_at);
  return (
    Option.isSome(now) &&
    Option.isSome(expires) &&
    DateTime.toEpochMillis(expires.value) - DateTime.toEpochMillis(now.value) >=
      HNS_ACTIVE_LEASE_RENEWAL_ATTEMPT_LEASE_MS
  );
}

export function hnsActiveLeaseRenewalTerminalResultHash(
  result: HnsActiveLeaseRenewalTerminalResult,
): Promise<string> {
  return result.outcome_status === "owner_authoritative_source_ineligible"
    ? hnsActiveLeaseRenewalSourceIneligibleResultV3Hash({
        active_lease_renewal_id: result.active_lease_renewal_id,
        active_lease_renewal_attempt_id: result.active_lease_renewal_attempt_id,
        route_binding_id: result.route_binding_id,
        expected_binding_generation: result.expected_binding_generation,
        idempotency_key: result.idempotency_key,
        request_hash: result.request_hash,
        provider_response_sha256: result.provider_response_sha256_or_null,
      })
    : hnsActiveLeaseRenewalResultV2Hash(result);
}

export function hnsActiveLeaseRenewalTerminalResultPreimage(
  result: HnsActiveLeaseRenewalTerminalResult,
): string {
  return result.outcome_status === "owner_authoritative_source_ineligible"
    ? hnsActiveLeaseRenewalSourceIneligibleResultV3Preimage({
        active_lease_renewal_id: result.active_lease_renewal_id,
        active_lease_renewal_attempt_id: result.active_lease_renewal_attempt_id,
        route_binding_id: result.route_binding_id,
        expected_binding_generation: result.expected_binding_generation,
        idempotency_key: result.idempotency_key,
        request_hash: result.request_hash,
        provider_response_sha256: result.provider_response_sha256_or_null,
      })
    : hnsActiveLeaseRenewalResultV2Preimage(result);
}

function runResult(
  stored: HnsActiveLeaseRenewalStoredOperation,
  replayed: boolean,
): Effect.Effect<HnsActiveLeaseRenewalRunResult, HnsActiveLeaseRenewalRejected> {
  const terminal = stored.terminal;
  if (terminal === null) {
    return Effect.fail(new HnsActiveLeaseRenewalRejected({ reason: "conflict" }));
  }
  return Effect.tryPromise({
    try: async () => {
      if (
        (await hnsActiveLeaseRenewalTerminalResultHash(terminal.result)) !== terminal.result_hash
      ) {
        throw new TypeError("Stored active-renewal result hash mismatch");
      }
      const outcome = terminal.result.outcome_status;
      return {
        status:
          outcome === "verified"
            ? "verified"
            : outcome === "renewal_evidence_ineligible" ||
                outcome === "lease_expired_before_commit" ||
                outcome === "stale_cas"
              ? "unchanged"
              : outcome === "owner_authoritative_source_ineligible"
                ? "ineligible"
                : "rejected",
        outcome_status: outcome,
        result_hash: terminal.result_hash,
        replayed,
      } as const;
    },
    catch: () => new HnsActiveLeaseRenewalRejected({ reason: "conflict" }),
  });
}

function resultFor(
  reservation: HnsActiveLeaseRenewalReservation,
  outcome: HnsActiveLeaseRenewalTerminalResult["outcome_status"],
  providerResponseSha256: string | null,
  evidence: HnsActiveLeaseRenewalEvidenceEnvelopeV1 | null,
): HnsActiveLeaseRenewalTerminalResult {
  const request = reservation.request;
  if (outcome === "owner_authoritative_source_ineligible") {
    if (providerResponseSha256 === null) throw new TypeError("Source ineligibility requires bytes");
    return {
      active_lease_renewal_id: request.active_lease_renewal_id,
      active_lease_renewal_attempt_id: request.active_lease_renewal_attempt_id,
      route_binding_id: request.route_binding_id,
      expected_binding_generation: request.expected_binding_generation,
      idempotency_key: reservation.idempotency_key,
      request_hash: request.request_hash,
      outcome_status: outcome,
      evidence_ref_or_null: null,
      evidence_digest_or_null: null,
      provider_response_sha256_or_null: providerResponseSha256,
      ownership_status_or_null: "disputed",
      route_lifecycle_status_or_null: "suspended",
    };
  }
  const ownership =
    outcome === "verified"
      ? "verified"
      : outcome === "root_absent" || outcome === "root_inactive"
        ? "revoked"
        : outcome === "expiry_horizon_insufficient"
          ? "expired"
          : outcome === "renewal_evidence_ineligible" ||
              outcome === "lease_expired_before_commit" ||
              outcome === "stale_cas"
            ? null
            : "disputed";
  return {
    active_lease_renewal_id: request.active_lease_renewal_id,
    active_lease_renewal_attempt_id: request.active_lease_renewal_attempt_id,
    route_binding_id: request.route_binding_id,
    expected_binding_generation: request.expected_binding_generation,
    idempotency_key: reservation.idempotency_key,
    request_hash: request.request_hash,
    outcome_status: outcome,
    evidence_ref_or_null: evidence?.evidence_ref ?? null,
    evidence_digest_or_null: evidence?.evidence_digest ?? null,
    provider_response_sha256_or_null: providerResponseSha256,
    ownership_status_or_null: ownership,
    route_lifecycle_status_or_null:
      ownership === null ? null : outcome === "verified" ? "active" : "suspended",
  };
}

function releaseBestEffort(
  store: HnsActiveLeaseRenewalStore,
  reservation: HnsActiveLeaseRenewalReservation,
): Effect.Effect<void> {
  return store.release(reservation).pipe(Effect.ignoreCause);
}

const exactParseOptions = { onExcessProperty: "error" } as const;

export const runHnsActiveLeaseRenewal = Effect.fn("runHnsActiveLeaseRenewal")(function* (
  untrustedInput: unknown,
  services: HnsActiveLeaseRenewalServices,
) {
  const decoded = Schema.decodeUnknownOption(
    RunHnsActiveLeaseRenewalInput,
    exactParseOptions,
  )(untrustedInput);
  if (Option.isNone(decoded)) {
    return yield* new HnsActiveLeaseRenewalRejected({ reason: "invalid" });
  }
  const input = decoded.value;
  const expected = yield* services.store.resolve({ route_binding_id: input.route_binding_id });
  if (expected === null) {
    return yield* new HnsActiveLeaseRenewalRejected({ reason: "not_found" });
  }
  const reserved = yield* services.store.reserve({
    expected,
    active_lease_renewal_id: generatedId(services, "renewal"),
    active_lease_renewal_attempt_id: generatedId(services, "attempt"),
    evidence_ref: generatedId(services, "evidence"),
    observation_id: generatedId(services, "observation"),
    idempotency_key: input.idempotency_key,
    lease_ms: HNS_ACTIVE_LEASE_RENEWAL_ATTEMPT_LEASE_MS,
  });
  if (reserved.kind === "replay") return yield* runResult(reserved.stored, true);
  if (reserved.kind === "in_flight") {
    return yield* new HnsActiveLeaseRenewalRejected({
      reason: "in_flight",
      retry_after_seconds: reserved.retry_after_seconds,
    });
  }
  if (reserved.kind !== "acquired") {
    return yield* new HnsActiveLeaseRenewalRejected({ reason: reserved.kind });
  }
  const reservation = reserved.reservation;
  if (
    !leaseCoversBoundary(reservation.attempt) ||
    canonicalJson(reservation.stored.authority) !== canonicalJson(expected.authority) ||
    canonicalJson(reservation.stored.control_identity) !== canonicalJson(expected.control_identity)
  ) {
    yield* releaseBestEffort(services.store, reservation);
    return yield* new HnsActiveLeaseRenewalRejected({ reason: "conflict" });
  }
  const requestValid = yield* Effect.tryPromise({
    try: () =>
      encodeHnsActiveLeaseRenewalRequest(reservation.request, reservation.stored.authority),
    catch: () => new HnsActiveLeaseRenewalRejected({ reason: "conflict" }),
  }).pipe(Effect.option);
  if (Option.isNone(requestValid)) {
    yield* releaseBestEffort(services.store, reservation);
    return yield* new HnsActiveLeaseRenewalRejected({ reason: "conflict" });
  }

  const provider = yield* services.provider
    .renew(reservation.request, reservation.stored.authority, {
      deadline_ms: HNS_ACTIVE_LEASE_RENEWAL_PROVIDER_DEADLINE_MS,
      observation_id: reservation.attempt.observation_id,
    })
    .pipe(
      Effect.matchEffect({
        onSuccess: (bytes) => Effect.succeed({ kind: "bytes" as const, bytes }),
        onFailure: (error) => Effect.succeed({ kind: "error" as const, error }),
      }),
    );
  if (provider.kind === "error") {
    if (provider.error.reason !== "renewal_evidence_ineligible") {
      yield* releaseBestEffort(services.store, reservation);
      return yield* provider.error;
    }
    const result = resultFor(reservation, "renewal_evidence_ineligible", null, null);
    const finalized = yield* services.store.finalize({
      reservation,
      result,
      evidence: null,
      provider_response_bytes: null,
    });
    return finalized.kind === "committed" || finalized.kind === "replay"
      ? yield* runResult(finalized.stored, finalized.kind === "replay")
      : yield* new HnsActiveLeaseRenewalRejected({ reason: "conflict" });
  }

  const responseBytes = new Uint8Array(provider.bytes);
  if (reservation.stored.authority.provider_configuration.version === "hns-observer-config-v2") {
    const ineligible = yield* Effect.tryPromise({
      try: () => decodeHnsActiveLeaseRenewalIneligibleResponseV2Bytes(responseBytes),
      catch: () => undefined,
    }).pipe(Effect.option);
    if (Option.isSome(ineligible)) {
      if (
        ineligible.value.response.active_lease_renewal_id !==
          reservation.request.active_lease_renewal_id ||
        ineligible.value.response.active_lease_renewal_attempt_id !==
          reservation.request.active_lease_renewal_attempt_id ||
        ineligible.value.response.request_hash !== reservation.request.request_hash
      ) {
        yield* releaseBestEffort(services.store, reservation);
        return yield* new HnsActiveLeaseRenewalProviderFailed({
          reason: "invalid_response",
        });
      }
      const result = resultFor(
        reservation,
        "owner_authoritative_source_ineligible",
        ineligible.value.response_sha256,
        null,
      );
      const finalized = yield* services.store.finalize({
        reservation,
        result,
        evidence: null,
        provider_response_bytes: responseBytes,
      });
      return finalized.kind === "committed" || finalized.kind === "replay"
        ? yield* runResult(finalized.stored, finalized.kind === "replay")
        : yield* new HnsActiveLeaseRenewalRejected({ reason: "conflict" });
    }
  }

  const decodedResponse = yield* Effect.tryPromise({
    try: () =>
      decodeHnsActiveLeaseRenewalResponseBytes(responseBytes, {
        request: reservation.request,
        authority: reservation.stored.authority,
        control_identity: reservation.stored.control_identity,
        policy: services.policy,
      }),
    catch: () => new HnsActiveLeaseRenewalProviderFailed({ reason: "invalid_response" }),
  }).pipe(
    Effect.matchEffect({
      onSuccess: (value) => Effect.succeed({ kind: "success" as const, value }),
      onFailure: (error) => Effect.succeed({ kind: "failure" as const, error }),
    }),
  );
  if (decodedResponse.kind === "failure") {
    yield* releaseBestEffort(services.store, reservation);
    return yield* decodedResponse.error;
  }
  const response = decodedResponse.value.response;
  const outcome = classifyHnsActiveLeaseRenewalResponse(
    response,
    reservation.request.expected_control_identity_digest,
    reservation.request.expected_chain_authority_digest,
  );
  if (outcome === null) {
    yield* releaseBestEffort(services.store, reservation);
    return yield* new HnsActiveLeaseRenewalProviderFailed({ reason: "unavailable" });
  }
  const evidence =
    outcome === "verified"
      ? yield* Effect.tryPromise({
          try: () =>
            buildHnsActiveLeaseRenewalEvidence({
              request: reservation.request,
              authority: reservation.stored.authority,
              control_identity: reservation.stored.control_identity,
              principal_id: reservation.stored.authority.principal_id,
              binding_generation: reservation.request.expected_binding_generation + 1,
              policy: services.policy,
              provider_response_bytes: responseBytes,
            }),
          catch: () => new HnsActiveLeaseRenewalProviderFailed({ reason: "invalid_response" }),
        })
      : null;
  const result = resultFor(reservation, outcome, decodedResponse.value.response_sha256, evidence);
  const finalized = yield* services.store.finalize({
    reservation,
    result,
    evidence,
    provider_response_bytes: responseBytes,
  });
  return finalized.kind === "committed" || finalized.kind === "replay"
    ? yield* runResult(finalized.stored, finalized.kind === "replay")
    : yield* new HnsActiveLeaseRenewalRejected({ reason: "conflict" });
});

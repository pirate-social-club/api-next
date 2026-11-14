import { Clock, Context, Effect, Schema } from "effect";
import {
  verifyTypedData,
  keccak256,
  encodeAbiParameters,
  stringToHex,
  type Hex,
} from "viem";
import {
  Ceremony,
  ApplyObservation,
  CreateCeremony,
  CheckDeadlines,
  StateConflict,
  ReserveObservation,
} from "./aggregate.ts";
import {
  Binding,
  bindingDigest,
  challengeDigest,
  consentData,
  Seconds,
} from "./protocol.ts";
import {
  challengeRecord,
  Hash,
  preflight,
  toHex,
  RecordConflict,
} from "./records.ts";
import type { HnsRootResourceRecordV1 } from "./resource-types.ts";
import type { EvidenceOutcome } from "./observation.ts";
import type { State } from "./ceremony.ts";
import {
  HnsResourceCodecError,
  preflightEncodeHnsResourceV1,
} from "./resource-codec.ts";
import {
  actionCodes,
  unavailableCodes,
  Code,
  ConflictDetail,
} from "./outcomes.ts";

export class AdmissionError extends Schema.TaggedError<AdmissionError>()(
  "AdmissionError",
  { reason: Code, detail: Schema.optionalKey(ConflictDetail) },
) {}
export class HnsObserver extends Context.Service<
  HnsObserver,
  {
    baseline: (
      binding: Binding,
    ) => Effect.Effect<
      { records: readonly HnsRootResourceRecordV1[]; ownershipEpoch: string },
      AdmissionError
    >;
    observe: (state: State) => Effect.Effect<EvidenceOutcome, AdmissionError>;
  }
>()("@pirate/hns-admission/HnsObserver") {}
const Signature = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{130}$/));
export const CreateInput = Schema.Struct({
  idempotencyKey: Hash,
  binding: Binding,
});
export const ConsentInput = Schema.Struct({
  expectedRevision: Schema.Int,
  issuedAt: Seconds,
  deadline: Seconds,
  signature: Signature,
});
export const RevisionInput = Schema.Struct({ expectedRevision: Schema.Int });
const fail = (reason: Code) => new AdmissionError({ reason });
const planAttempt = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (e) =>
      e instanceof RecordConflict
        ? new AdmissionError({ reason: e.reason, detail: e.detail })
        : fail(
            e instanceof HnsResourceCodecError &&
              e.reason === "resource_too_large"
              ? "resource_capacity_exceeded"
              : "invalid_request",
          ),
  });
const attempt = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: () => fail("invalid_request") });
export const create = Effect.fn("Admission.create")(function* (
  input: typeof CreateInput.Type,
) {
  const model = yield* Ceremony,
    observer = yield* HnsObserver;
  const digest = yield* Effect.try({
    try: () => bindingDigest(input.binding),
    catch: () => fail("invalid_request"),
  });
  const id = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }],
      [
        keccak256(stringToHex("pirate.ceremony-id/1")),
        input.binding.controller as Hex,
        input.idempotencyKey as Hex,
      ],
    ),
  );
  const previous = yield* model.get(id);
  if (previous) {
    if (previous.bindingDigest !== digest)
      return yield* fail("request_conflict");
    return previous;
  }
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const baseline = yield* observer.baseline(input.binding);
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32))) as Hex;
  const challenge = yield* attempt(() =>
    challengeDigest(id, digest, nonce, now + 172800),
  );
  const { chainId, registry, controller, communityId } = input.binding;
  const plan = yield* planAttempt(() =>
    preflight(
      baseline.records,
      { chainId, registry, controller, communityId },
      challenge,
    ),
  );
  const snapshot: State = {
    id,
    binding: input.binding,
    bindingDigest: digest,
    resourceDigest: "0x" + plan.sha256,
    beforeResourceDigest: "0x" + plan.beforeSha256,
    publicationJson: JSON.stringify(plan.records),
    nonce,
    challenge: challengeRecord(challenge),
    revision: 1,
    phase: "AwaitingConsent",
    condition: "consent_required",
    createdAt: now,
    consentDeadline: now + 259200,
    publicationDeadline: now + 172800,
    firstIncludedAt: null,
    maturityDeadline: null,
    maturedAt: null,
    ownershipEpoch: baseline.ownershipEpoch,
    consented: false,
    updatedAt: now,
    nextObservationAt: 0,
    observationFailures: 0,
    conditionDetail: null,
    lastObservation: null,
  };
  yield* model.send(id, new CreateCeremony({ snapshot }));
  return (yield* model.get(id))!;
});
export const current = Effect.fn("Admission.current")(function* (id: string) {
  const model = yield* Ceremony;
  if (!(yield* model.get(id))) return yield* fail("operation_unknown");
  yield* model.send(id, new CheckDeadlines({}));
  return (yield* model.get(id))!;
});
export const instructions = Effect.fn("Admission.instructions")(function* (
  s: State,
) {
  if (!s.consented || s.phase !== "AwaitingPublication") return undefined;
  const observer = yield* HnsObserver;
  const baseline = yield* observer.baseline(s.binding);
  if (baseline.ownershipEpoch !== s.ownershipEpoch)
    return yield* fail("ownership_changed");
  const current = yield* attempt(() =>
    preflightEncodeHnsResourceV1(baseline.records),
  );
  if (
    "0x" + current.sha256 !== s.beforeResourceDigest &&
    "0x" + current.sha256 !== s.resourceDigest
  )
    return yield* fail("resource_snapshot_changed");
  const records = yield* Effect.try({
    try: () =>
      JSON.parse(s.publicationJson) as readonly HnsRootResourceRecordV1[],
    catch: () => fail("internal_error"),
  });
  const retained = yield* attempt(() => preflightEncodeHnsResourceV1(records));
  if ("0x" + retained.sha256 !== s.resourceDigest)
    return yield* fail("internal_error");
  return {
    records,
    beforeResourceDigest: s.beforeResourceDigest,
    resourceDigest: s.resourceDigest,
    publicationDeadline: s.publicationDeadline,
  };
});
export const consent = Effect.fn("Admission.consent")(function* (
  id: string,
  input: typeof ConsentInput.Type,
) {
  const s = yield* current(id);
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  if (
    input.issuedAt > now ||
    now - input.issuedAt > 300 ||
    input.deadline <= now ||
    input.deadline > input.issuedAt + 259200
  )
    return yield* fail("consent_expired");
  const valid = yield* attempt(() =>
    verifyTypedData({
      ...consentData(s.binding, {
        ceremonyId: s.id,
        bindingDigest: s.bindingDigest,
        resourceDigest: s.resourceDigest,
        nonce: s.nonce,
        issuedAt: input.issuedAt,
        deadline: input.deadline,
      }),
      address: s.binding.controller as Hex,
      signature: input.signature as Hex,
    }),
  );
  if (!valid) return yield* fail("invalid_signature");
  const model = yield* Ceremony;
  yield* model.send(
    id,
    new ApplyObservation({
      expectedRevision: input.expectedRevision,
      action: { type: "Consent", deadline: input.deadline },
    }),
  );
  return (yield* model.get(id))!;
});
export const cancel = Effect.fn("Admission.cancel")(function* (
  id: string,
  revision: number,
) {
  const model = yield* Ceremony;
  yield* model.send(
    id,
    new ApplyObservation({
      expectedRevision: revision,
      action: { type: "Cancel" },
    }),
  );
  return (yield* model.get(id))!;
});
export const observe = Effect.fn("Admission.observe")(function* (id: string) {
  const model = yield* Ceremony,
    observer = yield* HnsObserver;
  let s = yield* model.get(id);
  if (!s) return yield* fail("operation_unknown");
  if (
    s.phase === "Cancelled" ||
    s.phase === "Suspended" ||
    (s.phase === "Expired" && s.condition !== "publication_deadline")
  )
    return s;
  if (!s.consented || s.phase === "ReadyToSubmit") return s;
  if (Math.floor((yield* Clock.currentTimeMillis) / 1000) < s.nextObservationAt)
    return s;
  const reserved = yield* model
    .send(id, new ReserveObservation({ expectedRevision: s.revision }))
    .pipe(Effect.result);
  if (reserved._tag === "Failure") return (yield* model.get(id))!;
  s = (yield* model.get(id))!;
  const result = yield* observer.observe(s).pipe(
    Effect.catch((e) =>
      Effect.succeed({
        status: "error" as const,
        reason: e.reason,
        detail: e.detail,
      }),
    ),
  );

  let action: ConstructorParameters<typeof ApplyObservation>[0]["action"];
  if (result.status === "unavailable" || result.status === "error")
    action = {
      type: "Unavailable",
      reason: result.reason,
      ...(result.status === "error" && result.detail
        ? { detail: result.detail }
        : {}),
    };
  else if (result.status === "denied")
    action = { type: "Suspend", reason: result.reason };
  else if (result.status === "verified")
    action = {
      type: "Observed",
      includedAt: result.observation.inclusionTime,
      ownershipEpoch: result.observation.ownershipEpoch,
      evidence: result.observation,
      safe: true,
      transferPending: false,
    };
  else if (result.reason === "publication_pending")
    action = {
      type: "Observed",
      includedAt: null,
      ownershipEpoch: s.ownershipEpoch!,
      safe: false,
      transferPending: false,
    };
  else if (result.reason === "transfer_pending")
    action = {
      type: "Observed",
      includedAt: s.firstIncludedAt,
      ownershipEpoch: s.ownershipEpoch!,
      safe: false,
      transferPending: true,
    };
  else if (result.observation)
    action = {
      type: "Observed",
      includedAt: result.observation.inclusionTime,
      ownershipEpoch: result.observation.ownershipEpoch,
      evidence: result.observation,
      safe: false,
      transferPending: false,
    };
  else return s;
  yield* model.send(
    id,
    new ApplyObservation({ expectedRevision: s.revision, action }),
  );
  return (yield* model.get(id))!;
});
export function envelope(s: State) {
  const status = ["Cancelled", "Expired"].includes(s.phase)
    ? s.phase.toLowerCase()
    : s.phase === "Suspended"
      ? "denied"
      : unavailableCodes.includes(s.condition)
        ? "unavailable"
        : actionCodes.includes(s.condition)
          ? "action_required"
          : "waiting";
  return {
    schema: "pirate.namespace-admission/1",
    operationId: s.id,
    revision: s.revision,
    bindingDigest: s.bindingDigest,
    updatedAt: s.updatedAt,
    status,
    phase: s.phase,
    reason: s.condition,
    publicationDeadline: s.publicationDeadline,
    maturityDeadline: s.maturityDeadline,
    consentDeadline: s.consentDeadline,
    retryAt:
      ["AwaitingPublication", "Maturing"].includes(s.phase) && s.consented
        ? s.nextObservationAt
        : null,
    firstIncludedAt: s.firstIncludedAt,
    maturedAt: s.maturedAt,
    detail: s.conditionDetail,
    ...(status === "action_required" ? { responsibleRole: "operator" } : {}),
    binding: s.binding,
    observation: s.lastObservation,
  };
}

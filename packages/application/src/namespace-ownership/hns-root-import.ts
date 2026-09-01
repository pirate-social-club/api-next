import type {
  HnsPollResultCompletionResponseV1,
  HnsRootImportActivationResponseV1,
  HnsRootImportSessionResponseV1,
} from "@pirate/contracts";
import { canonicalJson, validCommunityRouteRoot } from "@pirate/domain";
import { Data, Effect, Option, Schema } from "effect";
import {
  type CommunityCreationServices,
  getCommunityCreationIntent,
} from "../use-cases/community/creation-intents.ts";
import type { NamespaceOwnershipStartResponse } from "./start.ts";

const CanonicalIdentifier = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.trim() === value &&
    new TextEncoder().encode(value).byteLength <= 256 &&
    [...value].every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 0x20 && !(point >= 0x7f && point <= 0x9f);
    })
      ? undefined
      : "Expected a canonical HNS root-import identifier",
  ),
);

const PositiveInteger = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value > 0 ? undefined : "Expected a positive safe integer",
  ),
);

const Sha256Hex = Schema.String.check(
  Schema.makeFilter((value) =>
    /^[0-9a-f]{64}$/u.test(value) ? undefined : "Expected a lowercase SHA-256 digest",
  ),
);

export const StartHnsRootImportInput = Schema.Struct({
  actor_id: CanonicalIdentifier,
  creation_intent_id: CanonicalIdentifier,
  ceremony_intent_id: CanonicalIdentifier,
  expected_revision: PositiveInteger,
  idempotency_key: CanonicalIdentifier,
});
export type StartHnsRootImportInput = Schema.Schema.Type<typeof StartHnsRootImportInput>;

export const GetHnsRootImportInput = Schema.Struct({
  actor_id: CanonicalIdentifier,
  creation_intent_id: CanonicalIdentifier,
  root_import_session_id: CanonicalIdentifier,
});
export type GetHnsRootImportInput = Schema.Schema.Type<typeof GetHnsRootImportInput>;

export const PollHnsRootImportInput = Schema.Struct({
  ...GetHnsRootImportInput.fields,
  expected_revision: PositiveInteger,
  idempotency_key: CanonicalIdentifier,
});
export type PollHnsRootImportInput = Schema.Schema.Type<typeof PollHnsRootImportInput>;

export const ActivateHnsRootImportInput = Schema.Struct({
  ...PollHnsRootImportInput.fields,
  actor_kind: Schema.Literals(["user", "admin"]),
  publish_plan_sha256: Sha256Hex,
  readiness_result_sha256: Sha256Hex,
  acknowledged_complete_resource_replacement: Schema.Literal(true),
});
export type ActivateHnsRootImportInput = Schema.Schema.Type<typeof ActivateHnsRootImportInput>;

export type HnsRootImportOwnershipStartPort = Readonly<{
  readonly start: (
    input: StartHnsRootImportInput,
  ) => Effect.Effect<NamespaceOwnershipStartResponse, unknown>;
}>;

export type HnsRootImportOwnershipCompletionPort = Readonly<{
  readonly complete: (input: {
    readonly actor_id: string;
    readonly creation_intent_id: string;
    readonly ceremony_intent_id: string;
    readonly session_id: string;
    readonly expected_revision: number;
    readonly idempotency_key: string;
    readonly channel: "poll_result";
  }) => Effect.Effect<HnsPollResultCompletionResponseV1, unknown>;
}>;

export type HnsRootImportStartRecord = Readonly<{
  readonly actor_id: string;
  readonly creation_intent_id: string;
  readonly ceremony_intent_id: string;
  readonly namespace_session_id: string;
  readonly root_import_session_id: string;
  readonly ownership_generation: number;
  readonly ownership_expected_revision: number;
  readonly root_label: string;
  readonly challenge_txt_value: string;
  readonly expires_at: string;
  readonly idempotency_key: string;
  readonly request_sha256: string;
  readonly provision_job_id: string;
}>;

export type HnsRootImportStartStoreOutcome =
  | Readonly<{
      readonly kind: "created" | "replay";
      readonly session: HnsRootImportSessionResponseV1;
    }>
  | Readonly<{ readonly kind: "conflict" | "intent_unavailable" }>;

export type HnsRootImportPollAuthority = Readonly<{
  readonly session: HnsRootImportSessionResponseV1;
  readonly ownership_expected_revision: number;
  readonly challenge_txt_value: string;
  readonly provision_job_id: string;
  readonly ownership_result_sha256: string | null;
  readonly provision_result_sha256: string | null;
}>;

export type HnsRootImportProvisionRecord = Readonly<{
  readonly poll: PollHnsRootImportInput;
  readonly poll_request_sha256: string;
  readonly ownership_result_sha256: string;
  readonly provision_job_id: string;
  readonly provision_request_bytes: Uint8Array;
  readonly provision_request_sha256: string;
}>;

export type HnsRootImportProvisionStartOutcome =
  | Readonly<{
      readonly kind: "provisioning" | "replayed";
      readonly session: HnsRootImportSessionResponseV1;
    }>
  | Readonly<{ readonly kind: "conflict" | "not_found" }>;

export type HnsRootImportObservationRecord = Readonly<{
  readonly poll: PollHnsRootImportInput;
  readonly poll_request_sha256: string;
  readonly ownership_result_sha256: string;
  readonly observation_job_id: string;
  readonly observation_request_bytes: Uint8Array;
  readonly observation_request_sha256: string;
}>;

export type HnsRootImportObservationStartOutcome =
  | Readonly<{
      readonly kind: "observing" | "replayed";
      readonly session: HnsRootImportSessionResponseV1;
    }>
  | Readonly<{ readonly kind: "conflict" | "not_found" }>;

export type HnsRootImportOwnershipTerminalOutcome =
  | Readonly<{
      readonly kind: "failed" | "expired" | "replayed";
      readonly session: HnsRootImportSessionResponseV1;
    }>
  | Readonly<{ readonly kind: "conflict" | "not_found" }>;

export type HnsRootImportActivationRecord = Readonly<{
  readonly input: ActivateHnsRootImportInput;
  readonly request_sha256: string;
  readonly community_id: string;
  readonly dns_zone_activation_id: string;
  readonly app_host_activation_id: string;
  readonly sale_namespace_activation_id: string;
  readonly operation_id: string;
}>;

export type HnsRootImportActivationStoreOutcome =
  | Readonly<{
      readonly kind: "activated" | "replayed";
      readonly response: HnsRootImportActivationResponseV1;
    }>
  | Readonly<{ readonly kind: "conflict" | "not_found" }>;

export interface HnsRootImportStore {
  readonly start: (
    input: HnsRootImportStartRecord,
  ) => Effect.Effect<HnsRootImportStartStoreOutcome, HnsRootImportStorageFailed>;
  readonly get: (
    input: GetHnsRootImportInput,
  ) => Effect.Effect<HnsRootImportSessionResponseV1 | null, HnsRootImportStorageFailed>;
  readonly loadPollAuthority: (
    input: GetHnsRootImportInput,
  ) => Effect.Effect<HnsRootImportPollAuthority | null, HnsRootImportStorageFailed>;
  readonly beginProvisioning: (
    input: HnsRootImportProvisionRecord,
  ) => Effect.Effect<HnsRootImportProvisionStartOutcome, HnsRootImportStorageFailed>;
  readonly beginObservation: (
    input: HnsRootImportObservationRecord,
  ) => Effect.Effect<HnsRootImportObservationStartOutcome, HnsRootImportStorageFailed>;
  readonly finishOwnershipTerminal: (input: {
    readonly poll: PollHnsRootImportInput;
    readonly ownership_status: "rejected" | "expired";
    readonly ownership_result_sha256: string;
  }) => Effect.Effect<HnsRootImportOwnershipTerminalOutcome, HnsRootImportStorageFailed>;
  readonly activate: (
    input: HnsRootImportActivationRecord,
  ) => Effect.Effect<HnsRootImportActivationStoreOutcome, HnsRootImportStorageFailed>;
}

export interface HnsRootImportServices {
  readonly ownership: HnsRootImportOwnershipStartPort;
  readonly completion: HnsRootImportOwnershipCompletionPort;
  readonly community: CommunityCreationServices;
  readonly store: HnsRootImportStore;
  readonly ids?: Readonly<{
    readonly session: () => string;
    readonly provisionJob: () => string;
    readonly observationJob?: () => string;
    readonly dnsActivation?: () => string;
    readonly appActivation?: () => string;
    readonly saleActivation?: () => string;
    readonly activationOperation?: () => string;
  }>;
}

export class HnsRootImportRejected extends Data.TaggedError("HnsRootImportRejected")<{
  readonly reason:
    | "invalid"
    | "ownership_unavailable"
    | "ownership_source_unsupported"
    | "conflict"
    | "not_found";
}> {}

export class HnsRootImportStorageFailed extends Data.TaggedError("HnsRootImportStorageFailed") {}

const exactParseOptions = { onExcessProperty: "error" } as const;
const encoder = new TextEncoder();

function decodeStart(
  value: unknown,
): Effect.Effect<StartHnsRootImportInput, HnsRootImportRejected> {
  const decoded = Schema.decodeUnknownOption(StartHnsRootImportInput, exactParseOptions)(value);
  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(new HnsRootImportRejected({ reason: "invalid" }));
}

function decodeGet(value: unknown): Effect.Effect<GetHnsRootImportInput, HnsRootImportRejected> {
  const decoded = Schema.decodeUnknownOption(GetHnsRootImportInput, exactParseOptions)(value);
  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(new HnsRootImportRejected({ reason: "invalid" }));
}

function decodePoll(value: unknown): Effect.Effect<PollHnsRootImportInput, HnsRootImportRejected> {
  const decoded = Schema.decodeUnknownOption(PollHnsRootImportInput, exactParseOptions)(value);
  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(new HnsRootImportRejected({ reason: "invalid" }));
}

function decodeActivate(
  value: unknown,
): Effect.Effect<ActivateHnsRootImportInput, HnsRootImportRejected> {
  const decoded = Schema.decodeUnknownOption(ActivateHnsRootImportInput, exactParseOptions)(value);
  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(new HnsRootImportRejected({ reason: "invalid" }));
}

async function sha256(value: unknown): Promise<string> {
  return sha256Bytes(encoder.encode(canonicalJson(value)));
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function generatedId(
  ids: HnsRootImportServices["ids"],
  kind: "session" | "provisionJob" | "observationJob",
): string {
  const supplied = ids?.[kind]?.();
  if (supplied !== undefined) return supplied;
  if (kind === "session") return `hns-root-import_${crypto.randomUUID()}`;
  return kind === "provisionJob"
    ? `hns-root-provision_${crypto.randomUUID()}`
    : `hns-root-observation_${crypto.randomUUID()}`;
}

function activationId(
  ids: HnsRootImportServices["ids"],
  kind: "dnsActivation" | "appActivation" | "saleActivation" | "activationOperation",
): string {
  const supplied = ids?.[kind]?.();
  if (supplied !== undefined) return supplied;
  const prefix =
    kind === "dnsActivation"
      ? "hns-dns"
      : kind === "appActivation"
        ? "hns-app"
        : kind === "saleActivation"
          ? "hns-sale"
          : "hns-root-activation";
  return `${prefix}_${crypto.randomUUID()}`;
}

function pendingOwnership(
  result: NamespaceOwnershipStartResponse,
): Extract<NamespaceOwnershipStartResponse, { readonly status: "pending" }> | null {
  if (result.status !== "pending") return null;
  if (
    result.challenge.ownership_source !== "hns_parent_chain_txt" ||
    result.challenge.challenge_name !== result.challenge.challenge_name.toLowerCase() ||
    !validCommunityRouteRoot("hns", result.challenge.challenge_name) ||
    !result.challenge.challenge_value.startsWith("pirate-verification=") ||
    result.challenge.challenge_value.length === "pirate-verification=".length
  ) {
    return null;
  }
  return result;
}

/**
 * Starts the existing durable parent-chain ownership ceremony and retains its
 * challenge in an import session. Provisioning is deliberately absent until
 * a later poll completes ownership.
 */
export const startHnsRootImport = Effect.fn("startHnsRootImport")(function* (
  untrustedInput: unknown,
  services: Readonly<{
    readonly ownership: HnsRootImportOwnershipStartPort;
    readonly store: Pick<HnsRootImportStore, "start">;
    readonly ids?: HnsRootImportServices["ids"];
  }>,
): Effect.fn.Return<
  HnsRootImportSessionResponseV1,
  HnsRootImportRejected | HnsRootImportStorageFailed
> {
  const input = yield* decodeStart(untrustedInput);
  const ownership = yield* services.ownership
    .start(input)
    .pipe(Effect.mapError(() => new HnsRootImportRejected({ reason: "ownership_unavailable" })));
  const pending = pendingOwnership(ownership);
  if (pending === null) {
    return yield* new HnsRootImportRejected({ reason: "ownership_source_unsupported" });
  }

  const rootImportSessionId = generatedId(services.ids, "session");
  const provisionJobId = generatedId(services.ids, "provisionJob");
  const requestIdentity = {
    version: "pirate-hns-root-import-start-v1",
    actor_id: input.actor_id,
    creation_intent_id: input.creation_intent_id,
    ceremony_intent_id: input.ceremony_intent_id,
    expected_revision: input.expected_revision,
    idempotency_key: input.idempotency_key,
    namespace_session_id: pending.session_id,
    ownership_generation: pending.generation,
    root_label: pending.challenge.challenge_name,
    challenge_txt_value: pending.challenge.challenge_value,
    expires_at: pending.expires_at,
  } as const;
  const outcome = yield* services.store.start({
    actor_id: input.actor_id,
    creation_intent_id: input.creation_intent_id,
    ceremony_intent_id: input.ceremony_intent_id,
    namespace_session_id: pending.session_id,
    root_import_session_id: rootImportSessionId,
    ownership_generation: pending.generation,
    ownership_expected_revision: input.expected_revision,
    root_label: pending.challenge.challenge_name,
    challenge_txt_value: pending.challenge.challenge_value,
    expires_at: pending.expires_at,
    idempotency_key: input.idempotency_key,
    request_sha256: yield* Effect.promise(() => sha256(requestIdentity)),
    provision_job_id: provisionJobId,
  });
  if (outcome.kind === "created" || outcome.kind === "replay") return outcome.session;
  if (outcome.kind === "intent_unavailable") {
    return yield* new HnsRootImportRejected({ reason: "not_found" });
  }
  return yield* new HnsRootImportRejected({ reason: "conflict" });
});

export const getHnsRootImport = Effect.fn("getHnsRootImport")(function* (
  untrustedInput: unknown,
  services: Readonly<{ readonly store: Pick<HnsRootImportStore, "get"> }>,
): Effect.fn.Return<
  HnsRootImportSessionResponseV1,
  HnsRootImportRejected | HnsRootImportStorageFailed
> {
  const input = yield* decodeGet(untrustedInput);
  const session = yield* services.store.get(input);
  return session === null ? yield* new HnsRootImportRejected({ reason: "not_found" }) : session;
});

export const pollHnsRootImport = Effect.fn("pollHnsRootImport")(function* (
  untrustedInput: unknown,
  services: HnsRootImportServices,
): Effect.fn.Return<
  HnsRootImportSessionResponseV1,
  HnsRootImportRejected | HnsRootImportStorageFailed
> {
  const input = yield* decodePoll(untrustedInput);
  const authority = yield* services.store.loadPollAuthority(input);
  if (authority === null) return yield* new HnsRootImportRejected({ reason: "not_found" });
  const current = authority.session;
  if (current.revision !== input.expected_revision) {
    return yield* new HnsRootImportRejected({ reason: "conflict" });
  }
  const pollIdentity = {
    version: "pirate-hns-root-import-poll-v1",
    actor_id: input.actor_id,
    creation_intent_id: input.creation_intent_id,
    root_import_session_id: input.root_import_session_id,
    expected_revision: input.expected_revision,
    idempotency_key: input.idempotency_key,
  } as const;
  if (current.status === "awaiting_ownership") {
    const ownership = yield* services.completion
      .complete({
        actor_id: input.actor_id,
        creation_intent_id: input.creation_intent_id,
        ceremony_intent_id: current.ceremony_intent_id,
        session_id: current.namespace_session_id,
        expected_revision: authority.ownership_expected_revision,
        idempotency_key: input.idempotency_key,
        channel: "poll_result",
      })
      .pipe(Effect.mapError(() => new HnsRootImportRejected({ reason: "ownership_unavailable" })));
    if (ownership.status === "pending" || ownership.status === "unavailable") return current;
    if (ownership.result_hash === null) {
      return yield* new HnsRootImportRejected({ reason: "ownership_unavailable" });
    }
    if (ownership.status === "rejected" || ownership.status === "expired") {
      const terminal = yield* services.store.finishOwnershipTerminal({
        poll: input,
        ownership_status: ownership.status,
        ownership_result_sha256: ownership.result_hash,
      });
      if (terminal.kind === "not_found") {
        return yield* new HnsRootImportRejected({ reason: "not_found" });
      }
      if (terminal.kind === "conflict") {
        return yield* new HnsRootImportRejected({ reason: "conflict" });
      }
      if ("session" in terminal) return terminal.session;
      return yield* new HnsRootImportRejected({ reason: "conflict" });
    }
    if (ownership.status !== "verified") {
      return yield* new HnsRootImportRejected({ reason: "ownership_unavailable" });
    }
    const provisionIdentity = {
      version: "pirate-hns-authority-provision-request-v1",
      root_import_session_id: current.root_import_session_id,
      namespace_session_id: current.namespace_session_id,
      root_label: current.root_label,
      challenge_txt_value: authority.challenge_txt_value,
      expires_at: current.expires_at,
    } as const;
    const provisionRequestBytes = encoder.encode(canonicalJson(provisionIdentity));
    const provisioning = yield* services.store.beginProvisioning({
      poll: input,
      poll_request_sha256: yield* Effect.promise(() => sha256(pollIdentity)),
      ownership_result_sha256: ownership.result_hash,
      provision_job_id: authority.provision_job_id,
      provision_request_bytes: provisionRequestBytes,
      provision_request_sha256: yield* Effect.promise(() => sha256Bytes(provisionRequestBytes)),
    });
    if (provisioning.kind === "not_found") {
      return yield* new HnsRootImportRejected({ reason: "not_found" });
    }
    if (provisioning.kind === "conflict") {
      return yield* new HnsRootImportRejected({ reason: "conflict" });
    }
    if ("session" in provisioning) return provisioning.session;
    return yield* new HnsRootImportRejected({ reason: "conflict" });
  }
  if (current.status !== "awaiting_owner_update") {
    return { ...current, replayed: true };
  }
  if (authority.ownership_result_sha256 === null || authority.provision_result_sha256 === null) {
    return yield* new HnsRootImportRejected({ reason: "conflict" });
  }
  const observationJobId = generatedId(services.ids, "observationJob");
  const observationIdentity = {
    version: "pirate-hns-root-readiness-observation-request-v1",
    root_import_session_id: current.root_import_session_id,
    namespace_session_id: current.namespace_session_id,
    root_label: current.root_label,
    challenge_txt_value: authority.challenge_txt_value,
    ownership_result_sha256: authority.ownership_result_sha256,
    publish_plan_sha256: current.publish_plan_sha256,
    provision_result_sha256: authority.provision_result_sha256,
    expires_at: current.expires_at,
  } as const;
  if (observationIdentity.publish_plan_sha256 === null) {
    return yield* new HnsRootImportRejected({ reason: "conflict" });
  }
  const observationBytes = encoder.encode(canonicalJson(observationIdentity));
  const outcome = yield* services.store.beginObservation({
    poll: input,
    poll_request_sha256: yield* Effect.promise(() => sha256(pollIdentity)),
    ownership_result_sha256: authority.ownership_result_sha256,
    observation_job_id: observationJobId,
    observation_request_bytes: observationBytes,
    observation_request_sha256: yield* Effect.promise(() => sha256Bytes(observationBytes)),
  });
  if (outcome.kind === "not_found") {
    return yield* new HnsRootImportRejected({ reason: "not_found" });
  }
  if (outcome.kind === "conflict") {
    return yield* new HnsRootImportRejected({ reason: "conflict" });
  }
  if ("session" in outcome) return outcome.session;
  return yield* new HnsRootImportRejected({ reason: "conflict" });
});

export const activateHnsRootImport = Effect.fn("activateHnsRootImport")(function* (
  untrustedInput: unknown,
  services: HnsRootImportServices,
): Effect.fn.Return<
  HnsRootImportActivationResponseV1,
  HnsRootImportRejected | HnsRootImportStorageFailed
> {
  const input = yield* decodeActivate(untrustedInput);
  const authority = yield* services.store.loadPollAuthority(input);
  if (authority === null) return yield* new HnsRootImportRejected({ reason: "not_found" });
  const session = authority.session;
  const isFreshActivation =
    session.status === "ready" && session.revision === input.expected_revision;
  const isActivationReplay =
    session.status === "activated" && session.revision === input.expected_revision + 1;
  if (
    (!isFreshActivation && !isActivationReplay) ||
    session.publish_plan_sha256 !== input.publish_plan_sha256 ||
    session.readiness_result_sha256 !== input.readiness_result_sha256
  ) {
    return yield* new HnsRootImportRejected({ reason: "conflict" });
  }
  const actor = { userId: input.actor_id, kind: input.actor_kind } as const;
  const current = yield* getCommunityCreationIntent(
    { actor, intentId: input.creation_intent_id },
    services.community,
  ).pipe(Effect.mapError(() => new HnsRootImportRejected({ reason: "conflict" })));
  if (current.status !== "committed" || current.committed_resource === null) {
    return yield* new HnsRootImportRejected({ reason: "conflict" });
  }
  const communityId = current.committed_resource.community_id;
  const requestIdentity = {
    version: "pirate-hns-root-import-activation-v1",
    actor_id: input.actor_id,
    actor_kind: input.actor_kind,
    creation_intent_id: input.creation_intent_id,
    root_import_session_id: input.root_import_session_id,
    expected_revision: input.expected_revision,
    idempotency_key: input.idempotency_key,
    publish_plan_sha256: input.publish_plan_sha256,
    readiness_result_sha256: input.readiness_result_sha256,
    acknowledged_complete_resource_replacement: input.acknowledged_complete_resource_replacement,
  } as const;
  const outcome = yield* services.store.activate({
    input,
    request_sha256: yield* Effect.promise(() => sha256(requestIdentity)),
    community_id: communityId,
    dns_zone_activation_id: activationId(services.ids, "dnsActivation"),
    app_host_activation_id: activationId(services.ids, "appActivation"),
    sale_namespace_activation_id: activationId(services.ids, "saleActivation"),
    operation_id: activationId(services.ids, "activationOperation"),
  });
  if (outcome.kind === "not_found") {
    return yield* new HnsRootImportRejected({ reason: "not_found" });
  }
  if (outcome.kind === "conflict") {
    return yield* new HnsRootImportRejected({ reason: "conflict" });
  }
  if (outcome.kind === "activated" || outcome.kind === "replayed") return outcome.response;
  return yield* new HnsRootImportRejected({ reason: "conflict" });
});

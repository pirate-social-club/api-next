import type {
  HnsCommunityRootImportSessionResponseV1,
  HnsPollResultCompletionResponseV1,
} from "@pirate/contracts";
import { canonicalJson, validCommunityRouteRoot } from "@pirate/domain";
import { Data, Effect, Option, Schema } from "effect";
import {
  decodeHnsRootImportNameProofResultV1,
  HnsRootImportNameSignature,
} from "./hns-root-import-name-proof.ts";
import type {
  RouteAttachmentOwnershipStartResponse,
  StartRouteAttachmentOwnershipInput,
} from "./route-attachment-start.ts";

const CanonicalIdentifier = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.trim() === value &&
    new TextEncoder().encode(value).byteLength <= 256 &&
    [...value].every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 0x20 && !(point >= 0x7f && point <= 0x9f);
    })
      ? undefined
      : "Expected a canonical community root-import identifier",
  ),
);

const RootLabel = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    validCommunityRouteRoot("hns", value) ? undefined : "Expected a canonical HNS root label",
  ),
);

export const StartHnsCommunityRootImportInput = Schema.Struct({
  actor_id: CanonicalIdentifier,
  community_id: CanonicalIdentifier,
  root_label: RootLabel,
  idempotency_key: CanonicalIdentifier,
});
export type StartHnsCommunityRootImportInput = Schema.Schema.Type<
  typeof StartHnsCommunityRootImportInput
>;

export const GetHnsCommunityRootImportInput = Schema.Struct({
  actor_id: CanonicalIdentifier,
  community_id: CanonicalIdentifier,
  root_import_session_id: CanonicalIdentifier,
});
export type GetHnsCommunityRootImportInput = Schema.Schema.Type<
  typeof GetHnsCommunityRootImportInput
>;

export const PollHnsCommunityRootImportInput = Schema.Struct({
  ...GetHnsCommunityRootImportInput.fields,
  expected_revision: Schema.Int.check(
    Schema.makeFilter((value) =>
      Number.isSafeInteger(value) && value > 0 ? undefined : "Expected a positive revision",
    ),
  ),
  idempotency_key: CanonicalIdentifier,
  provisioning_name_signature: Schema.optional(HnsRootImportNameSignature),
});
export type PollHnsCommunityRootImportInput = Schema.Schema.Type<
  typeof PollHnsCommunityRootImportInput
>;

export type HnsCommunityRootImportPreparation = Readonly<{
  readonly actor_id: string;
  readonly community_id: string;
  readonly attachment_intent_id: string;
  readonly ceremony_intent_id: string;
  readonly root_label: string;
  readonly attachment_revision: number;
  readonly root_import_session_id: string;
  readonly provision_job_id: string;
}>;

export type HnsCommunityRootImportPrepareOutcome =
  | Readonly<{
      readonly kind: "created" | "replay";
      readonly value: HnsCommunityRootImportPreparation;
    }>
  | Readonly<{ readonly kind: "conflict" }>
  | Readonly<{ readonly kind: "not_found" }>;

export type HnsCommunityRootImportStartRecord = Readonly<{
  readonly preparation: HnsCommunityRootImportPreparation;
  readonly ownership: Extract<
    RouteAttachmentOwnershipStartResponse,
    { readonly status: "pending" }
  >;
  readonly idempotency_key: string;
  readonly request_sha256: string;
}>;

export type HnsCommunityRootImportStartOutcome =
  | Readonly<{
      readonly kind: "created" | "replay";
      readonly session: HnsCommunityRootImportSessionResponseV1;
    }>
  | Readonly<{ readonly kind: "conflict" }>
  | Readonly<{ readonly kind: "not_found" }>;

export interface HnsCommunityRootImportStartStore {
  readonly prepare: (input: {
    readonly request: StartHnsCommunityRootImportInput;
    readonly attachment_intent_id: string;
    readonly ceremony_intent_id: string;
    readonly root_import_session_id: string;
    readonly provision_job_id: string;
    readonly request_sha256: string;
  }) => Effect.Effect<HnsCommunityRootImportPrepareOutcome, HnsCommunityRootImportStorageFailed>;
  readonly start: (
    input: HnsCommunityRootImportStartRecord,
  ) => Effect.Effect<HnsCommunityRootImportStartOutcome, HnsCommunityRootImportStorageFailed>;
}

export interface HnsCommunityRootImportReadStore {
  readonly get: (
    input: GetHnsCommunityRootImportInput,
  ) => Effect.Effect<
    HnsCommunityRootImportSessionResponseV1 | null,
    HnsCommunityRootImportStorageFailed
  >;
}

export type HnsCommunityRootImportPollAuthority = Readonly<{
  readonly session: HnsCommunityRootImportSessionResponseV1;
  readonly ceremony_intent_id: string;
  readonly namespace_session_id: string;
  readonly ownership_expected_revision: number;
  readonly challenge_txt_value: string;
  readonly provision_job_id: string;
  readonly ownership_result_sha256: string | null;
  readonly provision_result_sha256: string | null;
}>;

export type HnsCommunityRootImportProvisionRecord = Readonly<{
  readonly poll: PollHnsCommunityRootImportInput;
  readonly poll_request_sha256: string;
  readonly proof_result_bytes: Uint8Array;
  readonly proof_result_sha256: string;
  readonly proof_message_sha256: string;
  readonly proof_signature_sha256: string;
  readonly provision_job_id: string;
  readonly provision_request_bytes: Uint8Array;
  readonly provision_request_sha256: string;
}>;

export type HnsCommunityRootImportObservationRecord = Readonly<{
  readonly poll: PollHnsCommunityRootImportInput;
  readonly poll_request_sha256: string;
  readonly ownership_result_sha256: string;
  readonly observation_job_id: string;
  readonly observation_request_bytes: Uint8Array;
  readonly observation_request_sha256: string;
}>;

type CommunityPollStoreOutcome =
  | Readonly<{
      readonly kind: "provisioning" | "observing" | "replayed";
      readonly session: HnsCommunityRootImportSessionResponseV1;
    }>
  | Readonly<{ readonly kind: "conflict" | "not_found" }>;

export interface HnsCommunityRootImportPollStore extends HnsCommunityRootImportReadStore {
  readonly loadPollAuthority: (
    input: GetHnsCommunityRootImportInput,
  ) => Effect.Effect<
    HnsCommunityRootImportPollAuthority | null,
    HnsCommunityRootImportStorageFailed
  >;
  readonly beginProvisioning: (
    input: HnsCommunityRootImportProvisionRecord,
  ) => Effect.Effect<CommunityPollStoreOutcome, HnsCommunityRootImportStorageFailed>;
  readonly beginObservation: (
    input: HnsCommunityRootImportObservationRecord,
  ) => Effect.Effect<CommunityPollStoreOutcome, HnsCommunityRootImportStorageFailed>;
}

export interface HnsCommunityRootImportPollServices {
  readonly nameProof: Readonly<{
    readonly verify: (input: {
      readonly root_import_session_id: string;
      readonly root_label: string;
      readonly message: string;
      readonly signature: string;
    }) => Effect.Effect<
      Readonly<{ readonly result_bytes: Uint8Array; readonly result_sha256: string }>,
      unknown
    >;
  }>;
  readonly completion: Readonly<{
    readonly complete: (input: {
      readonly actor_id: string;
      readonly community_id: string;
      readonly attachment_intent_id: string;
      readonly ceremony_intent_id: string;
      readonly session_id: string;
      readonly expected_revision: number;
      readonly idempotency_key: string;
      readonly channel: "poll_result";
    }) => Effect.Effect<HnsPollResultCompletionResponseV1, unknown>;
  }>;
  readonly store: HnsCommunityRootImportPollStore;
  readonly ids?: Readonly<{ readonly observationJob?: () => string }>;
}

export interface HnsCommunityRootImportStartServices {
  readonly ownership: Readonly<{
    readonly start: (
      input: StartRouteAttachmentOwnershipInput,
    ) => Effect.Effect<RouteAttachmentOwnershipStartResponse, unknown>;
  }>;
  readonly store: HnsCommunityRootImportStartStore;
  readonly ids?: Readonly<{
    readonly attachmentIntent?: () => string;
    readonly ceremonyIntent?: () => string;
    readonly rootImportSession?: () => string;
    readonly provisionJob?: () => string;
  }>;
}

export class HnsCommunityRootImportRejected extends Data.TaggedError(
  "HnsCommunityRootImportRejected",
)<{
  readonly reason: "invalid" | "conflict" | "not_found" | "ownership_unavailable";
}> {}

export class HnsCommunityRootImportStorageFailed extends Data.TaggedError(
  "HnsCommunityRootImportStorageFailed",
) {}

const encoder = new TextEncoder();
const exactParseOptions = { onExcessProperty: "error" } as const;

async function sha256(value: unknown): Promise<string> {
  const bytes = encoder.encode(canonicalJson(value));
  return sha256Bytes(bytes);
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function generatedId(
  ids: HnsCommunityRootImportStartServices["ids"],
  kind: "attachmentIntent" | "ceremonyIntent" | "rootImportSession" | "provisionJob",
): string {
  const supplied = ids?.[kind]?.();
  if (supplied !== undefined) return supplied;
  const prefix =
    kind === "attachmentIntent"
      ? "route-attachment"
      : kind === "ceremonyIntent"
        ? "route-ceremony"
        : kind === "rootImportSession"
          ? "hns-root-import"
          : "hns-root-provision";
  return `${prefix}_${crypto.randomUUID()}`;
}

export const startHnsCommunityRootImport = Effect.fn("startHnsCommunityRootImport")(function* (
  untrustedInput: unknown,
  services: HnsCommunityRootImportStartServices,
): Effect.fn.Return<
  HnsCommunityRootImportSessionResponseV1,
  HnsCommunityRootImportRejected | HnsCommunityRootImportStorageFailed
> {
  const decoded = Schema.decodeUnknownOption(
    StartHnsCommunityRootImportInput,
    exactParseOptions,
  )(untrustedInput);
  if (Option.isNone(decoded)) {
    return yield* new HnsCommunityRootImportRejected({ reason: "invalid" });
  }
  const input = decoded.value;
  const requestIdentity = {
    version: "pirate-hns-community-root-import-start-v1",
    ...input,
  } as const;
  const requestSha256 = yield* Effect.promise(() => sha256(requestIdentity));
  const prepared = yield* services.store.prepare({
    request: input,
    attachment_intent_id: generatedId(services.ids, "attachmentIntent"),
    ceremony_intent_id: generatedId(services.ids, "ceremonyIntent"),
    root_import_session_id: generatedId(services.ids, "rootImportSession"),
    provision_job_id: generatedId(services.ids, "provisionJob"),
    request_sha256: requestSha256,
  });
  if (prepared.kind === "not_found") {
    return yield* new HnsCommunityRootImportRejected({ reason: "not_found" });
  }
  if (prepared.kind === "conflict") {
    return yield* new HnsCommunityRootImportRejected({ reason: "conflict" });
  }
  const authority = prepared.value;
  const ownership = yield* services.ownership
    .start({
      actor_id: authority.actor_id,
      community_id: authority.community_id,
      attachment_intent_id: authority.attachment_intent_id,
      ceremony_intent_id: authority.ceremony_intent_id,
      expected_revision: authority.attachment_revision,
      idempotency_key: requestSha256,
    })
    .pipe(
      Effect.mapError(
        () => new HnsCommunityRootImportRejected({ reason: "ownership_unavailable" }),
      ),
    );
  if (
    ownership.status !== "pending" ||
    ownership.community_id !== authority.community_id ||
    ownership.attachment_intent_id !== authority.attachment_intent_id ||
    ownership.ceremony_intent_id !== authority.ceremony_intent_id ||
    ownership.challenge.ownership_source !== "hns_parent_chain_txt" ||
    ownership.challenge.challenge_name !== authority.root_label
  ) {
    return yield* new HnsCommunityRootImportRejected({ reason: "ownership_unavailable" });
  }
  const outcome = yield* services.store.start({
    preparation: authority,
    ownership,
    idempotency_key: input.idempotency_key,
    request_sha256: requestSha256,
  });
  if (outcome.kind === "not_found") {
    return yield* new HnsCommunityRootImportRejected({ reason: "not_found" });
  }
  if (outcome.kind === "conflict") {
    return yield* new HnsCommunityRootImportRejected({ reason: "conflict" });
  }
  return outcome.session;
});

export const getHnsCommunityRootImport = Effect.fn("getHnsCommunityRootImport")(function* (
  untrustedInput: unknown,
  services: Readonly<{ readonly store: HnsCommunityRootImportReadStore }>,
): Effect.fn.Return<
  HnsCommunityRootImportSessionResponseV1,
  HnsCommunityRootImportRejected | HnsCommunityRootImportStorageFailed
> {
  const decoded = Schema.decodeUnknownOption(
    GetHnsCommunityRootImportInput,
    exactParseOptions,
  )(untrustedInput);
  if (Option.isNone(decoded)) {
    return yield* new HnsCommunityRootImportRejected({ reason: "invalid" });
  }
  const session = yield* services.store.get(decoded.value);
  return session === null
    ? yield* new HnsCommunityRootImportRejected({ reason: "not_found" })
    : session;
});

function pollFailure(reason: "invalid" | "conflict" | "not_found" | "ownership_unavailable") {
  return new HnsCommunityRootImportRejected({ reason });
}

export const pollHnsCommunityRootImport = Effect.fn("pollHnsCommunityRootImport")(function* (
  untrustedInput: unknown,
  services: HnsCommunityRootImportPollServices,
): Effect.fn.Return<
  HnsCommunityRootImportSessionResponseV1,
  HnsCommunityRootImportRejected | HnsCommunityRootImportStorageFailed
> {
  const decoded = Schema.decodeUnknownOption(
    PollHnsCommunityRootImportInput,
    exactParseOptions,
  )(untrustedInput);
  if (Option.isNone(decoded)) return yield* pollFailure("invalid");
  const input = decoded.value;
  const authority = yield* services.store.loadPollAuthority(input);
  if (authority === null) return yield* pollFailure("not_found");
  const current = authority.session;
  if (current.revision !== input.expected_revision) return yield* pollFailure("conflict");
  if (input.provisioning_name_signature !== undefined && current.status !== "awaiting_ownership") {
    return yield* pollFailure("invalid");
  }
  const signature = input.provisioning_name_signature ?? null;
  const signatureSha256 =
    signature === null ? null : yield* Effect.promise(() => sha256Bytes(encoder.encode(signature)));
  const pollIdentity = {
    version: "pirate-hns-community-root-import-poll-v1",
    actor_id: input.actor_id,
    community_id: input.community_id,
    root_import_session_id: input.root_import_session_id,
    expected_revision: input.expected_revision,
    idempotency_key: input.idempotency_key,
    provisioning_name_signature_sha256: signatureSha256,
  } as const;

  if (current.status === "awaiting_ownership") {
    if (signature === null || signatureSha256 === null) return yield* pollFailure("invalid");
    const message = current.provisioning_authorization.message;
    const messageSha256 = yield* Effect.promise(() => sha256Bytes(encoder.encode(message)));
    const verified = yield* services.nameProof
      .verify({
        root_import_session_id: current.root_import_session_id,
        root_label: current.root_label,
        message,
        signature,
      })
      .pipe(Effect.mapError(() => pollFailure("ownership_unavailable")));
    const proof = yield* Effect.tryPromise({
      try: async () => {
        const result = decodeHnsRootImportNameProofResultV1(verified.result_bytes);
        const resultSha256 = await sha256Bytes(verified.result_bytes);
        if (
          resultSha256 !== verified.result_sha256 ||
          result.root_label !== current.root_label ||
          result.message_sha256 !== messageSha256 ||
          result.signature_sha256 !== signatureSha256 ||
          result.safe !== true ||
          result.verified !== true
        ) {
          throw new TypeError("HNS name proof does not match the community import");
        }
        return { resultSha256 };
      },
      catch: () => pollFailure("ownership_unavailable"),
    });
    const provisionIdentity = {
      version: "pirate-hns-authority-provision-request-v1",
      root_import_session_id: current.root_import_session_id,
      namespace_session_id: authority.namespace_session_id,
      root_label: current.root_label,
      challenge_txt_value: authority.challenge_txt_value,
      expires_at: current.expires_at,
    } as const;
    const provisionRequestBytes = encoder.encode(canonicalJson(provisionIdentity));
    const outcome = yield* services.store.beginProvisioning({
      poll: input,
      poll_request_sha256: yield* Effect.promise(() => sha256(pollIdentity)),
      proof_result_bytes: new Uint8Array(verified.result_bytes),
      proof_result_sha256: proof.resultSha256,
      proof_message_sha256: messageSha256,
      proof_signature_sha256: signatureSha256,
      provision_job_id: authority.provision_job_id,
      provision_request_bytes: provisionRequestBytes,
      provision_request_sha256: yield* Effect.promise(() => sha256Bytes(provisionRequestBytes)),
    });
    if (outcome.kind === "not_found") return yield* pollFailure("not_found");
    if (outcome.kind === "conflict") return yield* pollFailure("conflict");
    return "session" in outcome ? outcome.session : yield* pollFailure("conflict");
  }

  if (current.status !== "awaiting_owner_update") return { ...current, replayed: true };
  const ownership = yield* services.completion
    .complete({
      actor_id: input.actor_id,
      community_id: input.community_id,
      attachment_intent_id: current.attachment_intent_id,
      ceremony_intent_id: authority.ceremony_intent_id,
      session_id: authority.namespace_session_id,
      expected_revision: authority.ownership_expected_revision,
      idempotency_key: input.idempotency_key,
      channel: "poll_result",
    })
    .pipe(Effect.mapError(() => pollFailure("ownership_unavailable")));
  if (ownership.status === "pending" || ownership.status === "unavailable") return current;
  if (ownership.status !== "verified" || ownership.result_hash === null) {
    return yield* pollFailure(
      ownership.status === "rejected" || ownership.status === "expired"
        ? "conflict"
        : "ownership_unavailable",
    );
  }
  if (authority.provision_result_sha256 === null || current.publish_plan_sha256 === null) {
    return yield* pollFailure("conflict");
  }
  const observationJobId =
    services.ids?.observationJob?.() ?? `hns-root-observation_${crypto.randomUUID()}`;
  const observationIdentity = {
    version: "pirate-hns-root-readiness-observation-request-v1",
    root_import_session_id: current.root_import_session_id,
    namespace_session_id: authority.namespace_session_id,
    root_label: current.root_label,
    challenge_txt_value: authority.challenge_txt_value,
    ownership_result_sha256: ownership.result_hash,
    publish_plan_sha256: current.publish_plan_sha256,
    provision_result_sha256: authority.provision_result_sha256,
    expires_at: current.expires_at,
  } as const;
  const observationBytes = encoder.encode(canonicalJson(observationIdentity));
  const outcome = yield* services.store.beginObservation({
    poll: input,
    poll_request_sha256: yield* Effect.promise(() => sha256(pollIdentity)),
    ownership_result_sha256: ownership.result_hash,
    observation_job_id: observationJobId,
    observation_request_bytes: observationBytes,
    observation_request_sha256: yield* Effect.promise(() => sha256Bytes(observationBytes)),
  });
  if (outcome.kind === "not_found") return yield* pollFailure("not_found");
  if (outcome.kind === "conflict") return yield* pollFailure("conflict");
  return "session" in outcome ? outcome.session : yield* pollFailure("conflict");
});

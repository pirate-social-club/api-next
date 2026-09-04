import type { HnsCommunityRootImportSessionResponseV1 } from "@pirate/contracts";
import { canonicalJson, validCommunityRouteRoot } from "@pirate/domain";
import { Data, Effect, Option, Schema } from "effect";
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
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
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

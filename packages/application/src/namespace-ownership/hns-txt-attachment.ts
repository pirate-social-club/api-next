import type { HnsTxtAttachmentCurrentResponseV1, HnsTxtAttachmentV1 } from "@pirate/contracts";
import { Effect, Option, Schema } from "effect";
import {
  GetCurrentHnsCommunityRootImportInput,
  type HnsCommunityRootImportPollServices,
  HnsCommunityRootImportRejected,
  type HnsCommunityRootImportStartServices,
  type HnsCommunityRootImportStorageFailed,
  ownershipFailure,
  ownershipStartKey,
  StartHnsCommunityRootImportInput,
} from "./hns-community-root-import.ts";
import { hnsOwnerChallengeValue } from "./hns-evidence.ts";

/*
 * TXT-only attachment. The owner publishes one TXT challenge at the bare root,
 * the verifier's hns-txt-v1 check sees it on chain, and the community's
 * canonical route is committed directly. It reuses the community import's
 * preparation (admission, quota and the attachment intent) and the ordinary
 * route-attachment ceremony, but never creates a root-import session, so no
 * zone is provisioned and no readiness or activation step runs.
 *
 * Reorg policy: the verifier reads the tip view and requires at least one
 * confirmation. A committed route keeps a bounded evidence lease; the daily
 * read-only recheck of the same TXT value retires a route whose TXT has left
 * the chain, which bounds a reorged first observation to one recheck interval.
 */

const CanonicalIdentifier = GetCurrentHnsCommunityRootImportInput.fields.actor_id;

export const CheckHnsTxtAttachmentInput = Schema.Struct({
  actor_id: CanonicalIdentifier,
  community_id: CanonicalIdentifier,
  attachment_intent_id: CanonicalIdentifier,
  idempotency_key: CanonicalIdentifier,
});
export type CheckHnsTxtAttachmentInput = Schema.Schema.Type<typeof CheckHnsTxtAttachmentInput>;

export type HnsTxtAttachmentState = Readonly<{
  readonly attachment_intent_id: string;
  readonly root_label: string;
  readonly intent_status:
    | "verification_required"
    | "commit_ready"
    | "committed"
    | "failed"
    | "expired";
  readonly intent_expires_at: string;
  readonly ownership: Readonly<{
    readonly namespace_session_id: string;
    readonly ceremony_intent_id: string;
    readonly expected_revision: number;
    readonly status: "pending" | "completed" | "failed" | "expired";
    readonly upstream_session_ref: string;
    readonly expires_at: string;
  }> | null;
  /** The public route while it is effective; null otherwise. */
  readonly route_href: string | null;
}>;

export type HnsTxtAttachmentCommitOutcome = Readonly<{
  readonly kind: "committed" | "replayed" | "conflict" | "ownership_conflict" | "not_found";
}>;

export interface HnsTxtAttachmentStore {
  /**
   * The TXT-only attachment the actor may manage in this community: the one
   * named, or the most recent when `attachment_intent_id` is null. Returns
   * `unauthorized` when the actor holds no route authority there.
   */
  readonly load: (input: {
    readonly actor_id: string;
    readonly community_id: string;
    readonly attachment_intent_id: string | null;
  }) => Effect.Effect<
    | Readonly<{ readonly kind: "unauthorized" }>
    | Readonly<{
        readonly kind: "authorized";
        readonly state: HnsTxtAttachmentState | null;
      }>,
    HnsCommunityRootImportStorageFailed
  >;
  /**
   * Commits the verified attachment as the community's canonical route in one
   * transaction, rechecking route authority, the unrouted community and the
   * root's availability under the intent's lock.
   */
  readonly commit: (input: {
    readonly actor_id: string;
    readonly community_id: string;
    readonly attachment_intent_id: string;
    readonly route_binding_id: string;
  }) => Effect.Effect<HnsTxtAttachmentCommitOutcome, HnsCommunityRootImportStorageFailed>;
}

export type HnsTxtAttachmentStartServices = Readonly<{
  readonly ownership: HnsCommunityRootImportStartServices["ownership"];
  readonly store: Pick<HnsCommunityRootImportStartServices["store"], "prepare"> &
    HnsTxtAttachmentStore;
  readonly ids?: HnsCommunityRootImportStartServices["ids"];
}>;

export type HnsTxtAttachmentCheckServices = Readonly<{
  readonly completion: HnsCommunityRootImportPollServices["completion"];
  readonly store: HnsTxtAttachmentStore;
  readonly ids?: Readonly<{ readonly routeBinding?: () => string }>;
}>;

const exactParseOptions = { onExcessProperty: "error" } as const;
const encoder = new TextEncoder();

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rejected(
  reason: "invalid" | "conflict" | "not_found" | "ownership_conflict" | "ownership_unavailable",
) {
  return new HnsCommunityRootImportRejected({ reason });
}

export function hnsTxtAttachmentResponse(
  state: HnsTxtAttachmentState,
  nowEpochMs: number,
  retryAfterSeconds: number | null = null,
): HnsTxtAttachmentV1 {
  const ownership = state.ownership;
  const expiresAt = ownership?.expires_at ?? state.intent_expires_at;
  const lapsed =
    Date.parse(state.intent_expires_at) <= nowEpochMs ||
    (ownership !== null && ownership.status === "pending" && Date.parse(expiresAt) <= nowEpochMs);
  const status: HnsTxtAttachmentV1["status"] =
    state.intent_status === "committed"
      ? "attached"
      : state.intent_status === "failed" || ownership?.status === "failed"
        ? "rejected"
        : state.intent_status === "expired" || ownership?.status === "expired" || lapsed
          ? "expired"
          : "awaiting_txt";
  return {
    attachment_intent_id: state.attachment_intent_id,
    root_label: state.root_label,
    status,
    challenge:
      status === "awaiting_txt" && ownership !== null && ownership.status === "pending"
        ? { name: state.root_label, value: hnsOwnerChallengeValue(ownership.upstream_session_ref) }
        : null,
    expires_at: expiresAt,
    route_href: status === "attached" ? state.route_href : null,
    retry_after_seconds: status === "awaiting_txt" ? retryAfterSeconds : null,
  };
}

function loadNamed(
  store: HnsTxtAttachmentStore,
  input: { readonly actor_id: string; readonly community_id: string },
  attachmentIntentId: string,
) {
  return Effect.gen(function* () {
    const loaded = yield* store.load({ ...input, attachment_intent_id: attachmentIntentId });
    if (loaded.kind === "unauthorized" || loaded.state === null) {
      return yield* rejected("not_found");
    }
    return loaded.state;
  });
}

export const startHnsTxtAttachment = Effect.fn("startHnsTxtAttachment")(function* (
  untrustedInput: unknown,
  services: HnsTxtAttachmentStartServices,
): Effect.fn.Return<
  HnsTxtAttachmentV1,
  HnsCommunityRootImportRejected | HnsCommunityRootImportStorageFailed
> {
  const decoded = Schema.decodeUnknownOption(
    StartHnsCommunityRootImportInput,
    exactParseOptions,
  )(untrustedInput);
  if (Option.isNone(decoded)) return yield* rejected("invalid");
  const input = decoded.value;
  const requestSha256 = yield* Effect.promise(() =>
    sha256({ version: "pirate-hns-txt-attachment-start-v1", ...input }),
  );
  const id = (kind: "attachmentIntent" | "ceremonyIntent" | "rootImportSession" | "provisionJob") =>
    services.ids?.[kind]?.() ??
    `${
      kind === "attachmentIntent"
        ? "route-attachment"
        : kind === "ceremonyIntent"
          ? "route-ceremony"
          : kind === "rootImportSession"
            ? "hns-root-import"
            : "hns-root-provision"
    }_${crypto.randomUUID()}`;
  // The session and provision identities are reserved by the preparation row
  // but never used: a TXT-only attachment creates no root-import session.
  const prepared = yield* services.store.prepare({
    request: input,
    attachment_intent_id: id("attachmentIntent"),
    ceremony_intent_id: id("ceremonyIntent"),
    root_import_session_id: id("rootImportSession"),
    provision_job_id: id("provisionJob"),
    request_sha256: requestSha256,
  });
  if (prepared.kind === "rate_limited") {
    return yield* new HnsCommunityRootImportRejected({
      reason: "rate_limited",
      retry_after_seconds: prepared.retry_after_seconds,
    });
  }
  if (prepared.kind === "preparation_expired") {
    return yield* new HnsCommunityRootImportRejected({ reason: "preparation_expired" });
  }
  if (prepared.kind !== "created" && prepared.kind !== "replay") {
    return yield* rejected(prepared.kind);
  }
  const authority = prepared.value;
  const ownership = yield* services.ownership
    .start({
      actor_id: authority.actor_id,
      community_id: authority.community_id,
      attachment_intent_id: authority.attachment_intent_id,
      ceremony_intent_id: authority.ceremony_intent_id,
      expected_revision: authority.attachment_revision,
      idempotency_key: ownershipStartKey(authority),
    })
    .pipe(Effect.mapError(ownershipFailure));
  if (
    ownership.status === "pending" &&
    (ownership.challenge.ownership_source !== "hns_parent_chain_txt" ||
      ownership.challenge.challenge_name !== authority.root_label)
  ) {
    return yield* new HnsCommunityRootImportRejected({ reason: "ownership_misconfigured" });
  }
  const state = yield* loadNamed(services.store, input, authority.attachment_intent_id);
  return hnsTxtAttachmentResponse(state, Date.now());
});

export const getCurrentHnsTxtAttachment = Effect.fn("getCurrentHnsTxtAttachment")(function* (
  untrustedInput: unknown,
  services: Readonly<{ readonly store: HnsTxtAttachmentStore }>,
): Effect.fn.Return<
  HnsTxtAttachmentCurrentResponseV1,
  HnsCommunityRootImportRejected | HnsCommunityRootImportStorageFailed
> {
  const decoded = Schema.decodeUnknownOption(
    GetCurrentHnsCommunityRootImportInput,
    exactParseOptions,
  )(untrustedInput);
  if (Option.isNone(decoded)) return yield* rejected("invalid");
  const loaded = yield* services.store.load({ ...decoded.value, attachment_intent_id: null });
  if (loaded.kind === "unauthorized") return yield* rejected("not_found");
  return {
    community_id: decoded.value.community_id,
    attachment: loaded.state === null ? null : hnsTxtAttachmentResponse(loaded.state, Date.now()),
  };
});

export const checkHnsTxtAttachment = Effect.fn("checkHnsTxtAttachment")(function* (
  untrustedInput: unknown,
  services: HnsTxtAttachmentCheckServices,
): Effect.fn.Return<
  HnsTxtAttachmentV1,
  HnsCommunityRootImportRejected | HnsCommunityRootImportStorageFailed
> {
  const decoded = Schema.decodeUnknownOption(
    CheckHnsTxtAttachmentInput,
    exactParseOptions,
  )(untrustedInput);
  if (Option.isNone(decoded)) return yield* rejected("invalid");
  const input = decoded.value;
  let state = yield* loadNamed(services.store, input, input.attachment_intent_id);
  let retryAfterSeconds: number | null = null;
  const ownership = state.ownership;
  if (
    state.intent_status === "verification_required" &&
    ownership !== null &&
    ownership.status === "pending"
  ) {
    const result = yield* services.completion
      .complete({
        actor_id: input.actor_id,
        community_id: input.community_id,
        attachment_intent_id: state.attachment_intent_id,
        ceremony_intent_id: ownership.ceremony_intent_id,
        session_id: ownership.namespace_session_id,
        expected_revision: ownership.expected_revision,
        idempotency_key: input.idempotency_key,
        channel: "poll_result",
      })
      .pipe(Effect.mapError(ownershipFailure));
    if (result.status === "pending" || result.status === "unavailable") {
      retryAfterSeconds = Math.max(1, result.retry_after_seconds ?? 30);
    }
    state = yield* loadNamed(services.store, input, input.attachment_intent_id);
  }
  if (state.intent_status === "commit_ready") {
    const committed = yield* services.store.commit({
      actor_id: input.actor_id,
      community_id: input.community_id,
      attachment_intent_id: state.attachment_intent_id,
      route_binding_id: services.ids?.routeBinding?.() ?? `community-route_${crypto.randomUUID()}`,
    });
    if (committed.kind === "not_found") return yield* rejected("not_found");
    if (committed.kind === "ownership_conflict") return yield* rejected("ownership_conflict");
    if (committed.kind === "conflict") return yield* rejected("conflict");
    state = yield* loadNamed(services.store, input, input.attachment_intent_id);
  }
  return hnsTxtAttachmentResponse(state, Date.now(), retryAfterSeconds);
});

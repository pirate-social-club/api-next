import type { HnsPollResultCompletionResponseV1 } from "@pirate/contracts";
import { canonicalJson } from "@pirate/domain";
import { Data, Effect, Option, Schema } from "effect";
import {
  type NamespaceOwnershipProviderCompleteResult,
  type NamespaceOwnershipProviderFailure,
  NamespaceOwnershipProviderInvalidResponse,
  NamespaceOwnershipProviderMisconfigured,
  NamespaceOwnershipProviderRejected,
  NamespaceOwnershipProviderUnboundRejected,
  NamespaceOwnershipProviderUnsupportedProtocol,
  type RouteAttachmentOwnershipSession,
} from "./adapter.ts";
import { HNS_TXT_IMPORT_PROTOCOL_VERSION } from "./hns-import-publication-poll.ts";
import type { NamespaceOwnershipProviderRegistryService } from "./registry.ts";

const Identifier = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value === value.trim() && new TextEncoder().encode(value).byteLength <= 256
      ? undefined
      : "Expected a bounded identifier",
  ),
);
const Positive = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value > 0 ? undefined : "Expected a positive revision",
  ),
);

export const CompleteRouteAttachmentOwnershipInput = Schema.Struct({
  actor_id: Identifier,
  community_id: Identifier,
  attachment_intent_id: Identifier,
  ceremony_intent_id: Identifier,
  session_id: Identifier,
  expected_revision: Positive,
  idempotency_key: Identifier,
  channel: Schema.Literal("poll_result"),
});
export type CompleteRouteAttachmentOwnershipInput = Schema.Schema.Type<
  typeof CompleteRouteAttachmentOwnershipInput
>;

/**
 * The database publication window of the community root import that owns a
 * namespace session, when that import has exposed its plan. Null for every
 * other session, which keeps the unchanged hns-txt-v1 rules.
 */
export type RouteAttachmentImportPublicationWindow = Readonly<{
  readonly root_import_session_id: string;
  readonly root_label: string;
  readonly publish_plan_sha256: string;
  readonly challenge_value_sha256: string;
  readonly window_open: boolean;
  readonly reason: string;
  readonly valid_until: string | null;
}>;

export type RouteAttachmentCompletionStored = Readonly<{
  readonly namespace_session_id: string;
  readonly revision: number;
  readonly session: RouteAttachmentOwnershipSession;
  readonly import_publication: RouteAttachmentImportPublicationWindow | null;
  readonly status: "pending" | "completed" | "failed" | "expired";
  readonly terminal: null | Readonly<{
    readonly status: "verified" | "rejected" | "expired";
    readonly result_hash: string;
  }>;
}>;

export type RouteAttachmentCompletionReservation = Readonly<{
  readonly completion_attempt_id: string;
  readonly namespace_session_id: string;
  readonly fence_token: number;
  readonly evidence_ref: string;
  readonly lease_expires_at: string;
}>;

export type RouteAttachmentCompletionReservationOutcome =
  | Readonly<{
      readonly kind: "acquired";
      readonly reservation: RouteAttachmentCompletionReservation;
    }>
  | Readonly<{ readonly kind: "replay"; readonly stored: RouteAttachmentCompletionStored }>
  | Readonly<{ readonly kind: "in_flight"; readonly retry_after_seconds: number }>
  | Readonly<{ readonly kind: "window_closed"; readonly reason: string }>
  | Readonly<{ readonly kind: "budget_exhausted" | "conflict" | "not_found" }>;

export type RouteAttachmentCompletionFinalizeOutcome =
  | Readonly<{
      readonly kind: "committed" | "replay";
      readonly status: "verified" | "rejected" | "expired";
      readonly result_hash: string;
    }>
  | Readonly<{ readonly kind: "lease_lost" | "conflict" }>;

export interface RouteAttachmentCompletionStore {
  readonly load: (
    input: CompleteRouteAttachmentOwnershipInput,
  ) => Effect.Effect<
    RouteAttachmentCompletionStored | null,
    RouteAttachmentCompletionStorageFailed
  >;
  readonly reserve: (input: {
    readonly request: CompleteRouteAttachmentOwnershipInput;
    readonly completion_request_sha256: string;
    readonly completion_attempt_id: string;
    readonly evidence_ref: string;
    readonly lease_ms: number;
    readonly max_attempts: number;
  }) => Effect.Effect<
    RouteAttachmentCompletionReservationOutcome,
    RouteAttachmentCompletionStorageFailed
  >;
  readonly release: (input: {
    readonly request: CompleteRouteAttachmentOwnershipInput;
    readonly completion_request_sha256: string;
    readonly reservation: RouteAttachmentCompletionReservation;
    readonly retryable_observation?: boolean;
    /** Nothing was observed; the attempt does not count toward the budget. */
    readonly not_attempted?: boolean;
  }) => Effect.Effect<"released" | "lease_lost", RouteAttachmentCompletionStorageFailed>;
  readonly finalize: (input: {
    readonly request: CompleteRouteAttachmentOwnershipInput;
    readonly completion_request_sha256: string;
    readonly reservation: RouteAttachmentCompletionReservation;
    readonly status: "verified" | "rejected" | "expired";
    readonly result_hash: string;
    readonly provider_result: NamespaceOwnershipProviderCompleteResult;
    readonly provider_response_sha256: string | null;
    readonly evidence_digest: string | null;
    readonly provider_identity_digest: string | null;
  }) => Effect.Effect<
    RouteAttachmentCompletionFinalizeOutcome,
    RouteAttachmentCompletionStorageFailed
  >;
}

export interface RouteAttachmentCompletionServices {
  readonly registry: NamespaceOwnershipProviderRegistryService;
  readonly store: RouteAttachmentCompletionStore;
  readonly ids?: Readonly<{
    readonly attempt?: () => string;
    readonly evidence?: () => string;
  }>;
}

export class RouteAttachmentCompletionRejected extends Data.TaggedError(
  "RouteAttachmentCompletionRejected",
)<{
  readonly reason:
    | "invalid"
    | "not_found"
    | "conflict"
    | "in_flight"
    | "attempt_budget_exhausted"
    | "provider_unavailable"
    | "provider_misconfigured"
    | "publication_window_closed";
  readonly retry_after_seconds?: number;
  /** Why an exposed import's publication window refused the check. */
  readonly window_reason?: string;
}> {}

export class RouteAttachmentCompletionStorageFailed extends Data.TaggedError(
  "RouteAttachmentCompletionStorageFailed",
) {}

const exact = { onExcessProperty: "error" } as const;
const encoder = new TextEncoder();
const MAX_ATTEMPTS = 3;
const LEASE_MARGIN_MS = 1_000;
/** How soon to ask again when the verifier cannot yet answer an import poll. */
const IMPORT_PROTOCOL_UNAVAILABLE_RETRY_SECONDS = 60;

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: unknown): Promise<string> {
  return sha256Bytes(encoder.encode(canonicalJson(value)));
}

function response(
  stored: RouteAttachmentCompletionStored,
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

function terminalResponse(stored: RouteAttachmentCompletionStored) {
  return stored.terminal === null
    ? null
    : response(stored, stored.terminal.status, true, stored.terminal.result_hash, null);
}

export const completeRouteAttachmentOwnership = Effect.fn("completeRouteAttachmentOwnership")(
  function* (
    untrustedInput: unknown,
    services: RouteAttachmentCompletionServices,
  ): Effect.fn.Return<
    HnsPollResultCompletionResponseV1,
    RouteAttachmentCompletionRejected | RouteAttachmentCompletionStorageFailed | unknown
  > {
    const decoded = Schema.decodeUnknownOption(
      CompleteRouteAttachmentOwnershipInput,
      exact,
    )(untrustedInput);
    if (Option.isNone(decoded)) {
      return yield* new RouteAttachmentCompletionRejected({ reason: "invalid" });
    }
    const input = decoded.value;
    const stored = yield* services.store.load(input);
    if (stored === null)
      return yield* new RouteAttachmentCompletionRejected({ reason: "not_found" });
    const terminal = terminalResponse(stored);
    if (terminal !== null) return terminal;
    if (stored.status !== "pending" || stored.revision !== input.expected_revision) {
      return yield* new RouteAttachmentCompletionRejected({ reason: "conflict" });
    }
    const provider = yield* services.registry.resolve(stored.session.route.family);
    const importWindow = stored.import_publication;
    if (importWindow !== null && (!importWindow.window_open || importWindow.valid_until === null)) {
      return yield* new RouteAttachmentCompletionRejected({
        reason: "publication_window_closed",
        window_reason: importWindow.reason,
      });
    }
    if (
      provider.manifest.provider_id !== stored.session.provider_id ||
      (importWindow === null && provider.completeRouteAttachment === undefined)
    ) {
      return yield* new RouteAttachmentCompletionRejected({ reason: "provider_unavailable" });
    }
    // An exposed import is polled only under hns-txt-import-v1. When the
    // pinned provider entry does not advertise it, no attempt is reserved, so
    // the three-attempt budget is untouched while a verifier catches up.
    const completeImport = provider.completeRouteAttachmentImport;
    if (importWindow !== null && completeImport === undefined) {
      return response(
        stored,
        "unavailable",
        false,
        null,
        IMPORT_PROTOCOL_UNAVAILABLE_RETRY_SECONDS,
      );
    }
    const completionRequestSha256 = yield* Effect.promise(() =>
      sha256({
        version: "pirate-route-attachment-completion-v1",
        actor_id: input.actor_id,
        community_id: input.community_id,
        attachment_intent_id: input.attachment_intent_id,
        ceremony_intent_id: input.ceremony_intent_id,
        session_id: input.session_id,
        expected_revision: input.expected_revision,
        idempotency_key: input.idempotency_key,
        channel: input.channel,
      }),
    );
    const reserved = yield* services.store.reserve({
      request: input,
      completion_request_sha256: completionRequestSha256,
      completion_attempt_id:
        services.ids?.attempt?.() ?? `route-attachment-completion_${crypto.randomUUID()}`,
      evidence_ref:
        services.ids?.evidence?.() ?? `route-attachment-evidence_${crypto.randomUUID()}`,
      lease_ms: provider.manifest.operation_deadlines.complete_ms + LEASE_MARGIN_MS,
      max_attempts: MAX_ATTEMPTS,
    });
    if (reserved.kind === "replay") {
      const replay = terminalResponse(reserved.stored);
      return replay ?? (yield* new RouteAttachmentCompletionRejected({ reason: "conflict" }));
    }
    if (reserved.kind === "in_flight") {
      return yield* new RouteAttachmentCompletionRejected({
        reason: "in_flight",
        retry_after_seconds: reserved.retry_after_seconds,
      });
    }
    if (reserved.kind === "window_closed") {
      return yield* new RouteAttachmentCompletionRejected({
        reason: "publication_window_closed",
        window_reason: reserved.reason,
      });
    }
    if (reserved.kind === "budget_exhausted") {
      return yield* new RouteAttachmentCompletionRejected({ reason: "attempt_budget_exhausted" });
    }
    if (reserved.kind === "not_found") {
      return yield* new RouteAttachmentCompletionRejected({ reason: "not_found" });
    }
    if (reserved.kind === "conflict") {
      return yield* new RouteAttachmentCompletionRejected({ reason: "conflict" });
    }
    if (!("reservation" in reserved)) {
      return yield* new RouteAttachmentCompletionRejected({ reason: "conflict" });
    }
    const reservation = reserved.reservation;
    const context = {
      namespace_session_id: stored.namespace_session_id,
      observation_id: yield* Effect.promise(() =>
        sha256({
          attempt: reservation.completion_attempt_id,
          fence: reservation.fence_token,
        }),
      ),
    };
    const submission = { channel: "poll_result" as const, payload: {} };
    const providerCall: Effect.Effect<
      NamespaceOwnershipProviderCompleteResult,
      NamespaceOwnershipProviderFailure | RouteAttachmentCompletionRejected
    > =
      importWindow !== null && completeImport !== undefined
        ? completeImport(
            {
              session: stored.session,
              binding: {
                protocol_version: HNS_TXT_IMPORT_PROTOCOL_VERSION,
                root_import_session_id: importWindow.root_import_session_id,
                root_label: importWindow.root_label,
                publish_plan_sha256: importWindow.publish_plan_sha256,
                challenge_value_sha256: importWindow.challenge_value_sha256,
                valid_until: importWindow.valid_until as string,
              },
              submission,
            },
            context,
          )
        : provider.completeRouteAttachment !== undefined
          ? provider.completeRouteAttachment({ session: stored.session, submission }, context)
          : Effect.fail(new RouteAttachmentCompletionRejected({ reason: "provider_unavailable" }));
    const attempted = yield* providerCall.pipe(
      Effect.matchEffect({
        onSuccess: (value) => Effect.succeed({ kind: "observed" as const, value }),
        onFailure: (error) =>
          error instanceof NamespaceOwnershipProviderUnsupportedProtocol
            ? // The verifier could not answer this protocol, so nothing was
              // observed. The reservation is released as not attempted and
              // does not count toward MAX_ATTEMPTS.
              services.store
                .release({
                  request: input,
                  completion_request_sha256: completionRequestSha256,
                  reservation,
                  not_attempted: true,
                })
                .pipe(Effect.as({ kind: "unsupported" as const }))
            : services.store
                .release({
                  request: input,
                  completion_request_sha256: completionRequestSha256,
                  reservation,
                })
                .pipe(
                  Effect.flatMap(() =>
                    Effect.fail(
                      new RouteAttachmentCompletionRejected({
                        reason:
                          error instanceof NamespaceOwnershipProviderRejected ||
                          error instanceof NamespaceOwnershipProviderUnboundRejected ||
                          error instanceof NamespaceOwnershipProviderInvalidResponse ||
                          error instanceof NamespaceOwnershipProviderMisconfigured
                            ? "provider_misconfigured"
                            : "provider_unavailable",
                      }),
                    ),
                  ),
                ),
      }),
    );
    if (attempted.kind === "unsupported") {
      return response(
        stored,
        "unavailable",
        false,
        null,
        IMPORT_PROTOCOL_UNAVAILABLE_RETRY_SECONDS,
      );
    }
    const providerResult = attempted.value;
    if (providerResult.status === "pending" || providerResult.status === "unavailable") {
      yield* services.store.release({
        retryable_observation: true,
        request: input,
        completion_request_sha256: completionRequestSha256,
        reservation,
      });
      return response(
        stored,
        providerResult.status,
        false,
        null,
        providerResult.status === "unavailable" ? (providerResult.retry_after_seconds ?? 1) : 1,
      );
    }
    const terminalStatus =
      providerResult.status === "verified"
        ? "verified"
        : providerResult.status === "rejected" || providerResult.status === "ineligible"
          ? "rejected"
          : "expired";
    const rawBytes =
      "raw_response_bytes" in providerResult ? providerResult.raw_response_bytes : null;
    const providerResponseSha256 =
      rawBytes === null ? null : yield* Effect.promise(() => sha256Bytes(rawBytes));
    const providerIdentityDigest =
      terminalStatus !== "verified"
        ? null
        : yield* Effect.promise(() =>
            sha256({
              version: "pirate-route-attachment-provider-identity-v1",
              provider_id: stored.session.provider_id,
              provider_binding_hash: stored.session.provider_binding_hash,
              provider_configuration: stored.session.provider_configuration,
              protocol_version: stored.session.protocol_version,
              environment: stored.session.environment,
              route: stored.session.route,
            }),
          );
    const evidenceDigest =
      terminalStatus !== "verified" || providerResult.status !== "verified" || rawBytes === null
        ? null
        : yield* Effect.promise(() =>
            sha256({
              version: "pirate-route-attachment-evidence-v1",
              actor_id: input.actor_id,
              community_id: input.community_id,
              attachment_intent_id: input.attachment_intent_id,
              ceremony_intent_id: input.ceremony_intent_id,
              namespace_session_id: input.session_id,
              generation: stored.session.generation,
              evidence_ref: reservation.evidence_ref,
              provider_response_sha256: providerResponseSha256,
              observed_at: providerResult.observed_at,
              expires_at: providerResult.expires_at,
            }),
          );
    const resultHash = yield* Effect.promise(() =>
      sha256({
        version: "pirate-route-attachment-completion-result-v1",
        completion_request_sha256: completionRequestSha256,
        status: terminalStatus,
        evidence_ref: terminalStatus === "verified" ? reservation.evidence_ref : null,
        evidence_digest: evidenceDigest,
        provider_identity_digest: providerIdentityDigest,
        provider_response_sha256: providerResponseSha256,
      }),
    );
    const finalized = yield* services.store.finalize({
      request: input,
      completion_request_sha256: completionRequestSha256,
      reservation,
      status: terminalStatus,
      result_hash: resultHash,
      provider_result: providerResult,
      provider_response_sha256: providerResponseSha256,
      evidence_digest: evidenceDigest,
      provider_identity_digest: providerIdentityDigest,
    });
    if (finalized.kind === "conflict") {
      return yield* new RouteAttachmentCompletionRejected({ reason: "conflict" });
    }
    if (finalized.kind === "lease_lost") {
      return response(stored, "unavailable", false, null, 1);
    }
    if (!("status" in finalized)) {
      return yield* new RouteAttachmentCompletionRejected({ reason: "conflict" });
    }
    return response(
      { ...stored, revision: stored.revision + 1 },
      finalized.status,
      finalized.kind === "replay",
      finalized.result_hash,
      null,
    );
  },
);

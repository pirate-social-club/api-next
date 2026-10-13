// PRIVATE SOURCE PROPOSAL. Transport-private response plans; no endpoint activation.
import {
  ControlPlaneOperationTimedOut,
  ControlPlaneStatementFailed,
  ControlPlaneTransactionOutcomeUnknown,
  canonicalBodyHash,
} from "@pirate/application";
import {
  type BrowserParticipationContext,
  type DurableParticipationOutcome,
  type GuestAttachmentStore,
  type GuestAuthorityStore,
  type GuestAuthorityTransition,
  type GuestCookieEffect,
  type GuestParticipationStoreFailure,
  GuestParticipationStoreRejected,
  type ParticipationOperationIdentity,
} from "@pirate/application/guest-participation-authority";
import {
  AcknowledgeGuestCredentialV1,
  CleanupGuestBrowserProofV1,
  ConfirmGuestBootstrapV1,
  CreateGuestAttachmentIntentV1,
  GetGuestAuthorityV1,
  GuestAuthError,
  GuestBadRequest,
  GuestConflict,
  GuestIdentifierV1,
  GuestInstantV1,
  type GuestOperationLocatorV1,
  GuestPendingConflict,
  InternalError,
  IssueGuestBootstrapV1,
  RenewGuestAuthorityV1,
  RotateGuestCredentialV1,
} from "@pirate/contracts";
import {
  GuestProofMaterial,
  newGuestAttachmentIntentId,
  newGuestCredentialId,
} from "@pirate/platform-cf/guest-proof-crypto";
import { Effect, Schema } from "effect";
import { parseGuestBrowserCookies } from "./guest-browser-cookie-policy.ts";
import {
  ensureGuestCsrfCookie,
  writeGuestResponseCookies,
} from "./guest-browser-response-cookies.ts";
import {
  type DecodedRequest,
  type EndpointHandlerResult,
  withEndpointResult,
} from "./transport.ts";

const definitions = {
  GetGuestAuthorityV1,
  IssueGuestBootstrapV1,
  ConfirmGuestBootstrapV1,
  RenewGuestAuthorityV1,
  RotateGuestCredentialV1,
  AcknowledgeGuestCredentialV1,
  CleanupGuestBrowserProofV1,
  CreateGuestAttachmentIntentV1,
} as const;
export type GuestAuthorityControllerName = keyof typeof definitions;
type Issued = Readonly<{ kind: "credential" | "intent"; id: string; material: GuestProofMaterial }>;
const invalid = () =>
  new GuestBadRequest({
    message: "Invalid guest request",
    details: { reason_code: "guest_request_invalid" },
  });
const internal = () => new InternalError({ message: "Guest authority operation unavailable" });
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch {
    throw invalid();
  }
};

/** Private plan, never a DecodedRequest field or normal application JSON value. */
export class GuestAuthorityResponsePlan {
  readonly #context: BrowserParticipationContext;
  readonly #effects: readonly GuestCookieEffect[];
  readonly #issued: readonly Issued[];
  readonly #csrf: boolean;
  readonly #body: unknown;
  constructor(
    input: Readonly<{
      name: GuestAuthorityControllerName;
      context: BrowserParticipationContext;
      body: unknown;
      effects?: readonly GuestCookieEffect[];
      issued?: readonly Issued[];
      ensureCsrf?: boolean;
    }>,
  ) {
    this.#context = input.context;
    try {
      this.#body = decode(definitions[input.name].response, input.body);
    } catch {
      throw internal();
    }
    this.#effects = input.effects ?? [];
    this.#issued = input.issued ?? [];
    this.#csrf = input.ensureCsrf ?? false;
  }
  // Public projection contains no private fields/material; original effects stay
  // unavailable to a normal handler/policy authorizer or object inspection.
  toJSON(): unknown {
    return this.#body;
  }
  async finalize(originalRequestHeaders: Headers): Promise<EndpointHandlerResult> {
    const cleanup = this.#context.authority === "recovery" && this.#context.operation === "cleanup";
    const carried = parseGuestBrowserCookies(originalRequestHeaders, cleanup);
    const proved = new Set(this.#context.provedCredentials.map((proof) => proof.credentialId));
    const intents = new Set(this.#context.provedIntents.map((proof) => proof.intentId));
    for (const effect of this.#effects) {
      if (
        effect.kind === "credential" &&
        effect.action === "refresh" &&
        !proved.has(effect.credentialId)
      )
        throw internal();
      if (
        effect.kind === "credential" &&
        effect.action === "expire" &&
        !proved.has(effect.credentialId) &&
        !(
          this.#context.authority === "recovery" &&
          this.#context.operation === "acknowledge" &&
          this.#context.selected.predecessorCredentialId === effect.credentialId
        )
      )
        throw internal();
      if (effect.kind === "intent" && effect.action === "expire" && !intents.has(effect.intentId))
        throw internal();
      if (
        effect.action === "issue" &&
        !this.#issued.some(
          (material) =>
            material.kind === effect.kind &&
            material.id === (effect.kind === "credential" ? effect.credentialId : effect.intentId),
        )
      )
        throw internal();
    }
    let headers: Headers;
    try {
      headers = writeGuestResponseCookies({
        headers: new Headers(),
        effects: this.#effects,
        issuedProofs: this.#issued,
        carriedCredentials: carried.credentials.filter((proof) => proved.has(proof.credentialId)),
      });
      if (this.#csrf) headers = await ensureGuestCsrfCookie(headers, carried.csrf);
    } catch {
      throw internal();
    }
    return withEndpointResult(this.#body, undefined, headers);
  }
}

export interface GuestAuthorityControllerServices {
  readonly authority: GuestAuthorityStore;
  /** Mandatory explicit source dependency; no attachment backend is invented here. */
  readonly intent: Pick<GuestAttachmentStore, "createIntent">;
  readonly nowMilliseconds: () => number;
  readonly retryAfterSeconds: number;
}

async function requestHash(
  origin: string,
  kind: ParticipationOperationIdentity["kind"],
  body: unknown,
): Promise<string> {
  // Reuse maintained RFC8785 canonical hashing; schema decode alone need not
  // normalize property order. Never hash new IDs/material/clocks,
  // proof presence or selection: exact issuance replay must survive its response.
  return Effect.runPromise(
    canonicalBodyHash(["pirate_guest_control_request_v1", origin, kind, body]),
  );
}

export function makeGuestAuthorityControllers(services: GuestAuthorityControllerServices) {
  if (
    !Number.isInteger(services.retryAfterSeconds) ||
    services.retryAfterSeconds < 1 ||
    services.retryAfterSeconds > 3600
  )
    throw new Error("Reviewed guest reconciliation delay required");
  const pending = (locator: GuestOperationLocatorV1) =>
    new GuestPendingConflict({
      message: "Operation awaiting confirmation",
      details: {
        reason_code: "operation_pending_confirmation",
        operation: locator,
        retry_after_seconds: services.retryAfterSeconds,
      },
    });
  const rejected = (error: GuestParticipationStoreRejected) => {
    switch (error.reason) {
      case "proof-revoked":
        return new GuestAuthError({
          message: "Guest proof revoked",
          details: { reason_code: "guest_proof_revoked" },
        });
      case "lease-expired":
        return new GuestAuthError({
          message: "Learning lease expired",
          details: { reason_code: "guest_learning_lease_expired" },
        });
      case "owner-mismatch":
        return new GuestConflict({
          message: "Guest source differs",
          details: { reason_code: "guest_owner_mismatch" },
        });
      case "authority-conflict":
        return new GuestConflict({
          message: "Select original guest source",
          details: { reason_code: "guest_authority_conflict" },
        });
      case "credential-cleanup-required":
        return new GuestConflict({
          message: "Guest cleanup required",
          details: { reason_code: "guest_credential_cleanup_required" },
        });
      case "ceremony-cleanup-required":
        return new GuestConflict({
          message: "Ceremony cleanup required",
          details: { reason_code: "guest_ceremony_cleanup_required" },
        });
      case "issuance-requires-restart":
        return new GuestConflict({
          message: "Explicit issuance restart required",
          details: { reason_code: "issuance_requires_restart" },
        });
      case "idempotency-conflict":
        return new GuestConflict({
          message: "Original operation differs",
          details: { reason_code: "idempotency_conflict" },
        });
      default:
        return internal(); // No error-text parsing or new public reason.
    }
  };
  const run = <A>(
    effect: Effect.Effect<A, GuestParticipationStoreFailure>,
    locator?: GuestOperationLocatorV1,
  ): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.catch((error) =>
          Effect.fail(
            error instanceof GuestParticipationStoreRejected
              ? rejected(error)
              : error instanceof ControlPlaneTransactionOutcomeUnknown ||
                  ((error instanceof ControlPlaneOperationTimedOut ||
                    error instanceof ControlPlaneStatementFailed) &&
                    error.outcomeCertainty === "unknown")
                ? locator === undefined
                  ? internal()
                  : pending(locator)
                : internal(),
          ),
        ),
      ),
    );
  const expires = () => {
    const now = services.nowMilliseconds();
    if (!Number.isSafeInteger(now) || now <= 0) throw internal();
    return decode(GuestInstantV1, new Date(now + 900_000).toISOString());
  };
  const completed = <A>(
    value: DurableParticipationOutcome<A>,
    expected: ParticipationOperationIdentity,
  ): A => {
    if (
      value.operation.kind !== expected.kind ||
      value.operation.idempotencyKey !== expected.idempotencyKey ||
      value.operation.requestHash !== expected.requestHash
    )
      throw internal();
    if (value.state === "pending_confirmation")
      throw pending({
        operation_kind: value.operation.kind,
        idempotency_key: value.operation.idempotencyKey,
        operation_id: value.outcomeId,
      });
    if (value.state === "known_aborted") throw internal(); // No wire claim of absent/recreated authority.
    return value.result;
  };
  const transition = (
    name: GuestAuthorityControllerName,
    context: BrowserParticipationContext,
    result: GuestAuthorityTransition,
    issued: readonly Issued[] = [],
  ) =>
    new GuestAuthorityResponsePlan({
      name,
      context,
      body: result.authority,
      effects: result.cookieEffects,
      issued,
    });
  return {
    /** Called after actual transport authentication and exact bounded schema decode. */
    async dispatch(
      name: GuestAuthorityControllerName,
      input: DecodedRequest,
    ): Promise<GuestAuthorityResponsePlan> {
      const context = input.browserParticipation;
      if (input.principal !== null || context === undefined) throw internal();
      switch (name) {
        case "GetGuestAuthorityV1": {
          if (context.authority !== "bootstrap" || context.operation !== "discover")
            throw internal();
          const query = decode(GetGuestAuthorityV1.request.query, input.query);
          const body = await run(
            services.authority.discover({
              context,
              expectedOwnerId: query.expected_owner_id ?? null,
              previousCredentialId: query.previous_credential_id ?? null,
            }),
          );
          return new GuestAuthorityResponsePlan({ name, context, body, ensureCsrf: true });
        }
        case "IssueGuestBootstrapV1": {
          if (context.authority !== "bootstrap" || context.operation !== "issue") throw internal();
          const body = decode(IssueGuestBootstrapV1.request.body, input.body);
          const newOwnerId = decode(GuestIdentifierV1, `owner_${crypto.randomUUID()}`);
          const credentialId = newGuestCredentialId();
          const material = await GuestProofMaterial.issue();
          const operation: ParticipationOperationIdentity = {
            sourceOwnerId: context.selected?.ownerId ?? newOwnerId,
            kind: "bootstrap_issue",
            idempotencyKey: body.idempotency_key,
            requestHash: await requestHash(context.origin, "bootstrap_issue", body),
          };
          const outcome = await run(
            services.authority.issuePending({
              context,
              newOwnerId,
              issuance: {
                operation,
                credentialId,
                tokenDigest: material.digestForStore(),
                pendingExpiresAt: expires(),
              },
            }),
            {
              operation_kind: operation.kind,
              idempotency_key: operation.idempotencyKey,
              operation_id: null,
            },
          );
          return transition(name, context, completed(outcome, operation), [
            { kind: "credential", id: credentialId, material },
          ]);
        }
        case "ConfirmGuestBootstrapV1": {
          if (context.authority !== "bootstrap" || context.operation !== "confirm")
            throw internal();
          const body = decode(ConfirmGuestBootstrapV1.request.body, input.body);
          return transition(
            name,
            context,
            await run(
              services.authority.confirm({
                context,
                expectedOwnerId: body.expected_owner_id,
                credentialId: body.credential_id,
              }),
              {
                operation_kind: "bootstrap_confirm",
                idempotency_key: body.credential_id,
                operation_id: null,
              },
            ),
          );
        }
        case "RenewGuestAuthorityV1": {
          if (context.authority !== "recovery" || context.operation !== "renew") throw internal();
          const body = decode(RenewGuestAuthorityV1.request.body, input.body);
          return transition(
            name,
            context,
            await run(
              services.authority.renew({
                context: { ...context, operation: "renew" },
                expectedOwnerId: body.expected_owner_id,
              }),
              {
                operation_kind: "authority_renew",
                idempotency_key: context.selected.credentialId,
                operation_id: null,
              },
            ),
          );
        }
        case "RotateGuestCredentialV1": {
          if (context.authority !== "recovery" || context.operation !== "rotate") throw internal();
          const body = decode(RotateGuestCredentialV1.request.body, input.body);
          const credentialId = newGuestCredentialId();
          const material = await GuestProofMaterial.issue();
          const operation: ParticipationOperationIdentity = {
            sourceOwnerId: context.selected.ownerId,
            kind: "credential_rotate",
            idempotencyKey: body.idempotency_key,
            requestHash: await requestHash(context.origin, "credential_rotate", body),
          };
          const outcome = await run(
            services.authority.issueRotation({
              context: { ...context, operation: "rotate" },
              expectedOwnerId: body.expected_owner_id,
              issuance: {
                operation,
                credentialId,
                tokenDigest: material.digestForStore(),
                pendingExpiresAt: expires(),
              },
            }),
            {
              operation_kind: operation.kind,
              idempotency_key: operation.idempotencyKey,
              operation_id: null,
            },
          );
          return transition(name, context, completed(outcome, operation), [
            { kind: "credential", id: credentialId, material },
          ]);
        }
        case "AcknowledgeGuestCredentialV1": {
          if (context.authority !== "recovery" || context.operation !== "acknowledge")
            throw internal();
          const body = decode(AcknowledgeGuestCredentialV1.request.body, input.body);
          return transition(
            name,
            context,
            await run(
              services.authority.acknowledgeRotation({
                context,
                expectedOwnerId: body.expected_owner_id,
                predecessorCredentialId: body.predecessor_credential_id,
                successorCredentialId: body.successor_credential_id,
              }),
              {
                operation_kind: "credential_acknowledge",
                idempotency_key: `${body.predecessor_credential_id}:${body.successor_credential_id}`,
                operation_id: null,
              },
            ),
          );
        }
        case "CleanupGuestBrowserProofV1": {
          if (context.authority !== "recovery" || context.operation !== "cleanup") throw internal();
          const body = decode(CleanupGuestBrowserProofV1.request.body, input.body);
          const outcome = await run(
            services.authority.cleanup({
              context,
              selectedCredentialId: body.selected_credential_id,
              candidateCredentialIds: body.candidate_credential_ids,
              candidateIntentIds: body.candidate_intent_ids,
            }),
            {
              operation_kind: "credential_cleanup",
              idempotency_key: await requestHash(context.origin, "credential_cleanup", body),
              operation_id: null,
            },
          );
          return new GuestAuthorityResponsePlan({
            name,
            context,
            effects: outcome.cookieEffects,
            body: {
              authority: outcome.authority,
              expired_credential_ids: outcome.cookieEffects.flatMap((effect) =>
                effect.kind === "credential" ? [effect.credentialId] : [],
              ),
              expired_intent_ids: outcome.cookieEffects.flatMap((effect) =>
                effect.kind === "intent" ? [effect.intentId] : [],
              ),
            },
          });
        }
        case "CreateGuestAttachmentIntentV1": {
          if (context.authority !== "recovery" || context.operation !== "create_attachment_intent")
            throw internal();
          const body = decode(CreateGuestAttachmentIntentV1.request.body, input.body);
          if (body.expected_owner_id !== context.selected.ownerId)
            throw new GuestConflict({
              message: "Guest source differs",
              details: { reason_code: "guest_owner_mismatch" },
            });
          const intentId = newGuestAttachmentIntentId();
          const material = await GuestProofMaterial.issue();
          const operation: ParticipationOperationIdentity = {
            sourceOwnerId: context.selected.ownerId,
            kind: "attachment_intent",
            idempotencyKey: body.idempotency_key,
            requestHash: await requestHash(context.origin, "attachment_intent", body),
          };
          const outcome = completed(
            await run(
              services.intent.createIntent({
                context: { ...context, operation: "create_attachment_intent" },
                expectedOwnerId: body.expected_owner_id,
                operation,
                intentId,
                nonceDigest: material.digestForStore(),
                expiresAt: expires(),
              }),
              {
                operation_kind: operation.kind,
                idempotency_key: operation.idempotencyKey,
                operation_id: null,
              },
            ),
            operation,
          );
          return new GuestAuthorityResponsePlan({
            name,
            context,
            body: outcome.intent,
            effects: outcome.cookieEffects,
            issued: [{ kind: "intent", id: intentId, material }],
          });
        }
      }
    },
  };
}

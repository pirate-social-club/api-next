/** Source graph only. Declaration admission and managed native readiness are separate. */
import {
  type BrowserParticipationContext, type DurableParticipationOutcome,
  type GuestAttachmentStore, type GuestCookieEffect, type GuestParticipationStoreFailure,
  GuestParticipationStoreRejected, type OrdinaryBrowserAccount,
  type ParticipationOperationIdentity, type SetupBrowserAccount,
} from "@pirate/application/guest-participation-authority";
import type {
  OwnerRewardCreditAuthority, OwnerRewardCreditClaimStore, OwnerRewardCreditStore,
  RewardCreditRecipientStore,
} from "@pirate/application/owner-reward-credit-ports";
import {
  canonicalBodyHash, ControlPlaneOperationTimedOut, ControlPlaneStatementFailed,
  ControlPlaneTransactionOutcomeUnknown,
} from "@pirate/application/use-cases/guest-learning";
import {
  ClaimOwnerRewardCreditV1, ConfirmGuestAttachmentTargetV1,
  GetMySuccessfulGuestAttachmentV1, GuestAuthError, GuestBadRequest, GuestConflict,
  type GuestOperationLocatorV1, GuestPendingConflict, InternalError, NotFound,
  type OwnerRewardCreditV1, PrepareGuestAttachmentTargetV1,
  SelectOwnerRewardCreditRecipientV1,
} from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { parseGuestBrowserCookies } from "./guest-browser-cookie-policy.ts";
import { writeGuestResponseCookies } from "./guest-browser-response-cookies.ts";
import { type DecodedRequest, type EndpointHandlerResult, withEndpointResult } from "./transport.ts";

const definitions = {
  PrepareGuestAttachmentTargetV1, ConfirmGuestAttachmentTargetV1,
  GetMySuccessfulGuestAttachmentV1, SelectOwnerRewardCreditRecipientV1,
  ClaimOwnerRewardCreditV1,
} as const;
export type GuestAccountingControllerName = keyof typeof definitions;
export function isGuestAccountingControllerName(name: string): name is GuestAccountingControllerName {
  return Object.hasOwn(definitions, name);
}
/** Created by the actual request authenticator; kept outside frozen DecodedRequest. */
type GuestAccountingAccountAuthority = Readonly<{
  origin: string; account: OrdinaryBrowserAccount | SetupBrowserAccount;
}>;
type AttachmentContext = Extract<BrowserParticipationContext, { authority: "attachment" }>;
const unavailable = () => new InternalError({ message: "Original accounting operation unavailable" });
const invalid = () => new GuestBadRequest({ message: "Invalid accounting request", details: { reason_code: "guest_request_invalid" } });
const conflict = (reason: "guest_owner_mismatch" | "recipient_selection_conflict" | "attachment_target_changed") =>
  new GuestConflict({ message: "Original accounting authority differs", details: { reason_code: reason } });
function decode<S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): S["Type"] {
  try { return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value); }
  catch { throw invalid(); }
}
function originalCredit(actual: OwnerRewardCreditV1, expected: OwnerRewardCreditV1) {
  if (actual.credit_id !== expected.credit_id || actual.owner_id !== expected.owner_id ||
      actual.community_id !== expected.community_id || actual.pool_leg_id !== expected.pool_leg_id ||
      actual.original_drawing_id !== expected.original_drawing_id || actual.amount_atomic !== expected.amount_atomic ||
      actual.chain_id !== expected.chain_id || actual.token_address !== expected.token_address ||
      actual.token_decimals !== expected.token_decimals || actual.created_at !== expected.created_at)
    throw unavailable();
}

/** Cookie effects stay private until every completed response/correlation check succeeds. */
class AccountingResponsePlan {
  readonly #body: unknown;
  readonly #context: AttachmentContext | undefined;
  readonly #effects: readonly GuestCookieEffect[];
  constructor(name: GuestAccountingControllerName, body: unknown, context?: AttachmentContext,
    effects: readonly GuestCookieEffect[] = []) {
    try { this.#body = decode(definitions[name].response, body); } catch { throw unavailable(); }
    this.#context = context; this.#effects = effects;
  }
  toJSON() { return this.#body; }
  finalize(originalHeaders: Headers): EndpointHandlerResult {
    let headers = new Headers({ "cache-control": "private, no-store" });
    if (this.#effects.length !== 0) {
      const context = this.#context;
      if (context === undefined || context.operation !== "confirm_target") throw unavailable();
      const proved = new Set(context.provedCredentials.map(p => p.credentialId));
      const seen = new Set<string>();
      for (const effect of this.#effects) {
        if (effect.kind !== "credential" || effect.action !== "expire" ||
            !proved.has(effect.credentialId) || seen.has(effect.credentialId)) throw unavailable();
        seen.add(effect.credentialId);
      }
      try {
        const carried = parseGuestBrowserCookies(originalHeaders, false);
        headers = writeGuestResponseCookies({ headers, effects: this.#effects, issuedProofs: [],
          carriedCredentials: carried.credentials.filter(p => proved.has(p.credentialId)) });
      } catch { throw unavailable(); }
    }
    return withEndpointResult(this.#body, undefined, headers);
  }
}
export interface GuestAccountingControllerServices {
  readonly attachment: Pick<GuestAttachmentStore, "prepareTarget" | "confirm" | "findBoundAttachment">;
  readonly credits: OwnerRewardCreditStore;
  readonly recipients: RewardCreditRecipientStore;
  readonly claims: Pick<OwnerRewardCreditClaimStore, "claim">;
  readonly retryAfterSeconds: number;
}

export function makeGuestAccountingControllers(services: GuestAccountingControllerServices) {
  if (!Number.isInteger(services.retryAfterSeconds) || services.retryAfterSeconds < 1 || services.retryAfterSeconds > 3600)
    throw new Error("Reviewed reconciliation delay required");
  const pending = (operation: GuestOperationLocatorV1) => new GuestPendingConflict({
    message: "Original operation awaiting confirmation", details: {
      reason_code: "operation_pending_confirmation", operation,
      retry_after_seconds: services.retryAfterSeconds,
    },
  });
  const rejected = (error: GuestParticipationStoreRejected) => {
    switch (error.reason) {
      case "proof-revoked": return new GuestAuthError({ message: "Guest proof revoked", details: { reason_code: "guest_proof_revoked" } });
      case "owner-mismatch": return conflict("guest_owner_mismatch");
      case "authority-conflict": return new GuestConflict({ message: "Select original source", details: { reason_code: "guest_authority_conflict" } });
      case "credential-cleanup-required": return new GuestConflict({ message: "Credential cleanup required", details: { reason_code: "guest_credential_cleanup_required" } });
      case "ceremony-cleanup-required": return new GuestConflict({ message: "Ceremony cleanup required", details: { reason_code: "guest_ceremony_cleanup_required" } });
      case "idempotency-conflict": return new GuestConflict({ message: "Original request differs", details: { reason_code: "idempotency_conflict" } });
      case "recipient-selection-conflict": return conflict("recipient_selection_conflict");
      case "target-changed": case "intent-expired": return conflict("attachment_target_changed");
      case "not-found": return new NotFound({ message: "Original accounting resource not found" });
      default: return unavailable();
    }
  };
  const run = <A>(effect: Effect.Effect<A, GuestParticipationStoreFailure>, locator?: GuestOperationLocatorV1): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.catch(error => Effect.fail(
      error instanceof GuestParticipationStoreRejected ? rejected(error) :
      error instanceof ControlPlaneTransactionOutcomeUnknown ||
      ((error instanceof ControlPlaneOperationTimedOut || error instanceof ControlPlaneStatementFailed) && error.outcomeCertainty === "unknown")
        ? locator === undefined ? unavailable() : pending(locator) : unavailable(),
    ))));
  const completed = <A>(outcome: DurableParticipationOutcome<A>, expected: ParticipationOperationIdentity): A => {
    const operation = outcome.operation;
    if (operation.sourceOwnerId !== expected.sourceOwnerId || operation.kind !== expected.kind ||
      operation.idempotencyKey !== expected.idempotencyKey || operation.requestHash !== expected.requestHash) throw unavailable();
    if (outcome.state === "pending_confirmation") throw pending({ operation_kind: operation.kind,
      idempotency_key: operation.idempotencyKey, operation_id: outcome.outcomeId });
    if (outcome.state !== "completed") throw unavailable();
    return outcome.result;
  };
  const operation = async (origin: string, accountId: string, sourceOwnerId: string,
    kind: "attachment_confirm" | "recipient_selection" | "owner_claim", idempotencyKey: string, resourceId: string,
    body: unknown): Promise<ParticipationOperationIdentity> => ({ sourceOwnerId, kind, idempotencyKey,
      // Account alias/authorized host changes do not change a saved credit
      // command's immutable source/body. The native leaf rechecks current actor
      // authority before reconciling the original key. Attachment is instead
      // tied to its explicitly named initiating origin/account/target revision.
      requestHash: await Effect.runPromise(canonicalBodyHash(kind === "attachment_confirm" ? [
        "pirate_owner_attachment_confirm_request_v1", origin, accountId, sourceOwnerId, kind, resourceId, body,
      ] : ["pirate_owner_credit_request_v1", sourceOwnerId, kind, resourceId, body])),
    });
  const locator = (op: ParticipationOperationIdentity): GuestOperationLocatorV1 => ({
    operation_kind: op.kind, idempotency_key: op.idempotencyKey, operation_id: null,
  });
  const attachmentContext = (input: DecodedRequest, expected: AttachmentContext["operation"]): AttachmentContext => {
    const c = input.browserParticipation;
    if (input.principal !== null || c?.authority !== "attachment" || c.operation !== expected ||
        !c.originAndCsrfChecked || !c.accountCsrfChecked || c.selected.state !== "confirmed" ||
        c.access.ownerId !== c.selected.ownerId || c.access.credentialId !== c.selected.credentialId ||
        c.access.origin !== c.origin || c.selected.origin !== c.origin ||
        c.intent.ownerId !== c.selected.ownerId || c.intent.credentialId !== c.selected.credentialId || c.intent.origin !== c.origin ||
        !c.provedCredentials.some(p => p.credentialId === c.selected.credentialId && p.ownerId === c.selected.ownerId && p.state === "confirmed" && p.origin === c.origin) ||
        !c.provedIntents.some(p => p.intentId === c.intent.intentId && p.ownerId === c.intent.ownerId && p.credentialId === c.selected.credentialId && p.origin === c.origin))
      throw unavailable();
    return c;
  };
  const ordinary = (input: DecodedRequest, auth: GuestAccountingAccountAuthority | undefined): Readonly<{ origin: string; account: OrdinaryBrowserAccount }> => {
    if (input.principal !== null || input.browserParticipation !== undefined || auth === undefined || auth.account.kind !== "ordinary_account")
      throw new GuestAuthError({ message: "Ordinary account proof required", details: { reason_code: "account_proof_required" } });
    return { origin: auth.origin, account: auth.account };
  };
  const creditAuthority = async (account: OrdinaryBrowserAccount, creditId: string): Promise<OwnerRewardCreditAuthority> => {
    const found = await run(services.credits.resolveAuthority({ account, creditId }));
    if (found === null) throw new NotFound({ message: "Original owner credit not found" });
    if (found.credit.credit_id !== creditId || found.credit.owner_id !== found.ownerId ||
        (found.kind === "account_owner" ? found.accountId : found.boundAccountId) !== account.accountId) throw unavailable();
    return found;
  };
  return Object.freeze({
    async dispatch(name: GuestAccountingControllerName, input: DecodedRequest,
      auth?: GuestAccountingAccountAuthority): Promise<AccountingResponsePlan> {
      switch (name) {
        case "PrepareGuestAttachmentTargetV1": {
          const c = attachmentContext(input, "prepare_target");
          const path = decode(PrepareGuestAttachmentTargetV1.request.path, input.params);
          if (path.id !== c.intent.intentId) throw conflict("guest_owner_mismatch");
          // SQL owns revision and the digest of its full locked natural tuple. A
          // lost reply cannot invent a locator: retry this exact original intent.
          const outcome = await run(services.attachment.prepareTarget({ context: { ...c, operation: "prepare_target" }, intentId: path.id }));
          if (outcome.operation.sourceOwnerId !== c.selected.ownerId || outcome.operation.kind !== "attachment_prepare") throw unavailable();
          const result = completed(outcome, outcome.operation);
          if (result.intent_id !== path.id || result.account_confirmation.account_id !== c.account.accountId) throw unavailable();
          return new AccountingResponsePlan(name, result);
        }
        case "ConfirmGuestAttachmentTargetV1": {
          const c = attachmentContext(input, "confirm_target");
          const path = decode(ConfirmGuestAttachmentTargetV1.request.path, input.params);
          const body = decode(ConfirmGuestAttachmentTargetV1.request.body, input.body);
          if (path.id !== c.intent.intentId) throw conflict("guest_owner_mismatch");
          if (body.expected_account_id !== c.account.accountId) throw conflict("attachment_target_changed");
          const op = await operation(c.origin, c.account.accountId, c.selected.ownerId,
            "attachment_confirm", `${path.id}:${body.target_revision}`, path.id, body);
          const outcome = await run(services.attachment.confirm({ context: { ...c, operation: "confirm_target" },
            intentId: path.id, expectedAccountId: body.expected_account_id, targetRevision: body.target_revision, operation: op }), locator(op));
          const result = completed(outcome, op);
          if (result.state === "participation_conflict") {
            if (outcome.state !== "completed" || result.outcomeId !== outcome.outcomeId) throw unavailable();
            throw new GuestConflict({ message: "Original participation conflict", details: { reason_code: "participation_conflict", outcome_id: result.outcomeId } });
          }
          if (result.state !== "bound") throw conflict("attachment_target_changed");
          if (result.binding.attachment_id !== path.id || result.binding.owner_id !== c.selected.ownerId || result.binding.account_id !== c.account.accountId) throw unavailable();
          return new AccountingResponsePlan(name, result.binding, c, result.cookieEffects);
        }
        case "GetMySuccessfulGuestAttachmentV1": {
          if (input.principal !== null || input.browserParticipation !== undefined || auth === undefined) throw unavailable();
          const path = decode(GetMySuccessfulGuestAttachmentV1.request.path, input.params);
          const binding = await run(services.attachment.findBoundAttachment({ account: auth.account, attachmentId: path.id }));
          if (binding === null) throw new NotFound({ message: "Original successful attachment not found" });
          // The controlled leaf authorizes today's canonical Account. The
          // immutable receipt retains its original target Account after aliasing;
          // never relabel that original target as today's authenticated actor.
          if (binding.attachment_id !== path.id) throw unavailable();
          return new AccountingResponsePlan(name, binding);
        }
        case "SelectOwnerRewardCreditRecipientV1": {
          const a = ordinary(input, auth);
          const path = decode(SelectOwnerRewardCreditRecipientV1.request.path, input.params);
          const body = decode(SelectOwnerRewardCreditRecipientV1.request.body, input.body);
          const found = await creditAuthority(a.account, path.creditId);
          if (found.kind !== "guest_owner") throw conflict("recipient_selection_conflict");
          const op = await operation(a.origin, a.account.accountId, found.ownerId, "recipient_selection", body.idempotency_key, path.creditId, body);
          const credit = completed(await run(services.recipients.select({ account: a.account, creditId: path.creditId, personaId: body.persona_id, operation: op }), locator(op)), op);
          originalCredit(credit, found.credit);
          if (credit.recipient.kind !== "guest_owner" || credit.recipient.selection === null || credit.recipient.selection.persona_id !== body.persona_id) throw unavailable();
          return new AccountingResponsePlan(name, { selection: credit.recipient.selection, credit });
        }
        case "ClaimOwnerRewardCreditV1": {
          const a = ordinary(input, auth);
          const path = decode(ClaimOwnerRewardCreditV1.request.path, input.params);
          const body = decode(ClaimOwnerRewardCreditV1.request.body, input.body);
          const found = await creditAuthority(a.account, path.creditId);
          if (found.kind === "account_owner" ? body.selection_revision !== null : body.selection_revision === null)
            throw conflict("recipient_selection_conflict");
          // Native command reconciles the original key BEFORE checking today's
          // latest pending selection. A previous unaccepted receipt remains replayable.
          const op = await operation(a.origin, a.account.accountId, found.ownerId, "owner_claim", body.idempotency_key, path.creditId, body);
          const result = completed(await run(services.claims.claim({ account: a.account, creditId: path.creditId, selectionRevision: body.selection_revision, operation: op }), locator(op)), op);
          originalCredit(result.credit, found.credit);
          const recipient = result.credit.recipient;
          if (recipient.kind === "account_owner" ? body.selection_revision !== null :
              recipient.selection?.revision !== body.selection_revision) throw unavailable();
          if (result.outcome === "accepted" && result.credit.claim.status !== "accepted") throw unavailable();
          return new AccountingResponsePlan(name, result);
        }
      }
    },
  });
}

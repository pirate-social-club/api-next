import { expect, test } from "bun:test";
import type { BrowserParticipationContext, DurableParticipationOutcome } from "@pirate/application/guest-participation-authority";
import { GuestParticipationStoreRejected } from "@pirate/application/guest-participation-authority";
import { ControlPlaneTransactionOutcomeUnknown } from "@pirate/application/use-cases/guest-learning";
import { OwnerRewardCreditV1 } from "@pirate/contracts";
import { makeControlPlaneOwnerRecipientStores } from "@pirate/platform-cf/owner-recipient-store";
import { makeDirectPostgresControlPlaneLayer, type PostgresClientLike } from "@pirate/platform-cf/postgres";
import { Effect, Schema } from "effect";
import { makeGuestAccountingControllers, type GuestAccountingControllerServices } from "./guest-accounting-controllers.ts";
import type { DecodedRequest } from "./transport.ts";

const origin = "https://community.example";
const owner = "owner_00000000-0000-0000-0000-000000000001";
const credentialId = "A".repeat(22);
const intentId = `gai_${"B".repeat(21)}A`;
const account = { kind: "ordinary_account", accountId: "account-1", sessionBinding: "b".repeat(64) } as const;
const proof = { credentialId, ownerId: owner, origin, state: "confirmed", leaseUntil: null, pendingExpiresAt: null, predecessorCredentialId: null } as const;
const intent = { intentId, ownerId: owner, credentialId, origin, state: "awaiting_confirmation", expiresAt: "2026-10-14T00:00:00.000Z" } as const;
const context: Extract<BrowserParticipationContext, { authority: "attachment" }> = {
  authority: "attachment", operation: "confirm_target", origin, originAndCsrfChecked: true, accountCsrfChecked: true,
  provedCredentials: [proof], provedIntents: [intent], selected: proof,
  access: { kind: "guest", ownerId: owner, credentialId, origin }, account, intent,
};
const binding = { attachment_id: intentId, owner_id: owner, account_id: account.accountId, state: "bound", bound_at: "2026-10-13T00:00:00.000Z" } as const;
const accountCredit = Schema.decodeUnknownSync(OwnerRewardCreditV1)({
  object: "owner_reward_credit_v1", credit_id: "credit-1", identity_version: "owner_v1", owner_id: owner,
  community_id: "community-1", pool_leg_id: "original-leg", original_drawing_id: "7", chain_id: 1,
  token_address: `0x${"1".repeat(40)}`, token_decimals: 6, amount_atomic: "5", available_atomic: "5", reserved_atomic: "0", paid_atomic: "0",
  source_kind: "megapot_allocation", state: "credited", created_at: "2026-10-13T00:00:00.000Z", updated_at: "2026-10-13T00:00:00.000Z", settled_at: null,
  claim: { status: "accepted", payout_status: "pending" }, send: null,
  recipient: { kind: "account_owner", original_persona_id: "persona-1", selection: null, binding: { persona_id: "persona-1", bound_at: "2026-10-13T00:00:00.000Z", selection_revision: null } },
});
const guestCredit = Schema.decodeUnknownSync(OwnerRewardCreditV1)({ ...accountCredit,
  claim: { status: "unclaimed", payout_status: null },
  recipient: { kind: "guest_owner", selection: { revision: 1, persona_id: "explicit-persona", selected_at: "2026-10-13T00:00:00.000Z" }, binding: null },
});
const unknownCommit = new ControlPlaneTransactionOutcomeUnknown({ phase: "commit", label: "safe-label", limitMs: 3000, elapsedMs: 3001 });
function request(body: unknown = {}, params: unknown = { id: intentId }, browserParticipation?: BrowserParticipationContext): DecodedRequest {
  return { body, params, query: {}, headers: {}, principal: null, ...(browserParticipation === undefined ? {} : { browserParticipation }) };
}
const completed = <const A>(operation: DurableParticipationOutcome<A>["operation"], result: A): DurableParticipationOutcome<A> => ({ state: "completed", operation, outcomeId: "original-command", result });
function fixture(overrides: Partial<GuestAccountingControllerServices> = {}) {
  const selected: Parameters<GuestAccountingControllerServices["recipients"]["select"]>[0][] = [];
  const claimed: Parameters<GuestAccountingControllerServices["claims"]["claim"]>[0][] = [];
  const services: GuestAccountingControllerServices = {
    retryAfterSeconds: 2,
    attachment: {
      prepareTarget: ({ context: c, intentId: id }) => Effect.succeed(completed({ sourceOwnerId: c.selected.ownerId, kind: "attachment_prepare", idempotencyKey: "c".repeat(64), requestHash: "c".repeat(64) },
        { intent_id: id, target_revision: 1, account_confirmation: { account_id: c.account.accountId, display_name: null }, state: "awaiting_confirmation" })),
      confirm: ({ operation }) => Effect.succeed(completed(operation, { state: "bound", binding, cookieEffects: [{ kind: "credential", action: "expire", credentialId }] })),
      findBoundAttachment: () => Effect.succeed(binding),
    },
    credits: { resolveAuthority: () => Effect.succeed({ kind: "guest_owner", ownerId: owner, boundAccountId: account.accountId, credit: guestCredit }) },
    recipients: { select: input => { selected.push(input); return Effect.succeed(completed(input.operation, guestCredit)); } },
    claims: { claim: input => {
      claimed.push(input);
      if (input.selectionRevision !== 1) return Effect.fail(new GuestParticipationStoreRejected({ reason: "recipient-selection-conflict" }));
      return Effect.succeed(completed(input.operation, { outcome: "verification_missing", credit: guestCredit }));
    } },
    ...overrides,
  };
  return { services, controllers: makeGuestAccountingControllers(services), selected, claimed };
}
const confirmInput = () => request({ target_revision: 1, expected_account_id: account.accountId }, { id: intentId }, context);
const headers = () => new Headers({ cookie: `__Host-pirate_guest_${credentialId}=${"A".repeat(43)}` });

test("completed confirm correlates original intent/account/owner before host-only cookie expiry", async () => {
  const f = fixture(); const plan = await f.controllers.dispatch("ConfirmGuestAttachmentTargetV1", confirmInput());
  const result = plan.finalize(headers());
  expect(result.body).toEqual(binding); expect(result.responseHeaders?.get("cache-control")).toBe("private, no-store");
  expect(result.responseHeaders?.get("set-cookie")).toContain(`__Host-pirate_guest_${credentialId}=`);
  expect(result.responseHeaders?.get("set-cookie")).toContain("Max-Age=0");
  expect(JSON.stringify(result.body)).not.toContain(account.sessionBinding);
});
test("foreign confirm body/intent/binding and unproved expire effects yield no response plan/cookies", async () => {
  const f = fixture();
  await expect(f.controllers.dispatch("ConfirmGuestAttachmentTargetV1", request({ target_revision: 1, expected_account_id: "foreign" }, { id: intentId }, context))).rejects.toMatchObject({ details: { reason_code: "attachment_target_changed" } });
  await expect(f.controllers.dispatch("ConfirmGuestAttachmentTargetV1", request(confirmInput().body, { id: `gai_${"C".repeat(21)}A` }, context))).rejects.toMatchObject({ details: { reason_code: "guest_owner_mismatch" } });
  const foreign = fixture({ attachment: { ...f.services.attachment, confirm: ({ operation }) => Effect.succeed(completed(operation, { state: "bound", binding: { ...binding, attachment_id: "foreign" }, cookieEffects: [] })) } });
  await expect(foreign.controllers.dispatch("ConfirmGuestAttachmentTargetV1", confirmInput())).rejects.toMatchObject({ _tag: "InternalError" });
  const effect = fixture({ attachment: { ...f.services.attachment, confirm: ({ operation }) => Effect.succeed(completed(operation, { state: "bound", binding, cookieEffects: [{ kind: "credential", action: "expire", credentialId: `${"Q".repeat(21)}A` }] })) } });
  const plan = await effect.controllers.dispatch("ConfirmGuestAttachmentTargetV1", confirmInput());
  expect(() => plan.finalize(headers())).toThrow();
});
test("confirm unknown COMMIT holds original natural revision key and exposes no binding or cookies", async () => {
  const f = fixture(); const lost = fixture({ attachment: { ...f.services.attachment, confirm: () => Effect.fail(unknownCommit) } });
  await expect(lost.controllers.dispatch("ConfirmGuestAttachmentTargetV1", confirmInput())).rejects.toMatchObject({
    _tag: "GuestPendingConflict", details: { operation: { operation_kind: "attachment_confirm", idempotency_key: `${intentId}:1`, operation_id: null } },
  });
});
test("prepare lost native natural-tuple reply fails closed without invented operation key or cookies", async () => {
  const f = fixture(); const lost = fixture({ attachment: { ...f.services.attachment, prepareTarget: () => Effect.fail(unknownCommit) } });
  await expect(lost.controllers.dispatch("PrepareGuestAttachmentTargetV1", request({}, { id: intentId }, { ...context, operation: "prepare_target" }))).rejects.toMatchObject({ _tag: "InternalError" });
});
test("account-only original successful attachment recovery needs no Guest context/cookie", async () => {
  const f = fixture(); const plan = await f.controllers.dispatch("GetMySuccessfulGuestAttachmentV1", request({}, { id: intentId }), { origin, account });
  expect(plan.finalize(new Headers({ cookie: "__Host-pirate_guest_broken=broken" })).body).toEqual(binding);
});
test("recipient selection derives immutable owner and accepts only explicit persona; replacement draw refused", async () => {
  const f = fixture(); const input = request({ idempotency_key: "selection-original", persona_id: "explicit-persona" }, { creditId: "credit-1" });
  const plan = await f.controllers.dispatch("SelectOwnerRewardCreditRecipientV1", input, { origin, account });
  expect(f.selected[0]?.operation.sourceOwnerId).toBe(owner); expect(f.selected[0]?.personaId).toBe("explicit-persona");
  expect(plan.finalize(new Headers()).body).toEqual({ selection: guestCredit.recipient.kind === "guest_owner" ? guestCredit.recipient.selection : null, credit: guestCredit });
  const changed = fixture({ recipients: { select: i => Effect.succeed(completed(i.operation, { ...guestCredit, original_drawing_id: "8" })) } });
  await expect(changed.controllers.dispatch("SelectOwnerRewardCreditRecipientV1", input, { origin, account })).rejects.toMatchObject({ _tag: "InternalError" });
});
test("owner/account source never comes from a body; setup purpose cannot claim or select", async () => {
  const f = fixture(); const input = request({ idempotency_key: "selection-original", persona_id: "explicit-persona", sourceOwnerId: "foreign" }, { creditId: "credit-1" });
  await expect(f.controllers.dispatch("SelectOwnerRewardCreditRecipientV1", input, { origin, account })).rejects.toMatchObject({ _tag: "GuestBadRequest" });
  const setup = { ...account, kind: "persona_wallet_setup" } as const;
  await expect(f.controllers.dispatch("ClaimOwnerRewardCreditV1", request({ idempotency_key: "claim-original", selection_revision: 1 }, { creditId: "credit-1" }), { origin, account: setup })).rejects.toMatchObject({ details: { reason_code: "account_proof_required" } });
  expect(f.selected).toHaveLength(0); expect(f.claimed).toHaveLength(0);
});
test("native Very nonacceptance is returned truthfully, exact guest revision and Account NULL required", async () => {
  const f = fixture();
  const plan = await f.controllers.dispatch("ClaimOwnerRewardCreditV1", request({ idempotency_key: "claim-original", selection_revision: 1 }, { creditId: "credit-1" }), { origin, account });
  expect(plan.finalize(new Headers()).body).toEqual({ outcome: "verification_missing", credit: guestCredit });
  await expect(f.controllers.dispatch("ClaimOwnerRewardCreditV1", request({ idempotency_key: "claim-original", selection_revision: 2 }, { creditId: "credit-1" }), { origin, account })).rejects.toMatchObject({ details: { reason_code: "recipient_selection_conflict" } });
  const a = fixture({ credits: { resolveAuthority: () => Effect.succeed({ kind: "account_owner", ownerId: owner, accountId: account.accountId, originalPersonaId: "persona-1", credit: accountCredit }) },
    claims: { claim: i => Effect.succeed(completed(i.operation, { outcome: "accepted", credit: accountCredit })) } });
  await expect(a.controllers.dispatch("ClaimOwnerRewardCreditV1", request({ idempotency_key: "claim-original", selection_revision: 1 }, { creditId: "credit-1" }), { origin, account })).rejects.toMatchObject({ details: { reason_code: "recipient_selection_conflict" } });
  const accepted = await a.controllers.dispatch("ClaimOwnerRewardCreditV1", request({ idempotency_key: "claim-original", selection_revision: null }, { creditId: "credit-1" }), { origin, account });
  expect(accepted.finalize(new Headers()).body).toEqual({ outcome: "accepted", credit: accountCredit });
});
test("claim unknown COMMIT retains original key and no fresh claim response; native rejection stays closed", async () => {
  const f = fixture({ claims: { claim: () => Effect.fail(unknownCommit) } });
  await expect(f.controllers.dispatch("ClaimOwnerRewardCreditV1", request({ idempotency_key: "claim-original", selection_revision: 1 }, { creditId: "credit-1" }), { origin, account })).rejects.toMatchObject({ details: { operation: { operation_kind: "owner_claim", idempotency_key: "claim-original", operation_id: null } } });
  const denied = fixture({ credits: { resolveAuthority: () => Effect.fail(new GuestParticipationStoreRejected({ reason: "owner-mismatch" })) } });
  await expect(denied.controllers.dispatch("ClaimOwnerRewardCreditV1", request({ idempotency_key: "claim-original", selection_revision: 1 }, { creditId: "credit-1" }), { origin, account })).rejects.toMatchObject({ details: { reason_code: "guest_owner_mismatch" } });
});

test("original claim receipt replays before a newer pending selection; current revision is not substituted", async () => {
  const newer = Schema.decodeUnknownSync(OwnerRewardCreditV1)({ ...guestCredit,
    recipient: { kind: "guest_owner", selection: { revision: 2, persona_id: "later-persona", selected_at: "2026-10-13T01:00:00.000Z" }, binding: null } });
  const f = fixture({ credits: { resolveAuthority: () => Effect.succeed({ kind: "guest_owner", ownerId: owner, boundAccountId: account.accountId, credit: newer }) } });
  const plan = await f.controllers.dispatch("ClaimOwnerRewardCreditV1", request({ idempotency_key: "claim-original", selection_revision: 1 }, { creditId: "credit-1" }), { origin, account });
  expect(f.claimed[0]?.selectionRevision).toBe(1);
  expect(plan.finalize(new Headers()).body).toEqual({ outcome: "verification_missing", credit: guestCredit });
});

test("actual SDK driver replays saved owner claim under canonical Account/host change; changed original body conflicts", async () => {
  let saved: DurableParticipationOutcome<{ outcome: "verification_missing"; credit: typeof guestCredit }> | null = null;
  let mutationCalls = 0;
  const client: PostgresClientLike = { connect: async () => {}, end: async () => {}, query: async q => {
    if (q.text.startsWith("SELECT resolve_owner_credit_authority_v1")) return { rows: [{ result: {
      kind: "guest_owner", ownerId: owner, boundAccountId: q.values?.[0], credit: guestCredit,
    } }], rowCount: 1 };
    if (q.text.startsWith("SELECT claim_owner_reward_credit_v1")) {
      const key = q.values?.[4], requestHash = q.values?.[5];
      if (typeof key !== "string" || typeof requestHash !== "string") throw new Error("invalid unit driver input");
      if (saved !== null && (saved.operation.idempotencyKey !== key || saved.operation.requestHash !== requestHash))
        throw Object.assign(new Error("original request differs"), { code: "GP005" });
      if (saved === null) {
        mutationCalls++;
        saved = completed({ sourceOwnerId: owner, kind: "owner_claim", idempotencyKey: key, requestHash }, { outcome: "verification_missing", credit: guestCredit });
      }
      return { rows: [{ result: saved }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  } };
  const runtime = makeDirectPostgresControlPlaneLayer("postgres://fixture.invalid/original-owner-claim", { clientFactory: () => client });
  const stores = makeControlPlaneOwnerRecipientStores(runtime);
  const f = fixture({ credits: stores.credits, claims: { claim: stores.claims.claim } });
  const original = request({ idempotency_key: "alias-original", selection_revision: 1 }, { creditId: "credit-1" });
  const first = await f.controllers.dispatch("ClaimOwnerRewardCreditV1", original, { origin, account: { ...account, accountId: "canonical-B" } });
  const replay = await f.controllers.dispatch("ClaimOwnerRewardCreditV1", original, { origin: "https://another-authorized.example", account: { ...account, accountId: "canonical-C", sessionBinding: "c".repeat(64) } });
  expect(replay.finalize(new Headers()).body).toEqual(first.finalize(new Headers()).body);
  expect(mutationCalls).toBe(1);
  await expect(f.controllers.dispatch("ClaimOwnerRewardCreditV1", request({ idempotency_key: "alias-original", selection_revision: 2 }, { creditId: "credit-1" }),
    { origin, account: { ...account, accountId: "canonical-C" } })).rejects.toMatchObject({ details: { reason_code: "idempotency_conflict" } });
  expect(mutationCalls).toBe(1);
});

// PRIVATE TEST PROPOSAL; proposing agent executes no tests or gates.
import { expect, test } from "bun:test";
import {
  type BrowserParticipationContext,
  type GuestAttachmentStore,
  type GuestAuthorityStore,
  GuestParticipationStoreRejected,
  type ParticipationOperationIdentity,
  type ProvedGuestCredential,
} from "@pirate/application/guest-participation-authority";
import { ControlPlaneTransactionOutcomeUnknown } from "@pirate/application/use-cases/guest-learning";
import {
  type GuestAuthorityV1,
  GuestBadRequest,
  GuestConflict,
  GuestPendingConflict,
  InternalError,
} from "@pirate/contracts";
import { digestGuestProof } from "@pirate/platform-cf/guest-proof-crypto";
import { Effect } from "effect";
import {
  GuestAuthorityResponsePlan,
  makeGuestAuthorityControllers,
} from "./guest-authority-controllers.ts";
import type { DecodedRequest } from "./transport.ts";

const origin = "https://community.example";
const ownerId = "owner_00000000-0000-0000-0000-000000000001";
const credentialId = "A".repeat(22);
const successorId = `${"B".repeat(21)}A`;
const secret = "A".repeat(43);
const csrf = `${"C".repeat(42)}A`;
const now = Date.parse("2026-10-12T00:00:00.000Z");
const lease = "2026-10-12T01:00:00.000Z";
const absent: GuestAuthorityV1 = {
  object: "guest_authority",
  state: "absent",
  selected: null,
  pointer_repair: null,
  proved_credentials: [],
};
const proof = {
  ownerId,
  credentialId,
  origin,
  state: "confirmed",
  leaseUntil: lease,
  pendingExpiresAt: null,
  predecessorCredentialId: null,
} as const satisfies ProvedGuestCredential;
const base = {
  origin,
  provedCredentials: [proof],
  provedIntents: [],
  originAndCsrfChecked: true,
} as const;
const recovery = (
  operation: "renew" | "rotate" | "create_attachment_intent",
): BrowserParticipationContext => ({
  ...base,
  authority: "recovery",
  operation,
  selected: proof,
  access: { kind: "guest", ownerId, credentialId, origin },
});
const request = (
  context: BrowserParticipationContext,
  body: unknown = {},
  query: unknown = {},
): DecodedRequest => ({
  principal: null,
  browserParticipation: context,
  body,
  query,
  params: undefined,
});
const headers = (withProof = true) =>
  new Headers({
    origin,
    cookie: `${withProof ? `__Host-pirate_guest_${credentialId}=${secret}; ` : ""}__Host-pirate_guest_csrf=${csrf}`,
  });
const authority = (
  id = credentialId,
  owner = ownerId,
  state: "pending_bootstrap" | "pending_successor" | "confirmed" = "confirmed",
): GuestAuthorityV1 => {
  const selected = {
    owner_id: owner,
    credential_id: id,
    credential_state: state,
    session_until: state === "confirmed" ? lease : null,
  };
  return {
    object: "guest_authority",
    state: state === "confirmed" ? "confirmed" : "pending",
    selected,
    pointer_repair: null,
    proved_credentials: [selected],
  };
};
const unavailable = () =>
  Effect.fail(new GuestParticipationStoreRejected({ reason: "resource-policy-unavailable" }));
function stores(
  overrides: Partial<GuestAuthorityStore> = {},
  intent?: Pick<GuestAttachmentStore, "createIntent">,
) {
  const store: GuestAuthorityStore = {
    discover: () => Effect.succeed(absent),
    issuePending: unavailable,
    confirm: unavailable,
    renew: unavailable,
    issueRotation: unavailable,
    acknowledgeRotation: unavailable,
    cleanup: unavailable,
    ...overrides,
  };
  return makeGuestAuthorityControllers({
    authority: store,
    intent: intent ?? { createIntent: unavailable },
    nowMilliseconds: () => now,
    retryAfterSeconds: 2,
  });
}

test("discovery adds only readable CSRF after accepted metadata; unknown read creates no plan or cookie", async () => {
  const context = {
    origin,
    provedCredentials: [],
    provedIntents: [],
    authority: "bootstrap",
    operation: "discover",
    selected: null,
  } as const;
  const c = stores();
  const plan = await c.dispatch("GetGuestAuthorityV1", request(context));
  const result = await plan.finalize(new Headers());
  expect(result.body).toEqual(absent);
  const response = new Headers(result.responseHeaders);
  expect(response.get("cache-control")).toBe("private, no-store");
  const cookie = response.get("set-cookie") ?? "";
  expect(cookie.startsWith("__Host-pirate_guest_csrf=")).toBe(true);
  expect(cookie.includes("HttpOnly")).toBe(false);
  const failed = stores({
    discover: () =>
      Effect.fail(
        new ControlPlaneTransactionOutcomeUnknown({
          phase: "commit",
          label: "discovery",
          limitMs: 100,
          elapsedMs: 100,
        }),
      ),
  });
  await expect(failed.dispatch("GetGuestAuthorityV1", request(context))).rejects.toBeInstanceOf(
    InternalError,
  );
});

test("fresh bootstrap cookie links exactly to stored digest; repeated key hash excludes fresh IDs/material; lost proof cannot reissue", async () => {
  const context = {
    origin,
    provedCredentials: [],
    provedIntents: [],
    originAndCsrfChecked: true,
    authority: "bootstrap",
    operation: "issue",
    selected: null,
  } as const;
  const operations: ParticipationOperationIdentity[] = [];
  let storedDigest = "";
  let issuedId = "";
  const c = stores({
    issuePending: (input) => {
      operations.push(input.issuance.operation);
      if (operations.length > 1)
        return Effect.fail(
          new GuestParticipationStoreRejected({ reason: "issuance-requires-restart" }),
        );
      storedDigest = input.issuance.tokenDigest;
      issuedId = input.issuance.credentialId;
      expect(input.issuance.pendingExpiresAt).toBe("2026-10-12T00:15:00.000Z");
      return Effect.succeed({
        state: "completed" as const,
        operation: input.issuance.operation,
        outcomeId: "accepted-original",
        result: {
          authority: authority(issuedId, input.newOwnerId, "pending_bootstrap"),
          cookieEffects: [
            { kind: "credential" as const, action: "issue" as const, credentialId: issuedId },
          ],
        },
      });
    },
  });
  const plan = await c.dispatch(
    "IssueGuestBootstrapV1",
    request(context, { idempotency_key: "original-key" }),
  );
  expect(JSON.stringify(plan).includes(storedDigest)).toBe(false);
  const result = await plan.finalize(headers(false));
  const cookie = new Headers(result.responseHeaders).get("set-cookie") ?? "";
  expect(cookie.startsWith(`__Host-pirate_guest_${issuedId}=`)).toBe(true);
  expect(cookie.includes("HttpOnly")).toBe(true);
  expect(cookie.includes("Max-Age=34560000")).toBe(true);
  const rawValue = cookie.slice(cookie.indexOf("=") + 1, cookie.indexOf(";"));
  expect((await digestGuestProof(rawValue)) === storedDigest).toBe(true); // Boolean assertion never prints proof.
  await expect(
    c.dispatch("IssueGuestBootstrapV1", request(context, { idempotency_key: "original-key" })),
  ).rejects.toMatchObject({ details: { reason_code: "issuance_requires_restart" } });
  expect(operations[0]?.requestHash).toBe(operations[1]?.requestHash);
  expect(operations[0]?.sourceOwnerId === operations[1]?.sourceOwnerId).toBe(false);
});

test("unknown writes and committed pending outcomes return exact original locator, never an issuance plan", async () => {
  const context = {
    origin,
    provedCredentials: [],
    provedIntents: [],
    originAndCsrfChecked: true,
    authority: "bootstrap",
    operation: "issue",
    selected: null,
  } as const;
  const c = stores({
    issuePending: () =>
      Effect.fail(
        new ControlPlaneTransactionOutcomeUnknown({
          phase: "commit",
          label: "bootstrap",
          limitMs: 100,
          elapsedMs: 100,
        }),
      ),
  });
  await expect(
    c.dispatch("IssueGuestBootstrapV1", request(context, { idempotency_key: "original-key" })),
  ).rejects.toMatchObject({
    details: {
      operation: {
        operation_kind: "bootstrap_issue",
        idempotency_key: "original-key",
        operation_id: null,
      },
      retry_after_seconds: 2,
    },
  });
  const p = stores({
    issuePending: (input) =>
      Effect.succeed({
        state: "pending_confirmation" as const,
        operation: input.issuance.operation,
        outcomeId: "original-pending",
      }),
  });
  await expect(
    p.dispatch("IssueGuestBootstrapV1", request(context, { idempotency_key: "original-key" })),
  ).rejects.toBeInstanceOf(GuestPendingConflict);
  const wrong = stores({
    issuePending: (input) =>
      Effect.succeed({
        state: "completed" as const,
        operation: { ...input.issuance.operation, requestHash: "b".repeat(64) },
        outcomeId: "wrong",
        result: { authority: authority(), cookieEffects: [] },
      }),
  });
  await expect(
    wrong.dispatch("IssueGuestBootstrapV1", request(context, { idempotency_key: "original-key" })),
  ).rejects.toBeInstanceOf(InternalError);
});

test("rotation issues independent same-owner successor material under the original key without replacing predecessor", async () => {
  let digest = "";
  let successor = "";
  const c = stores({
    issueRotation: (input) => {
      expect(input.context.selected.credentialId).toBe(credentialId);
      expect(input.expectedOwnerId).toBe(ownerId);
      expect(input.issuance.operation.sourceOwnerId).toBe(ownerId);
      expect(input.issuance.operation.kind).toBe("credential_rotate");
      digest = input.issuance.tokenDigest;
      successor = input.issuance.credentialId;
      return Effect.succeed({
        state: "completed" as const,
        operation: input.issuance.operation,
        outcomeId: "rotation-original",
        result: {
          authority: authority(successor, ownerId, "pending_successor"),
          cookieEffects: [
            { kind: "credential" as const, action: "issue" as const, credentialId: successor },
          ],
        },
      });
    },
  });
  const result = await (
    await c.dispatch(
      "RotateGuestCredentialV1",
      request(recovery("rotate"), { idempotency_key: "rotation-key", expected_owner_id: ownerId }),
    )
  ).finalize(headers());
  expect(result.body).toMatchObject({
    selected: {
      owner_id: ownerId,
      credential_id: successor,
      credential_state: "pending_successor",
    },
  });
  const cookie = new Headers(result.responseHeaders).get("set-cookie") ?? "";
  expect(cookie.startsWith(`__Host-pirate_guest_${successor}=`)).toBe(true);
  expect(cookie.includes(`__Host-pirate_guest_${credentialId}=`)).toBe(false);
  expect(digest === (await digestGuestProof(secret))).toBe(false);
});

test("confirm uses natural credential key without cookies; renewal refreshes carried proof and wrong opaque cookie effects fail closed", async () => {
  const pendingProof = {
    ...proof,
    state: "pending_bootstrap",
    leaseUntil: null,
    pendingExpiresAt: "2026-10-12T00:15:00.000Z",
  } as const;
  const context = {
    ...base,
    authority: "bootstrap",
    operation: "confirm",
    selected: pendingProof,
    provedCredentials: [pendingProof],
  } as const;
  const c = stores({
    confirm: (input) => {
      expect(input.credentialId).toBe(credentialId);
      expect(input.expectedOwnerId).toBe(ownerId);
      return Effect.succeed({ authority: authority(), cookieEffects: [] });
    },
    renew: () =>
      Effect.succeed({
        authority: authority(),
        cookieEffects: [{ kind: "credential" as const, action: "refresh" as const, credentialId }],
      }),
  });
  const confirmed = await (
    await c.dispatch(
      "ConfirmGuestBootstrapV1",
      request(context, { credential_id: credentialId, expected_owner_id: ownerId }),
    )
  ).finalize(headers());
  expect(new Headers(confirmed.responseHeaders).has("set-cookie")).toBe(false);
  const renewed = await (
    await c.dispatch(
      "RenewGuestAuthorityV1",
      request(recovery("renew"), { expected_owner_id: ownerId }),
    )
  ).finalize(headers());
  const refresh = new Headers(renewed.responseHeaders).get("set-cookie") ?? "";
  expect(refresh.includes(`=${secret};`)).toBe(true);
  const illegal = new GuestAuthorityResponsePlan({
    name: "RenewGuestAuthorityV1",
    context: recovery("renew"),
    body: authority(),
    effects: [{ kind: "credential", action: "refresh", credentialId: successorId }],
  });
  await expect(illegal.finalize(headers())).rejects.toBeInstanceOf(InternalError);
  const unknown = stores({
    confirm: () =>
      Effect.fail(
        new ControlPlaneTransactionOutcomeUnknown({
          phase: "commit",
          label: "confirm",
          limitMs: 100,
          elapsedMs: 100,
        }),
      ),
  });
  await expect(
    unknown.dispatch(
      "ConfirmGuestBootstrapV1",
      request(context, { credential_id: credentialId, expected_owner_id: ownerId }),
    ),
  ).rejects.toMatchObject({
    details: {
      operation: {
        operation_kind: "bootstrap_confirm",
        idempotency_key: credentialId,
        operation_id: null,
      },
    },
  });
});

test("successor-only acknowledgment expires its exact stored predecessor; replay draws no material and cleanup uses explicit proved candidates", async () => {
  const successor = {
    ...proof,
    credentialId: successorId,
    predecessorCredentialId: credentialId,
    state: "pending_successor",
    leaseUntil: null,
    pendingExpiresAt: "2026-10-12T00:15:00.000Z",
  } as const;
  const context = {
    ...base,
    authority: "recovery",
    operation: "acknowledge",
    selected: successor,
    provedCredentials: [successor],
  } as const;
  let calls = 0;
  const c = stores({
    acknowledgeRotation: () => {
      calls += 1;
      return Effect.succeed({
        authority: authority(successorId),
        cookieEffects:
          calls === 1
            ? [{ kind: "credential" as const, action: "expire" as const, credentialId }]
            : [],
      });
    },
    cleanup: (input) => {
      expect(input.selectedCredentialId).toBeNull();
      expect(input.candidateCredentialIds).toEqual([credentialId]);
      return Effect.succeed({
        authority: {
          ...absent,
          proved_credentials: [
            {
              owner_id: ownerId,
              credential_id: credentialId,
              credential_state: "revoked" as const,
              session_until: lease,
            },
          ],
        },
        cookieEffects: [{ kind: "credential" as const, action: "expire" as const, credentialId }],
      });
    },
  });
  const ackBody = {
    expected_owner_id: ownerId,
    predecessor_credential_id: credentialId,
    successor_credential_id: successorId,
  };
  const onlySuccessor = new Headers({
    cookie: `__Host-pirate_guest_${successorId}=${secret}; __Host-pirate_guest_csrf=${csrf}`,
  });
  const ack = await (
    await c.dispatch("AcknowledgeGuestCredentialV1", request(context, ackBody))
  ).finalize(onlySuccessor);
  expect(
    (new Headers(ack.responseHeaders).get("set-cookie") ?? "").includes(
      `__Host-pirate_guest_${credentialId}=;`,
    ),
  ).toBe(true);
  const replay = await (
    await c.dispatch("AcknowledgeGuestCredentialV1", request(context, ackBody))
  ).finalize(onlySuccessor);
  expect(new Headers(replay.responseHeaders).has("set-cookie")).toBe(false);
  const cleanup = { ...base, authority: "recovery", operation: "cleanup", selected: null } as const;
  const disposed = await (
    await c.dispatch(
      "CleanupGuestBrowserProofV1",
      request(cleanup, {
        selected_credential_id: null,
        candidate_credential_ids: [credentialId],
        candidate_intent_ids: [],
      }),
    )
  ).finalize(headers());
  expect(disposed.body).toMatchObject({
    expired_credential_ids: [credentialId],
    expired_intent_ids: [],
  });
});

test("intent nonce is independently generated; no ambient account is targeted; changed property order keeps operation hash", async () => {
  const seen: ParticipationOperationIdentity[] = [];
  let nonceDigest = "";
  const intent: Pick<GuestAttachmentStore, "createIntent"> = {
    createIntent: (input) => {
      seen.push(input.operation);
      nonceDigest = input.nonceDigest;
      return Effect.succeed({
        state: "completed" as const,
        operation: input.operation,
        outcomeId: "intent-operation",
        result: {
          intent: {
            intent_id: input.intentId,
            expires_at: input.expiresAt,
            state: "awaiting_account" as const,
          },
          cookieEffects: [
            { kind: "intent" as const, action: "issue" as const, intentId: input.intentId },
          ],
        },
      });
    },
  };
  const c = stores({}, intent);
  const first = await c.dispatch(
    "CreateGuestAttachmentIntentV1",
    request(recovery("create_attachment_intent"), {
      expected_owner_id: ownerId,
      idempotency_key: "intent-key",
    }),
  );
  const result = await first.finalize(headers());
  const cookie = new Headers(result.responseHeaders).get("set-cookie") ?? "";
  expect(cookie.includes("__Host-pirate_guest_attach_")).toBe(true);
  expect(cookie.includes("Max-Age=900")).toBe(true);
  expect(JSON.stringify(first).includes(nonceDigest)).toBe(false);
  expect(nonceDigest === (await digestGuestProof(secret))).toBe(false);
  await c.dispatch(
    "CreateGuestAttachmentIntentV1",
    request(recovery("create_attachment_intent"), {
      idempotency_key: "intent-key",
      expected_owner_id: ownerId,
    }),
  );
  expect(seen[0]?.requestHash).toBe(seen[1]?.requestHash);
  await expect(
    c.dispatch(
      "CreateGuestAttachmentIntentV1",
      request(recovery("create_attachment_intent"), {
        idempotency_key: "intent-key",
        expected_owner_id: ownerId,
        account_id: "ambient-account",
      }),
    ),
  ).rejects.toBeInstanceOf(GuestBadRequest);
  await expect(
    c.dispatch(
      "CreateGuestAttachmentIntentV1",
      request(recovery("create_attachment_intent"), {
        idempotency_key: "intent-key",
        expected_owner_id: "different-owner",
      }),
    ),
  ).rejects.toBeInstanceOf(GuestConflict);
  expect(seen).toHaveLength(2);
});

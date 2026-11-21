// PRIVATE TEST PROPOSAL; never executed by the proposing agent.
import { expect, test } from "bun:test";
import type {
  GuestCredentialVerifier,
  ProvedGuestCredential,
  ProvedGuestIntent,
} from "@pirate/application/guest-participation-authority";
import { HNS_FORWARDER_HOST_HEADER } from "@pirate/application/use-cases/hns-browser-transport";
import { PERSONA_WALLET_SETUP_SESSION_SCOPE } from "@pirate/application/use-cases/identity-registration-handler";
import { type BrowserParticipationPolicy, GuestAuthError, InternalError } from "@pirate/contracts";
import { digestGuestProof } from "@pirate/platform-cf/guest-proof-crypto";
import {
  SessionTokenVerificationError,
  type SessionTokenVerifier,
} from "@pirate/platform-cf/session-tokens";
import { Effect } from "effect";
import { makeGuestBrowserRequestAuthenticator } from "./guest-browser-request-authentication.ts";

const origin = "https://community.example";
const ingress = "https://hns-ingress.example";
const ordinaryScope = "pirate-browser-session-v1";
const secret = "A".repeat(43);
const intentSecret = `${"C".repeat(42)}A`;
const csrf = `${"B".repeat(42)}A`;
const credentialId = "A".repeat(22);
const intentId = `gai_${"B".repeat(21)}A`;
const guestCookie = `__Host-pirate_guest_${credentialId}=${secret}`;
const csrfCookie = `__Host-pirate_guest_csrf=${csrf}`;
const policies = {
  discover: { kind: "browserParticipation", authority: "bootstrap", operation: "discover" },
  read: { kind: "browserParticipation", authority: "learning", operation: "read" },
  answer: { kind: "browserParticipation", authority: "learning", operation: "answer" },
  prepare: { kind: "browserParticipation", authority: "attachment", operation: "prepare_target" },
} as const satisfies Record<string, BrowserParticipationPolicy>;

function fixture(
  options: {
    accountFailure?: "invalid_token" | "control_plane_unavailable";
    proofOrigin?: string;
    revoked?: boolean;
  } = {},
) {
  let accountCalls = 0;
  let guestCalls = 0;
  let leaseCalls = 0;
  const proof: ProvedGuestCredential = {
    credentialId,
    ownerId: "original-owner",
    origin: options.proofOrigin ?? origin,
    state: options.revoked ? "revoked" : "confirmed",
    leaseUntil: "2026-10-12T12:00:00.000Z",
    pendingExpiresAt: null,
    predecessorCredentialId: null,
  };
  const intent: ProvedGuestIntent = {
    intentId,
    ownerId: proof.ownerId,
    credentialId,
    origin: proof.origin,
    state: "awaiting_account",
    expiresAt: "2026-10-12T12:15:00.000Z",
  };
  const guestVerifier: GuestCredentialVerifier = {
    verify: (input) =>
      Effect.promise(async () => {
        guestCalls += 1;
        const digest = await digestGuestProof(secret);
        const intentDigest = await digestGuestProof(intentSecret);
        return {
          origin: input.origin,
          provedCredentials: input.credentialProofs.some(
            (p) => p.credentialId === credentialId && p.digest === digest,
          )
            ? [proof]
            : [],
          provedIntents: input.intentProofs.some(
            (p) => p.intentId === intentId && p.digest === intentDigest,
          )
            ? [intent]
            : [],
        };
      }),
  };
  const verifier: SessionTokenVerifier = {
    verify: ({ token, requiredClassification }) => {
      accountCalls += 1;
      expect(requiredClassification).toBe("user");
      if (options.accountFailure)
        return Effect.fail(new SessionTokenVerificationError({ code: options.accountFailure }));
      const scope =
        token === "setup"
          ? PERSONA_WALLET_SETUP_SESSION_SCOPE
          : token === "other-user-purpose"
            ? "other"
            : ordinaryScope;
      return Effect.succeed({
        userId: "canonical-account",
        classification: "user" as const,
        scope: { value: scope, tokens: [scope] },
        canonical: {
          sourceUserId: "source-account",
          canonicalUserId: "canonical-account",
          aliasPath: ["source-account", "canonical-account"],
        },
      });
    },
  };
  const services = {
    verifier: guestVerifier,
    isLearningLeaseActive: async () => {
      leaseCalls += 1;
      return true;
    },
    accountVerifier: verifier,
    ordinarySessionScope: ordinaryScope,
    ordinaryProductOrigin: origin,
    hnsProtectedIngressOrigin: ingress,
  };
  const auth = makeGuestBrowserRequestAuthenticator(services);
  const request = (
    extra: Record<string, string> = {},
    token: string | null = null,
    productOrigin = origin,
    url = "https://api.example/guest/authority",
  ) => {
    const cookies = [
      guestCookie,
      csrfCookie,
      token === null ? "" : `__Host-pirate_session=${token}; __Host-pirate_csrf=account-csrf`,
    ]
      .filter(Boolean)
      .join("; ");
    return new Request(url, {
      method: "POST",
      headers: {
        origin: productOrigin,
        cookie: cookies,
        "x-guest-csrf-token": csrf,
        "x-csrf-token": "account-csrf",
        ...extra,
      },
    });
  };
  return { auth, request, services, counts: () => ({ accountCalls, guestCalls, leaseCalls }) };
}

test("header Origin/CSRF/Authorization refusal precedes every verifier and any body read", async () => {
  for (const extra of [
    { origin: "https://name.example" },
    { "x-guest-csrf-token": "wrong" },
    { authorization: "" },
  ]) {
    const f = fixture();
    let pulled = false;
    const source = f.request(extra, "ordinary");
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.error(new Error("must remain unread"));
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request(source.url, {
      method: "POST",
      headers: source.headers,
      body,
      duplex: "half",
    });
    await expect(f.auth.authenticate({ request, policy: policies.prepare })).rejects.toBeInstanceOf(
      GuestAuthError,
    );
    expect(f.counts()).toEqual({ accountCalls: 0, guestCalls: 0, leaseCalls: 0 });
    expect(pulled).toBe(false);
  }
});

test("guest-only controls ignore invalid ambient ordinary cookies and never verify them", async () => {
  for (const raw of [
    "__Host-pirate_session",
    "__Host-pirate_session=%not-a-value",
    "__Host-pirate_session=bad; __Host-pirate_session=duplicate",
    "__Host-pirate_renewal=%not-a-value",
    "__Host-pirate_renewal=first; __Host-pirate_renewal=second",
  ]) {
    const f = fixture({ accountFailure: "invalid_token" });
    const request = f.request({ cookie: `${guestCookie}; ${csrfCookie}; ${raw}` });
    await expect(
      f.auth.authenticate({ request, policy: policies.discover }),
    ).resolves.toMatchObject({ selected: { ownerId: "original-owner" } });
    expect(f.counts().accountCalls).toBe(0);
  }
});

test("attachment refuses malformed or duplicate renewal cookies before verifying ordinary account authority", async () => {
  for (const raw of [
    "__Host-pirate_renewal",
    "__Host-pirate_renewal=%not-a-value",
    "__Host-pirate_renewal=first; __Host-pirate_renewal=second",
  ]) {
    const f = fixture();
    const cookie = `${guestCookie}; ${csrfCookie}; __Host-pirate_guest_attach_${intentId.slice(4)}=${intentSecret}; __Host-pirate_session=ordinary; __Host-pirate_csrf=account-csrf; ${raw}`;
    await expect(
      f.auth.authenticate({ request: f.request({ cookie }), policy: policies.prepare }),
    ).rejects.toMatchObject({ details: { reason_code: "account_proof_required" } });
    expect(f.counts()).toEqual({ accountCalls: 0, guestCalls: 0, leaseCalls: 0 });
  }
});

test("explicit revoked/missing guest selection never falls back to an ordinary account", async () => {
  const f = fixture({ revoked: true });
  await expect(
    f.auth.authenticate({
      request: f.request({ "x-guest-credential-id": credentialId }, "ordinary"),
      policy: policies.read,
    }),
  ).rejects.toMatchObject({ details: { reason_code: "guest_proof_revoked" } });
  expect(f.counts().accountCalls).toBe(0);
  const missing = `${"C".repeat(21)}A`;
  await expect(
    f.auth.authenticate({
      request: f.request({ "x-guest-credential-id": missing }, "ordinary"),
      policy: policies.read,
    }),
  ).rejects.toMatchObject({ details: { reason_code: "guest_proof_required" } });
  expect(f.counts().accountCalls).toBe(0);
});

test("mixed account purpose is verified exactly, with session binding scoped to origin and exact verified token", async () => {
  const f = fixture();
  const first = await f.auth.authenticate({
    request: f.request({}, "ordinary"),
    policy: policies.read,
  });
  const replay = await f.auth.authenticate({
    request: f.request({}, "ordinary"),
    policy: policies.read,
  });
  const changed = await f.auth.authenticate({
    request: f.request({}, "ordinary-replacement"),
    policy: policies.read,
  });
  expect(first).toMatchObject({ access: { kind: "account", accountId: "canonical-account" } });
  if (
    !("access" in first) ||
    !("sessionBinding" in first.access) ||
    !("access" in replay) ||
    !("sessionBinding" in replay.access) ||
    !("access" in changed) ||
    !("sessionBinding" in changed.access)
  )
    throw new Error("account binding absent");
  expect(first.access.sessionBinding).toMatch(/^[0-9a-f]{64}$/u);
  expect(first.access.sessionBinding).toBe(replay.access.sessionBinding);
  expect(first.access.sessionBinding).not.toBe(changed.access.sessionBinding);
  expect(JSON.stringify(first)).not.toContain("ordinary");
  expect(JSON.stringify(first)).not.toContain(secret);
  const hns = fixture({ proofOrigin: "https://name.example" });
  const renamed = await hns.auth.authenticate({
    request: hns.request({}, "ordinary", "https://name.example", `${ingress}/api/guest/authority`),
    policy: policies.read,
    verifiedHns: { normalized_host: "name.example", exact_origin: "https://name.example" },
  });
  if (!("access" in renamed) || !("sessionBinding" in renamed.access))
    throw new Error("account binding absent");
  expect(renamed.access.sessionBinding).not.toBe(first.access.sessionBinding);
  for (const token of ["setup", "other-user-purpose"]) {
    const guest = await f.auth.authenticate({
      request: f.request({}, token),
      policy: policies.read,
    });
    expect(guest).toMatchObject({ access: { kind: "guest" } });
  }
});

test("verified setup purpose is only attachment authority and cannot substitute for guest proof/intent", async () => {
  for (const token of ["ordinary", "setup"]) {
    const f = fixture();
    const result = await f.auth.authenticate({
      request: f.request(
        {
          cookie: `${guestCookie}; ${csrfCookie}; __Host-pirate_guest_attach_${intentId.slice(4)}=${intentSecret}; __Host-pirate_session=${token}; __Host-pirate_csrf=account-csrf`,
        },
        token,
      ),
      policy: policies.prepare,
    });
    expect(result).toMatchObject({
      authority: "attachment",
      account: {
        kind: token === "setup" ? "persona_wallet_setup" : "ordinary_account",
        accountId: "canonical-account",
      },
      accountCsrfChecked: true,
    });
    await expect(
      f.auth.authenticate({ request: f.request({}, token), policy: policies.prepare }),
    ).rejects.toMatchObject({ details: { reason_code: "guest_proof_required" } });
  }
});

test("account CSRF refusal happens before guest digest/verifier; invalid sessions do not grant account access", async () => {
  const f = fixture();
  await expect(
    f.auth.authenticate({
      request: f.request({ "x-csrf-token": "wrong" }, "ordinary"),
      policy: policies.answer,
    }),
  ).rejects.toMatchObject({ details: { reason_code: "guest_origin_or_csrf_invalid" } });
  expect(f.counts()).toEqual({ accountCalls: 1, guestCalls: 0, leaseCalls: 0 });
  const invalid = fixture({ accountFailure: "invalid_token" });
  await expect(
    invalid.auth.authenticate({ request: invalid.request({}, "invalid"), policy: policies.read }),
  ).resolves.toMatchObject({ access: { kind: "guest" } });
  const unavailable = fixture({ accountFailure: "control_plane_unavailable" });
  await expect(
    unavailable.auth.authenticate({
      request: unavailable.request({}, "ordinary"),
      policy: policies.read,
    }),
  ).rejects.toBeInstanceOf(InternalError);
  expect(unavailable.counts().guestCalls).toBe(0);
});

test("only exact configured ordinary origin or actual verified HNS metadata can scope proofs", async () => {
  const f = fixture();
  await expect(
    f.auth.authenticate({
      request: f.request({}, null, origin, `${ingress}/api/guest/authority`),
      policy: policies.discover,
    }),
  ).rejects.toBeInstanceOf(GuestAuthError);
  await expect(
    f.auth.authenticate({
      request: f.request({}, null, origin),
      policy: policies.discover,
      verifiedHns: { normalized_host: "community.example", exact_origin: origin },
    }),
  ).rejects.toBeInstanceOf(GuestAuthError);
  await expect(
    f.auth.authenticate({
      request: f.request({}, null, "https://name.example", `${ingress}/api/guest/authority`),
      policy: policies.discover,
      verifiedHns: { normalized_host: "name.example", exact_origin: origin },
    }),
  ).rejects.toBeInstanceOf(GuestAuthError);
  expect(f.counts()).toEqual({ accountCalls: 0, guestCalls: 0, leaseCalls: 0 });
});

test("ordinary product origin is one exact HTTPS origin and setup scope cannot masquerade as ordinary", () => {
  const f = fixture();
  for (const ordinaryProductOrigin of [
    "*",
    "https://*.example",
    "https://one.example,https://two.example",
    "http://community.example",
    `${origin}/`,
  ])
    expect(() =>
      makeGuestBrowserRequestAuthenticator({ ...f.services, ordinaryProductOrigin }),
    ).toThrow();
  expect(() =>
    makeGuestBrowserRequestAuthenticator({
      ...f.services,
      ordinarySessionScope: PERSONA_WALLET_SETUP_SESSION_SCOPE,
    }),
  ).toThrow();
});

test("HNS refusal-only preflight checks verified account purpose CSRF before MAC body work, never mints context", async () => {
  const f = fixture();
  const request = f.request(
    { [HNS_FORWARDER_HOST_HEADER]: "community.example", "x-csrf-token": "wrong" },
    "ordinary",
    origin,
    `${ingress}/api/guest/authority`,
  );
  await expect(
    f.auth.precheckHnsBeforeBody({ request, policy: policies.answer }),
  ).rejects.toMatchObject({ details: { reason_code: "guest_origin_or_csrf_invalid" } });
  expect(f.counts()).toEqual({ accountCalls: 1, guestCalls: 0, leaseCalls: 0 });
  const invalid = fixture({ accountFailure: "invalid_token" });
  const ignored = invalid.request(
    { [HNS_FORWARDER_HOST_HEADER]: "community.example", "x-csrf-token": "wrong" },
    "invalid",
    origin,
    `${ingress}/api/guest/authority`,
  );
  expect(
    await invalid.auth.precheckHnsBeforeBody({ request: ignored, policy: policies.answer }),
  ).toBeUndefined();
  expect(invalid.counts()).toEqual({ accountCalls: 1, guestCalls: 0, leaseCalls: 0 });
  const selected = fixture();
  const explicit = selected.request(
    {
      [HNS_FORWARDER_HOST_HEADER]: "community.example",
      "x-guest-credential-id": credentialId,
      "x-csrf-token": "wrong",
    },
    "ordinary",
    origin,
    `${ingress}/api/guest/authority`,
  );
  expect(
    await selected.auth.precheckHnsBeforeBody({ request: explicit, policy: policies.answer }),
  ).toBeUndefined();
  expect(selected.counts()).toEqual({ accountCalls: 0, guestCalls: 0, leaseCalls: 0 });
});

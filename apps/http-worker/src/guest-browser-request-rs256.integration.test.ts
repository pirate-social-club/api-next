// PRIVATE TEST PROPOSAL. No gate executed by this author; no provider keys used.
// Intended placement apps/http-worker/src, after actual request factory adoption.
import { expect, test } from "bun:test";
import type {
  GuestCredentialVerifier,
  ProvedGuestCredential,
  ProvedGuestIntent,
} from "@pirate/application/guest-participation-authority";
import {
  ControlPlaneAcquireFailed,
  IdentityResolutionError,
  type IdentityStore,
} from "@pirate/application/use-cases/guest-learning";
import { PERSONA_WALLET_SETUP_SESSION_SCOPE } from "@pirate/application/use-cases/identity-registration-handler";
import { type BrowserParticipationPolicy, GuestAuthError, InternalError } from "@pirate/contracts";
import { digestGuestProof } from "@pirate/platform-cf/guest-proof-crypto";
import { makeSessionCrypto } from "@pirate/platform-cf/session-crypto";
import { makeRs256SessionTokenVerifier } from "@pirate/platform-cf/session-tokens";
import { Effect } from "effect";
import { makeGuestBrowserRequestAuthenticator } from "./guest-browser-request-authentication.ts";

const productOrigin = "https://community.example";
const ordinaryScope = "ordinary-browser-fixture-v1";
const otherUserScope = "future-other-user-purpose-v1";
const now = 1_797_000_000;
const credentialId = "A".repeat(22);
const intentId = `gai_${"B".repeat(21)}A`;
const guestSecret = "A".repeat(43);
const intentSecret = `${"C".repeat(42)}A`;
const csrf = `${"B".repeat(42)}A`;
const policies = {
  read: { kind: "browserParticipation", authority: "learning", operation: "read" },
  prepare: { kind: "browserParticipation", authority: "attachment", operation: "prepare_target" },
} as const satisfies Record<string, BrowserParticipationPolicy>;

function pem(bytes: ArrayBuffer, label: "PRIVATE KEY" | "PUBLIC KEY"): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  const lines = btoa(binary).match(/.{1,64}/gu);
  if (lines === null) throw new Error("disposable key encoding unavailable");
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

async function fixture() {
  // Disposable pair stays in this fixture's memory. No key/token/URL is printed,
  // persisted, exported as evidence or taken from environment/provider bindings.
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const privateKeyPem = pem(await crypto.subtle.exportKey("pkcs8", pair.privateKey), "PRIVATE KEY");
  const publicKeyPem = pem(await crypto.subtle.exportKey("spki", pair.publicKey), "PUBLIC KEY");
  const options = {
    privateKeyPem,
    publicKeyPem,
    issuer: "issuer-fixture",
    audience: "audience-fixture",
    defaultScope: ordinaryScope,
    defaultTtlSeconds: 300,
    nowSeconds: () => now,
  };
  const sessionCrypto = await makeSessionCrypto(options);
  const guestDigest = await digestGuestProof(guestSecret);
  const nonceDigest = await digestGuestProof(intentSecret);
  let identityCalls = 0;
  let guestCalls = 0;
  let identityFailure: "missing" | "invalid" | "unavailable" | null = null;
  const identity: Pick<IdentityStore["Service"], "resolveCanonical"> = {
    resolveCanonical: ({ sourceUserId }) => {
      identityCalls += 1;
      if (identityFailure === "missing" || identityFailure === "invalid")
        return Effect.fail(new IdentityResolutionError({ reason: identityFailure }));
      if (identityFailure === "unavailable")
        return Effect.fail(
          new ControlPlaneAcquireFailed({ phase: "connection", limitMs: 10, elapsedMs: 10 }),
        );
      return Effect.succeed({
        sourceUserId,
        canonicalUserId: "canonical-account",
        aliasPath: [sourceUserId, "canonical-account"],
      });
    },
  };
  const accountVerifier = makeRs256SessionTokenVerifier(sessionCrypto, identity, {
    additionalUserScopes: [PERSONA_WALLET_SETUP_SESSION_SCOPE, otherUserScope],
  });
  const proof: ProvedGuestCredential = {
    ownerId: "original-guest-owner",
    credentialId,
    origin: productOrigin,
    state: "confirmed",
    leaseUntil: "2026-10-12T23:00:00.000Z",
    pendingExpiresAt: null,
    predecessorCredentialId: null,
  };
  const intent: ProvedGuestIntent = {
    intentId,
    ownerId: proof.ownerId,
    credentialId,
    origin: productOrigin,
    state: "awaiting_account",
    expiresAt: "2026-10-12T23:15:00.000Z",
  };
  const verifier: GuestCredentialVerifier = {
    verify: (input) => {
      guestCalls += 1;
      return Effect.succeed({
        origin: input.origin,
        provedCredentials: input.credentialProofs.some(
          (p) => p.credentialId === credentialId && p.digest === guestDigest,
        )
          ? [proof]
          : [],
        provedIntents: input.intentProofs.some(
          (p) => p.intentId === intentId && p.digest === nonceDigest,
        )
          ? [intent]
          : [],
      });
    },
  };
  const auth = makeGuestBrowserRequestAuthenticator({
    verifier,
    isLearningLeaseActive: async () => true,
    accountVerifier,
    ordinarySessionScope: sessionCrypto.defaultScope,
    ordinaryProductOrigin: productOrigin,
  });
  const request = (token: string, withIntent = false, withGuest = true) =>
    new Request("https://worker.example/guest/authority", {
      method: "POST",
      headers: {
        origin: productOrigin,
        "x-guest-csrf-token": csrf,
        "x-csrf-token": "account-csrf",
        cookie: [
          withGuest ? `__Host-pirate_guest_${credentialId}=${guestSecret}` : "",
          `__Host-pirate_guest_csrf=${csrf}`,
          withIntent ? `__Host-pirate_guest_attach_${intentId.slice(4)}=${intentSecret}` : "",
          `__Host-pirate_session=${token}`,
          "__Host-pirate_csrf=account-csrf",
        ]
          .filter(Boolean)
          .join("; "),
      },
    });
  return {
    options,
    sessionCrypto,
    accountVerifier,
    auth,
    request,
    counts: () => ({ identityCalls, guestCalls }),
    setIdentityFailure: (value: typeof identityFailure) => {
      identityFailure = value;
    },
  };
}

test("actual RS256 PEM/sign/verify and canonical lookup supply exact ordinary versus setup purpose", async () => {
  const f = await fixture();
  const ordinary = await f.sessionCrypto.sign({ sub: "source-account", scope: ordinaryScope });
  const setup = await f.sessionCrypto.sign({
    sub: "source-account",
    scope: PERSONA_WALLET_SETUP_SESSION_SCOPE,
  });
  const other = await f.sessionCrypto.sign({ sub: "source-account", scope: otherUserScope });
  const verified = await Effect.runPromise(
    f.accountVerifier.verify({ token: ordinary, requiredClassification: "user" }),
  );
  expect({
    classification: verified.classification,
    scope: verified.scope.value,
    userId: verified.userId,
  }).toEqual({ classification: "user", scope: ordinaryScope, userId: "canonical-account" });
  const result = await f.auth.authenticate({ request: f.request(ordinary), policy: policies.read });
  expect(result).toMatchObject({ access: { kind: "account", accountId: "canonical-account" } });
  expect(JSON.stringify(result).includes(ordinary)).toBe(false);
  expect(JSON.stringify(result).includes(guestSecret)).toBe(false);
  if (!("access" in result) || !("sessionBinding" in result.access))
    throw new Error("account binding absent");
  expect(result.access.sessionBinding).toMatch(/^[0-9a-f]{64}$/u);
  for (const token of [setup, other]) {
    expect(
      await f.auth.authenticate({ request: f.request(token), policy: policies.read }),
    ).toMatchObject({ access: { kind: "guest" } });
  }
  const prepared = await f.auth.authenticate({
    request: f.request(setup, true),
    policy: policies.prepare,
  });
  expect(prepared).toMatchObject({
    account: { kind: "persona_wallet_setup", accountId: "canonical-account" },
    operation: "prepare_target",
  });
  const ordinaryPrepared = await f.auth.authenticate({
    request: f.request(ordinary, true),
    policy: policies.prepare,
  });
  expect(ordinaryPrepared).toMatchObject({ account: { kind: "ordinary_account" } });
  await expect(
    f.auth.authenticate({ request: f.request(other, true), policy: policies.prepare }),
  ).rejects.toMatchObject({ details: { reason_code: "account_proof_required" } });
}, 30_000);

test("tampered or validly signed wrong issuer/audience/expired sessions never supply account fallback; valid guest proof remains independent", async () => {
  const f = await fixture();
  const ordinary = await f.sessionCrypto.sign({ sub: "source-account", scope: ordinaryScope });
  const parts = ordinary.split(".");
  if (parts.length !== 3 || !parts[2]) throw new Error("synthetic signed token shape unavailable");
  const tampered = `${parts[0]}.${parts[1]}.${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
  const wrongIssuer = await makeSessionCrypto({ ...f.options, issuer: "wrong-issuer" });
  const wrongAudience = await makeSessionCrypto({ ...f.options, audience: "wrong-audience" });
  const tokens = [
    tampered,
    await wrongIssuer.sign({ sub: "source-account", scope: ordinaryScope }),
    await wrongAudience.sign({ sub: "source-account", scope: ordinaryScope }),
    await f.sessionCrypto.sign({
      sub: "source-account",
      scope: ordinaryScope,
      iat: now - 60,
      exp: now - 1,
    }),
  ];
  for (const token of tokens) {
    const before = f.counts();
    const result = await f.auth.authenticate({ request: f.request(token), policy: policies.read });
    expect(result).toMatchObject({ access: { kind: "guest", ownerId: "original-guest-owner" } });
    expect(f.counts().identityCalls).toBe(before.identityCalls); // crypto rejects before canonical lookup
    await expect(
      f.auth.authenticate({ request: f.request(token, false, false), policy: policies.read }),
    ).rejects.toBeInstanceOf(GuestAuthError);
    await expect(
      f.auth.authenticate({ request: f.request(token, true), policy: policies.prepare }),
    ).rejects.toMatchObject({ details: { reason_code: "account_proof_required" } });
  }
  const valid = await f.auth.authenticate({ request: f.request(ordinary), policy: policies.read });
  expect(valid).toMatchObject({ access: { kind: "account", accountId: "canonical-account" } });
  for (const failure of ["missing", "invalid"] as const) {
    f.setIdentityFailure(failure);
    const before = f.counts().identityCalls;
    expect(
      await f.auth.authenticate({ request: f.request(ordinary), policy: policies.read }),
    ).toMatchObject({ access: { kind: "guest" } });
    expect(f.counts().identityCalls).toBe(before + 1); // actual verified token reaches canonical authority
    await expect(
      f.auth.authenticate({ request: f.request(ordinary, true), policy: policies.prepare }),
    ).rejects.toMatchObject({ details: { reason_code: "account_proof_required" } });
  }
  f.setIdentityFailure("unavailable");
  const beforeGuest = f.counts().guestCalls;
  await expect(
    f.auth.authenticate({ request: f.request(ordinary), policy: policies.read }),
  ).rejects.toBeInstanceOf(InternalError);
  expect(f.counts().guestCalls).toBe(beforeGuest);
}, 30_000);

import { expect, test } from "bun:test";
import type {
  GuestCredentialVerifier,
  ProvedGuestCredential,
  ProvedGuestIntent,
} from "@pirate/application/guest-participation-authority";
import {
  type BrowserParticipationOperation,
  GuestAuthError,
  GuestConflict,
} from "@pirate/contracts";
import { digestGuestProof } from "@pirate/platform-cf/guest-proof-crypto";
import { Effect } from "effect";
import { makeGuestBrowserAuthenticationAdapter } from "./guest-browser-authentication.ts";

const origin = "https://community.example";
const secret = "A".repeat(43);
const csrf = `${"B".repeat(42)}A`;
const credentialId = "A".repeat(22);
const digest = await digestGuestProof(secret);
const proof: ProvedGuestCredential = {
  ownerId: "owner-original",
  credentialId,
  origin,
  state: "confirmed",
  // Deliberately old metadata: only the injected database observation decides the lease.
  leaseUntil: "2020-01-01T00:00:00.000Z",
  pendingExpiresAt: null,
  predecessorCredentialId: null,
};

function fixture(
  options: {
    credentials?: readonly ProvedGuestCredential[];
    intents?: readonly ProvedGuestIntent[];
    active?: boolean;
  } = {},
) {
  let verified = 0;
  let leaseChecks = 0;
  let accountCsrfChecks = 0;
  const verifier: GuestCredentialVerifier = {
    verify: (input) => {
      verified += 1;
      return Effect.succeed({
        origin: input.origin,
        provedCredentials: (options.credentials ?? [proof]).filter((c) =>
          input.credentialProofs.some(
            (p) => p.credentialId === c.credentialId && p.digest === digest,
          ),
        ),
        provedIntents: (options.intents ?? []).filter((i) =>
          input.intentProofs.some((p) => p.intentId === i.intentId && p.digest === digest),
        ),
      });
    },
  };
  const adapter = makeGuestBrowserAuthenticationAdapter({
    verifier,
    isLearningLeaseActive: async () => {
      leaseChecks += 1;
      return options.active ?? true;
    },
    assertAccountCsrf: (headers, trustedOrigin) => {
      accountCsrfChecks += 1;
      if (headers.get("x-csrf-token") !== "account-csrf" || trustedOrigin !== origin)
        throw new GuestAuthError({
          message: "Account CSRF refused",
          details: { reason_code: "guest_origin_or_csrf_invalid" },
        });
    },
  });
  const input = (operation: BrowserParticipationOperation, extra: Record<string, string> = {}) => ({
    policy: { kind: "browserParticipation" as const, ...operation },
    trustedProductOrigin: origin,
    requestHeaders: new Headers({
      origin,
      cookie: `__Host-pirate_guest_${credentialId}=${secret}; __Host-pirate_guest_csrf=${csrf}`,
      "x-guest-csrf-token": csrf,
      ...extra,
    }),
    selectedCredentialId: credentialId as string | null,
    account: null,
  });
  return { adapter, input, counts: () => ({ verified, leaseChecks, accountCsrfChecks }) };
}

test("account-free learning requires proved origin and database lease; context has no secret/digest", async () => {
  const f = fixture();
  const result = await f.adapter.authenticate(
    f.input({ authority: "learning", operation: "start" }),
  );
  expect(result.authority).toBe("learning");
  expect(result).toMatchObject({
    access: { kind: "guest", ownerId: "owner-original" },
    originAndCsrfChecked: true,
  });
  expect(f.counts()).toEqual({ verified: 1, leaseChecks: 1, accountCsrfChecks: 0 });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain(digest);
});

test("expired database lease blocks learning but preserves deliberate recovery", async () => {
  const f = fixture({ active: false });
  await expect(
    f.adapter.authenticate(f.input({ authority: "learning", operation: "start" })),
  ).rejects.toMatchObject({ details: { reason_code: "guest_learning_lease_expired" } });
  await expect(
    f.adapter.authenticate(f.input({ authority: "recovery", operation: "renew" })),
  ).resolves.toMatchObject({ access: { kind: "guest" } });
  expect(f.counts().leaseChecks).toBe(1);
});

test("Authorization presence, forged origin and guest CSRF reject before verifier", async () => {
  for (const headers of [
    { authorization: "" },
    { origin: "https://name.example" },
    { "x-guest-csrf-token": "wrong" },
  ]) {
    const f = fixture();
    await expect(
      f.adapter.authenticate(f.input({ authority: "learning", operation: "start" }, headers)),
    ).rejects.toBeInstanceOf(GuestAuthError);
    expect(f.counts().verified).toBe(0);
  }
});

test("revoked selected proof never becomes account authority", async () => {
  const f = fixture({ credentials: [{ ...proof, state: "revoked" }] });
  const input = {
    ...f.input({ authority: "learning", operation: "read" }),
    account: { kind: "ordinary_account" as const, accountId: "account", sessionBinding: "binding" },
  };
  await expect(f.adapter.authenticate(input)).rejects.toMatchObject({
    details: { reason_code: "guest_proof_revoked" },
  });
  await expect(
    f.adapter.authenticate({ ...input, requestHeaders: new Headers({ cookie: "" }) }),
  ).rejects.toMatchObject({ details: { reason_code: "guest_proof_required" } });
});

test("mixed account access checks both CSRF proofs; setup scope grants no account learning access", async () => {
  const f = fixture();
  const input = {
    ...f.input(
      { authority: "learning", operation: "answer" },
      { cookie: `__Host-pirate_guest_csrf=${csrf}` },
    ),
    selectedCredentialId: null,
    account: { kind: "ordinary_account" as const, accountId: "account", sessionBinding: "binding" },
  };
  await expect(f.adapter.authenticate(input)).rejects.toBeInstanceOf(GuestAuthError);
  input.requestHeaders.set("x-csrf-token", "account-csrf");
  await expect(f.adapter.authenticate(input)).resolves.toMatchObject({
    access: { kind: "account" },
  });
  await expect(
    f.adapter.authenticate({
      ...input,
      account: { ...input.account, kind: "persona_wallet_setup" },
    }),
  ).rejects.toMatchObject({ details: { reason_code: "guest_proof_required" } });
});

test("discovery keeps multiple owners unselected; mutation refuses implicit owner choice", async () => {
  const secondId = `${"B".repeat(21)}A`;
  const f = fixture({
    credentials: [proof, { ...proof, ownerId: "owner-other", credentialId: secondId }],
  });
  const input = {
    ...f.input({ authority: "bootstrap", operation: "discover" }),
    selectedCredentialId: null,
  };
  input.requestHeaders.set(
    "cookie",
    `__Host-pirate_guest_${credentialId}=${secret}; __Host-pirate_guest_${secondId}=${secret}; __Host-pirate_guest_csrf=${csrf}`,
  );
  await expect(f.adapter.authenticate(input)).resolves.toMatchObject({
    selected: null,
    provedCredentials: expect.arrayContaining([{ ...proof }]),
  });
  await expect(
    f.adapter.authenticate({
      ...input,
      policy: { kind: "browserParticipation", authority: "recovery", operation: "renew" },
    }),
  ).rejects.toBeInstanceOf(GuestConflict);
});

test("discovery delegates same-owner confirmed and pending ambiguity to the store", async () => {
  const secondId = `${"B".repeat(21)}A`;
  for (const state of ["confirmed", "pending_bootstrap"] as const) {
    const f = fixture({
      credentials: [
        { ...proof, state },
        { ...proof, state, credentialId: secondId },
      ],
    });
    const input = {
      ...f.input({ authority: "bootstrap", operation: "discover" }),
      selectedCredentialId: null,
    };
    input.requestHeaders.set(
      "cookie",
      `__Host-pirate_guest_${credentialId}=${secret}; __Host-pirate_guest_${secondId}=${secret}`,
    );
    await expect(f.adapter.authenticate(input)).resolves.toMatchObject({
      selected: null,
      provedCredentials: expect.any(Array),
    });
  }
});

test("cleanup without a pointer retains no selected credential across singleton or multiple owners", async () => {
  const secondId = `${"B".repeat(21)}A`;
  for (const credentials of [
    [proof],
    [proof, { ...proof, ownerId: "owner-other", credentialId: secondId }],
  ]) {
    const f = fixture({ credentials });
    const input = {
      ...f.input({ authority: "recovery", operation: "cleanup" }),
      selectedCredentialId: null,
    };
    input.requestHeaders.set(
      "cookie",
      `${credentials.map((c) => `__Host-pirate_guest_${c.credentialId}=${secret}`).join("; ")}; __Host-pirate_guest_csrf=${csrf}`,
    );
    const result = await f.adapter.authenticate(input);
    expect(result).toMatchObject({ authority: "recovery", operation: "cleanup", selected: null });
    expect(result.provedCredentials).toHaveLength(credentials.length);
  }
});

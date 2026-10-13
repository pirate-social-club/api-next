import { expect, test } from "bun:test";
import { HNS_FORWARDER_HOST_HEADER } from "@pirate/application/use-cases/hns-browser-transport";
import { PERSONA_WALLET_SETUP_SESSION_SCOPE } from "@pirate/application/use-cases/identity-registration-handler";
import type { SessionTokenVerifier } from "@pirate/platform-cf/session-tokens";
import { SessionTokenVerificationError } from "@pirate/platform-cf/session-tokens";
import { makeDirectPostgresControlPlaneLayer, type PostgresClientLike, type PostgresQueryConfig } from "@pirate/platform-cf/postgres";
import { Effect } from "effect";
import { makeGuestAccountingComposition } from "./guest-accounting-controller-composition.ts";
import { makeGuestAuthorityComposition } from "./guest-authority-controller-composition.ts";

function responseHeaders(value: unknown): Headers {
  if (!(value instanceof Headers)) throw new TypeError("Expected actual response Headers");
  return value;
}

const origin = "https://community.example";
const ingress = "https://hns-ingress.example";
const ordinaryScope = "pirate-browser-session-v1";
const attachmentId = `gai_${"B".repeat(21)}A`;
const binding = { attachment_id: attachmentId, owner_id: "owner-original", account_id: "canonical-account", state: "bound", bound_at: "2026-10-13T00:00:00.000Z" } as const;
function fixture(options: { tokenFailure?: boolean; originalBindingAccountId?: string } = {}) {
  const queries: PostgresQueryConfig[] = [];
  let accountCalls = 0, decodedCalls = 0;
  const client: PostgresClientLike = { connect: async () => {}, end: async () => {}, query: async q => {
    queries.push(q);
    if (q.text.startsWith("SELECT find_bound_guest_attachment_v1")) return { rows: [{ result: { ...binding, account_id: options.originalBindingAccountId ?? binding.account_id } }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } };
  const controlPlane = makeDirectPostgresControlPlaneLayer("postgres://fixture.invalid/accounting", { clientFactory: () => client });
  const accountVerifier: SessionTokenVerifier = { verify: ({ token, requiredClassification }) => {
    accountCalls++; expect(requiredClassification).toBe("user");
    if (options.tokenFailure) return Effect.fail(new SessionTokenVerificationError({ code: "invalid_token" }));
    const scope = token === "setup" ? PERSONA_WALLET_SETUP_SESSION_SCOPE : token === "wrong-purpose" ? "other-scope" : ordinaryScope;
    return Effect.succeed({ classification: "user" as const, userId: "canonical-account", scope: { value: scope, tokens: [scope] },
      canonical: { sourceUserId: "original-account", canonicalUserId: "canonical-account", aliasPath: ["original-account", "canonical-account"] } });
  } };
  const authority = makeGuestAuthorityComposition({ controlPlane, accountVerifier,
    ordinarySessionScope: ordinaryScope, ordinaryProductOrigin: origin, hnsProtectedIngressOrigin: ingress,
    nowMilliseconds: () => Date.parse("2026-10-13T00:00:00.000Z"), retryAfterSeconds: 2,
    currentResourcePolicy: null, disclosure: null, trustedEdgeForRequest: async () => null });
  const accounting = makeGuestAccountingComposition({ authority, controlPlane, retryAfterSeconds: 2 });
  const decodeRequestLocations = async () => { decodedCalls++; return { body: {}, params: { id: attachmentId }, query: {}, headers: {} }; };
  return { authority, accounting, queries, decodeRequestLocations, counts: () => ({ accountCalls, decodedCalls }) };
}
function request(path: string, token = "ordinary", more: Record<string, string> = {}, method = "GET") {
  const headers = new Headers(more); headers.set("cookie", `__Host-pirate_session=${token}; ${headers.get("cookie") ?? ""}`);
  return new Request(`${origin}${path}`, { method, headers, ...(method === "POST" ? { body: "unread-invalid-json" } : {}) });
}

test("successful original attachment recovery verifies Account only before decoder, ignoring revoked/malformed Guest cookies", async () => {
  const f = fixture();
  const response = await f.accounting.handleAccountingOperation({ name: "GetMySuccessfulGuestAttachmentV1",
    request: request(`/users/me/guest-attachments/${attachmentId}`, "ordinary", { cookie: "__Host-pirate_guest_broken=broken; __Host-pirate_guest_csrf=bad" }),
    decodeRequestLocations: f.decodeRequestLocations });
  expect(response.body).toEqual(binding); expect(responseHeaders(response.responseHeaders).get("cache-control")).toBe("private, no-store");
  expect(responseHeaders(response.responseHeaders).has("set-cookie")).toBe(false);
  expect(f.counts()).toEqual({ accountCalls: 1, decodedCalls: 1 });
  expect(f.queries.some(q => /guest_proof|guest_credential|lease/i.test(q.text))).toBe(false);
  expect(f.queries.filter(q => q.text.startsWith("SELECT find_bound_guest_attachment_v1"))).toHaveLength(1);
});
test("setup purpose accepted solely for successful attachment; setup/other purpose cannot select credit", async () => {
  const f = fixture();
  const recovery = await f.accounting.handleAccountingOperation({ name: "GetMySuccessfulGuestAttachmentV1", request: request("/successful", "setup"), decodeRequestLocations: f.decodeRequestLocations });
  expect(recovery.body).toEqual(binding);
  for (const token of ["setup", "wrong-purpose"]) {
    const g = fixture();
    await expect(g.accounting.handleAccountingOperation({ name: "SelectOwnerRewardCreditRecipientV1",
      request: request("/select", token, { origin, cookie: "__Host-pirate_csrf=ordinary-csrf", "x-csrf-token": "ordinary-csrf" }, "POST"), decodeRequestLocations: g.decodeRequestLocations })).rejects.toMatchObject({ details: { reason_code: "account_proof_required" } });
    expect(g.counts().decodedCalls).toBe(0); expect(g.queries).toHaveLength(0);
  }
});
test("ordinary CSRF/Origin/header and invalid cookie authority fail before body decoder or DB", async () => {
  for (const headers of [
    { origin: "https://other.example", cookie: "__Host-pirate_csrf=ordinary-csrf", "x-csrf-token": "ordinary-csrf" },
    { origin, cookie: "__Host-pirate_csrf=ordinary-csrf", "x-csrf-token": "wrong" },
    { origin, authorization: "Bearer machine-token", cookie: "__Host-pirate_csrf=ordinary-csrf", "x-csrf-token": "ordinary-csrf" },
  ]) {
    const f = fixture(); const req = request("/claim", "ordinary", headers, "POST");
    await expect(f.accounting.handleAccountingOperation({ name: "ClaimOwnerRewardCreditV1", request: req, decodeRequestLocations: f.decodeRequestLocations })).rejects.toMatchObject({ _tag: "GuestAuthError" });
    expect(f.counts()).toEqual({ accountCalls: 0, decodedCalls: 0 }); expect(f.queries).toHaveLength(0); expect(req.bodyUsed).toBe(false);
  }
  const f = fixture({ tokenFailure: true }); const req = request("/successful");
  await expect(f.accounting.handleAccountingOperation({ name: "GetMySuccessfulGuestAttachmentV1", request: req, decodeRequestLocations: f.decodeRequestLocations })).rejects.toMatchObject({ details: { reason_code: "account_proof_required" } });
  expect(f.counts()).toEqual({ accountCalls: 1, decodedCalls: 0 }); expect(f.queries).toHaveLength(0);
});
test("attachment remains dual-CSRF Guest proof authority; missing Guest CSRF refuses body and DB", async () => {
  for (const name of ["PrepareGuestAttachmentTargetV1", "ConfirmGuestAttachmentTargetV1"] as const) {
    const f = fixture(); const req = request("/attachment", "ordinary", { origin, cookie: "__Host-pirate_csrf=ordinary-csrf", "x-csrf-token": "ordinary-csrf" }, "POST");
    await expect(f.accounting.handleAccountingOperation({ name, request: req, decodeRequestLocations: f.decodeRequestLocations })).rejects.toMatchObject({ details: { reason_code: "guest_origin_or_csrf_invalid" } });
    expect(f.counts()).toEqual({ accountCalls: 0, decodedCalls: 0 }); expect(f.queries).toHaveLength(0); expect(req.bodyUsed).toBe(false);
  }
});
test("account-only HNS claimed header does not mint origin authority; refusal preflight never reads body", async () => {
  const f = fixture(); const headers = { cookie: "__Host-pirate_session=ordinary; __Host-pirate_csrf=ordinary-csrf", origin, "x-csrf-token": "ordinary-csrf", [HNS_FORWARDER_HOST_HEADER]: "community.example" };
  const req = new Request(`${ingress}/api/claim`, { method: "POST", body: "unread", headers });
  await f.authority.requestAuthentication.precheckOrdinaryAccountHnsBeforeBody({ request: req, purpose: "ordinary_account", unsafe: true });
  expect(req.bodyUsed).toBe(false); expect(f.counts().accountCalls).toBe(1);
  const noCsrf = new Request(`${ingress}/api/claim`, { method: "POST", body: "unread", headers: { ...headers, "x-csrf-token": "wrong" } });
  await expect(f.authority.requestAuthentication.precheckOrdinaryAccountHnsBeforeBody({ request: noCsrf, purpose: "ordinary_account", unsafe: true })).rejects.toMatchObject({ details: { reason_code: "guest_origin_or_csrf_invalid" } });
  expect(noCsrf.bodyUsed).toBe(false); expect(f.counts().accountCalls).toBe(1);
  // Existing canonical forwarder header constant is set by the real HNS pipeline;
  // even a correct claimed preflight result cannot replace final verified MAC.
  await expect(f.authority.requestAuthentication.authenticateOrdinaryAccount({ request: req, purpose: "ordinary_account", unsafe: true })).rejects.toMatchObject({ details: { reason_code: "guest_origin_or_csrf_invalid" } });
  expect(req.bodyUsed).toBe(false); expect(f.queries).toHaveLength(0); expect(f.counts().accountCalls).toBe(1);
});
test("ordinary session binding remains domain-separated and bound to initiating origin/token, never Guest proof", async () => {
  const f = fixture(); const a = await f.authority.requestAuthentication.authenticateOrdinaryAccount({ request: request("/successful"), purpose: "ordinary_account", unsafe: false });
  const b = await f.authority.requestAuthentication.authenticateOrdinaryAccount({ request: request("/successful", "another-ordinary"), purpose: "ordinary_account", unsafe: false });
  expect(a.origin).toBe(origin); expect(a.account.accountId).toBe("canonical-account");
  expect(a.account.sessionBinding).toMatch(/^[0-9a-f]{64}$/u); expect(a.account.sessionBinding).not.toBe(b.account.sessionBinding);
  expect(f.queries).toHaveLength(0);
});

test("canonically authorized successful read preserves original Account A target after aliasing to B", async () => {
  // The actual controlled SDK consumes a native-authorized receipt. Genuine
  // native A->B authorization/refusal belongs to the separately bound SQL gate.
  const f = fixture({ originalBindingAccountId: "original-account-A" });
  const response = await f.accounting.handleAccountingOperation({ name: "GetMySuccessfulGuestAttachmentV1",
    request: request(`/users/me/guest-attachments/${attachmentId}`, "ordinary", { cookie: "__Host-pirate_guest_broken=revoked" }),
    decodeRequestLocations: f.decodeRequestLocations });
  expect(response.body).toEqual({ ...binding, account_id: "original-account-A" });
  const read = f.queries.find(q => q.text.startsWith("SELECT find_bound_guest_attachment_v1"));
  expect(read?.values?.[0]).toBe("canonical-account");
  expect(read?.values?.[1]).toBe(attachmentId);
  expect(responseHeaders(response.responseHeaders).has("set-cookie")).toBe(false);
});

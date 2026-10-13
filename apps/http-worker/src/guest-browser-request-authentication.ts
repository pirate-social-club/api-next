// PRIVATE SOURCE PROPOSAL. No route, endpoint, flag or account binding is enabled.
import type {
  BrowserParticipationContext,
  OrdinaryBrowserAccount,
  SetupBrowserAccount,
} from "@pirate/application/guest-participation-authority";
import {
  HNS_FORWARDER_HOST_HEADER,
  isCanonicalHnsForwarderHost,
} from "@pirate/application/use-cases/hns-browser-transport";
import { PERSONA_WALLET_SETUP_SESSION_SCOPE } from "@pirate/application/use-cases/identity-registration-handler";
import {
  type BrowserParticipationPolicy,
  GuestAuthError,
  GuestBadRequest,
  GuestCredentialIdV1,
  InternalError,
} from "@pirate/contracts";
import type { SessionTokenVerifier } from "@pirate/platform-cf/session-tokens";
import { Effect, Schema } from "effect";
import {
  assertGuestBrowserRequestBoundary,
  type GuestBrowserAuthenticationServices,
  isMixedGuestOperation,
  isUnsafeGuestOperation,
  makeGuestBrowserAuthenticationAdapter,
} from "./guest-browser-authentication.ts";
import {
  hasReservedHnsCommunityAppHeader,
  type VerifiedHnsCommunityAppApiRequest,
} from "./hns-community-app-api-transport.ts";

const SESSION_COOKIE = "__Host-pirate_session";
const CSRF_COOKIE = "__Host-pirate_csrf";
const MAX_BYTES = 16 * 1024;
const refused = (reason: GuestAuthError["details"]["reason_code"]) =>
  new GuestAuthError({
    message: "Guest browser authority refused",
    details: { reason_code: reason },
  });

function exactHttpsOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== value ||
    value.includes(",") ||
    parsed.hostname.includes("*")
  )
    throw new Error("Exact HTTPS product origin required");
  return value;
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Ordinary cookie values alone. Malformed/duplicate ambient cookies supply no account. */
function ordinaryCookie(headers: Headers, target: string): string | null {
  const raw = headers.get("cookie") ?? "";
  if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) return null;
  let found: string | null = null;
  let count = 0;
  for (const entry of raw.split(";")) {
    const separator = entry.indexOf("=");
    const name = (separator < 0 ? entry : entry.slice(0, separator)).trim();
    if (name !== target) continue;
    count += 1;
    if (count !== 1 || separator < 0) return null;
    try {
      const value = decodeURIComponent(entry.slice(separator + 1).trim());
      if (
        value.length === 0 ||
        new TextEncoder().encode(value).byteLength > MAX_BYTES ||
        containsAsciiControl(value)
      )
        return null;
      found = value;
    } catch {
      return null;
    }
  }
  return found;
}

function assertOrdinaryCookieCsrf(headers: Headers, trustedOrigin: string): void {
  const csrf = ordinaryCookie(headers, CSRF_COOKIE);
  if (
    headers.get("origin") !== trustedOrigin ||
    csrf === null ||
    headers.get("x-csrf-token") !== csrf
  )
    throw refused("guest_origin_or_csrf_invalid");
}

async function sessionBinding(origin: string, verifiedToken: string): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify(["pirate_guest_account_session_binding_v1", origin, verifiedToken]),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface GuestBrowserRequestAuthenticationServices
  extends Omit<GuestBrowserAuthenticationServices, "assertAccountCsrf"> {
  readonly accountVerifier: SessionTokenVerifier;
  /** Exact configured SessionCrypto.defaultScope, never inferred from Principal.kind. */
  readonly ordinarySessionScope: string;
  /** One configured product origin. Wildcards, lists and browser-selected origins refuse. */
  readonly ordinaryProductOrigin: string;
  /** Existing protected Worker ingress; only its verified HNS result can replace product origin. */
  readonly hnsProtectedIngressOrigin?: string;
}

export function makeGuestBrowserRequestAuthenticator(
  services: GuestBrowserRequestAuthenticationServices,
) {
  const ordinaryOrigin = exactHttpsOrigin(services.ordinaryProductOrigin);
  const protectedIngress =
    services.hnsProtectedIngressOrigin === undefined
      ? undefined
      : exactHttpsOrigin(services.hnsProtectedIngressOrigin);
  if (
    services.ordinarySessionScope.length === 0 ||
    services.ordinarySessionScope.trim() !== services.ordinarySessionScope ||
    services.ordinarySessionScope === PERSONA_WALLET_SETUP_SESSION_SCOPE
  )
    throw new Error("Ordinary session purpose unavailable");
  const adapter = makeGuestBrowserAuthenticationAdapter({
    verifier: services.verifier,
    isLearningLeaseActive: services.isLearningLeaseActive,
    assertAccountCsrf: assertOrdinaryCookieCsrf,
  });
  const verifyAccountPurpose = async (headers: Headers, attachment: boolean) => {
    const token = ordinaryCookie(headers, SESSION_COOKIE);
    if (token === null) return null;
    const verified = await Effect.runPromise(
      services.accountVerifier
        .verify({ token, requiredClassification: "user" })
        .pipe(
          Effect.catch((error) =>
            error.code === "control_plane_unavailable"
              ? Effect.fail(new InternalError({ message: "Browser account authority unavailable" }))
              : Effect.succeed(null),
          ),
        ),
    );
    if (verified === null || verified.classification !== "user") return null;
    const kind =
      verified.scope.value === services.ordinarySessionScope
        ? ("ordinary_account" as const)
        : attachment && verified.scope.value === PERSONA_WALLET_SETUP_SESSION_SCOPE
          ? ("persona_wallet_setup" as const)
          : null;
    return kind === null ? null : { kind, accountId: verified.userId, token };
  };
  const trustedOrigin = (request: Request, verifiedHns?: VerifiedHnsCommunityAppApiRequest): string => {
    const headers = request.headers;
    if (verifiedHns !== undefined) {
      if (protectedIngress === undefined || new URL(request.url).origin !== protectedIngress ||
          verifiedHns.exact_origin !== `https://${verifiedHns.normalized_host}`)
        throw refused("guest_origin_or_csrf_invalid");
      try { return exactHttpsOrigin(verifiedHns.exact_origin); }
      catch { throw refused("guest_origin_or_csrf_invalid"); }
    }
    if (hasReservedHnsCommunityAppHeader(headers) ||
        (protectedIngress !== undefined && new URL(request.url).origin === protectedIngress))
      throw refused("guest_origin_or_csrf_invalid");
    return ordinaryOrigin;
  };
  const accountBoundary = (headers: Headers, origin: string, unsafe: boolean) => {
    if (headers.has("authorization")) throw refused("account_proof_required");
    const suppliedOrigin = headers.get("origin");
    if (suppliedOrigin !== null && suppliedOrigin !== origin)
      throw refused("guest_origin_or_csrf_invalid");
    if (unsafe) assertOrdinaryCookieCsrf(headers, origin);
  };
  return {
    /** Account-only original recovery. Guest cookie damage/revocation cannot gate it.
     * The caller never supplies an account ID, scope witness or session digest.
     */
    async authenticateOrdinaryAccount(input: Readonly<{
      request: Request; purpose: "ordinary_account" | "successful_attachment";
      unsafe: boolean; verifiedHns?: VerifiedHnsCommunityAppApiRequest;
    }>): Promise<Readonly<{ origin: string; account: OrdinaryBrowserAccount | SetupBrowserAccount }>> {
      const origin = trustedOrigin(input.request, input.verifiedHns);
      const headers = new Headers(input.request.headers);
      accountBoundary(headers, origin, input.unsafe);
      const verified = await verifyAccountPurpose(headers, input.purpose === "successful_attachment");
      if (verified === null) throw refused("account_proof_required");
      const binding = await sessionBinding(origin, verified.token);
      const account: OrdinaryBrowserAccount | SetupBrowserAccount = verified.kind === "ordinary_account"
        ? { kind: "ordinary_account", accountId: verified.accountId, sessionBinding: binding }
        : { kind: "persona_wallet_setup", accountId: verified.accountId, sessionBinding: binding };
      return { origin, account };
    },
    /** Refusal-only account checks AFTER actual Access and BEFORE actual HNS MAC body hash.
     * Claimed host does not mint authority: authenticateOrdinaryAccount requires final MAC proof.
     */
    async precheckOrdinaryAccountHnsBeforeBody(input: Readonly<{
      request: Request; purpose: "ordinary_account" | "successful_attachment"; unsafe: boolean;
    }>): Promise<void> {
      if (protectedIngress === undefined || new URL(input.request.url).origin !== protectedIngress)
        throw refused("guest_origin_or_csrf_invalid");
      const headers = new Headers(input.request.headers);
      const host = headers.get(HNS_FORWARDER_HOST_HEADER);
      if (host === null || !isCanonicalHnsForwarderHost(host)) throw refused("guest_origin_or_csrf_invalid");
      accountBoundary(headers, `https://${host}`, input.unsafe);
      const verified = await verifyAccountPurpose(headers, input.purpose === "successful_attachment");
      if (verified === null) throw refused("account_proof_required");
    },
    /** Refusal only. Actual HNS verifier invokes this AFTER Access, BEFORE body clone/hash.
     * Canonical claimed host is never final authority; no context or binding is minted.
     */
    async precheckHnsBeforeBody(
      input: Readonly<{ request: Request; policy: BrowserParticipationPolicy }>,
    ): Promise<void> {
      if (protectedIngress === undefined || new URL(input.request.url).origin !== protectedIngress)
        throw refused("guest_origin_or_csrf_invalid");
      const headers = new Headers(input.request.headers);
      const claimedHost = headers.get(HNS_FORWARDER_HOST_HEADER);
      if (claimedHost === null || !isCanonicalHnsForwarderHost(claimedHost))
        throw refused("guest_origin_or_csrf_invalid");
      const claimedOrigin = `https://${claimedHost}`;
      assertGuestBrowserRequestBoundary({
        requestHeaders: headers,
        trustedProductOrigin: claimedOrigin,
        policy: input.policy,
      });
      const selected = headers.get("x-guest-credential-id");
      if (selected !== null) {
        try {
          Schema.decodeUnknownSync(GuestCredentialIdV1)(selected);
        } catch {
          throw new GuestBadRequest({
            message: "Invalid guest selection",
            details: { reason_code: "guest_request_invalid" },
          });
        }
      }
      const attachment = input.policy.authority === "attachment";
      if (attachment || (selected === null && isMixedGuestOperation(input.policy))) {
        const account = await verifyAccountPurpose(headers, attachment);
        if (attachment && account === null) throw refused("account_proof_required");
        if (account !== null && (attachment || isUnsafeGuestOperation(input.policy)))
          assertOrdinaryCookieCsrf(headers, claimedOrigin);
      }
      // Full MAC/body/current-host verification still runs next. This callback
      // creates no BrowserParticipationContext, session digest or guest proof.
    },
    /** verifiedHns comes only from actual verifyHnsCommunityAppApiRequest in the earlier middleware.
     * No HTTP header, body field, boolean or caller-supplied origin mints that authority.
     * All proofs stay on this initiating host; this method performs no forwarding/fetch.
     */
    async authenticate(
      input: Readonly<{
        request: Request;
        policy: BrowserParticipationPolicy;
        verifiedHns?: VerifiedHnsCommunityAppApiRequest;
      }>,
    ): Promise<BrowserParticipationContext> {
      const headers = new Headers(input.request.headers);
      const origin = trustedOrigin(input.request, input.verifiedHns);
      // Header-only origin/guest CSRF/cookie cap checks precede any account verifier,
      // digest work, handler, body decode, canonical request hash or reservation.
      assertGuestBrowserRequestBoundary({
        requestHeaders: headers,
        trustedProductOrigin: origin,
        policy: input.policy,
      });
      const selectedCredentialId = headers.get("x-guest-credential-id");
      if (selectedCredentialId !== null) {
        try {
          Schema.decodeUnknownSync(GuestCredentialIdV1)(selectedCredentialId);
        } catch {
          throw new GuestBadRequest({
            message: "Invalid guest selection",
            details: { reason_code: "guest_request_invalid" },
          });
        }
      }
      const accountRequired = input.policy.authority === "attachment";
      const mayUseAccount =
        accountRequired || (selectedCredentialId === null && isMixedGuestOperation(input.policy));
      let account: OrdinaryBrowserAccount | SetupBrowserAccount | null = null;
      if (mayUseAccount) {
        const verified = await verifyAccountPurpose(headers, accountRequired);
        if (verified !== null) {
          if (accountRequired || isUnsafeGuestOperation(input.policy))
            assertOrdinaryCookieCsrf(headers, origin);
          const binding = await sessionBinding(origin, verified.token);
          account =
            verified.kind === "ordinary_account"
              ? { kind: "ordinary_account", accountId: verified.accountId, sessionBinding: binding }
              : {
                  kind: "persona_wallet_setup",
                  accountId: verified.accountId,
                  sessionBinding: binding,
                };
        }
      }
      if (accountRequired && account === null) throw refused("account_proof_required");
      return adapter.authenticate({
        policy: input.policy,
        requestHeaders: headers,
        trustedProductOrigin: origin,
        selectedCredentialId,
        account,
      });
    },
  };
}

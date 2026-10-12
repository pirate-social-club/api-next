import type {
  BrowserParticipationContext,
  GuestCredentialVerifier,
  GuestLearningAccess,
  GuestRecoveryAccess,
  ProvedGuestCredential,
} from "@pirate/application/guest-participation-authority";
import {
  type BrowserParticipationPolicy,
  GuestAuthError,
  GuestBadRequest,
  GuestConflict,
  GuestCredentialIdV1,
  InternalError,
} from "@pirate/contracts";
import { digestGuestProof } from "@pirate/platform-cf/guest-proof-crypto";
import { Effect, Schema } from "effect";
import {
  type GuestBrowserAuthenticationAdapter,
  parseGuestBrowserCookies,
} from "./guest-browser-cookie-policy.ts";

type Confirmed = ProvedGuestCredential & { readonly state: "confirmed" };
type Input = Parameters<GuestBrowserAuthenticationAdapter["authenticate"]>[0];

const refused = (reason: GuestAuthError["details"]["reason_code"]) =>
  new GuestAuthError({
    message: "Guest browser authority refused",
    details: { reason_code: reason },
  });
const conflict = () =>
  new GuestConflict({
    message: "Select the original guest authority",
    details: { reason_code: "guest_authority_conflict" },
  });

export function isUnsafeGuestOperation(policy: BrowserParticipationPolicy): boolean {
  return !(
    (policy.authority === "bootstrap" && policy.operation === "discover") ||
    (policy.authority === "recovery" && policy.operation === "participations") ||
    (policy.authority === "learning" &&
      (policy.operation === "read" || policy.operation === "operation_result"))
  );
}

function selectProof(
  credentials: readonly ProvedGuestCredential[],
  input: Input,
): ProvedGuestCredential | null {
  if (input.selectedCredentialId !== null) {
    try {
      Schema.decodeUnknownSync(GuestCredentialIdV1)(input.selectedCredentialId);
    } catch {
      throw new GuestBadRequest({
        message: "Invalid guest selection",
        details: { reason_code: "guest_request_invalid" },
      });
    }
    const found = credentials.find((c) => c.credentialId === input.selectedCredentialId);
    if (found) return found;
    if (input.policy.authority === "bootstrap" && input.policy.operation === "discover")
      return null;
    throw refused("guest_proof_required");
  }
  if (input.policy.authority === "recovery" && input.policy.operation === "cleanup") return null;
  const nullableSelection =
    input.policy.authority === "bootstrap" && input.policy.operation === "discover";
  const active = credentials.filter((c) => c.state !== "revoked");
  // Discovery classifies conflicts in the store instead of picking an owner.
  if (new Set(active.map((c) => c.ownerId)).size > 1) {
    if (nullableSelection) return null;
    throw conflict();
  }
  const successors = active.filter((c) => c.state === "pending_successor");
  const confirmed = active.filter((c) => c.state === "confirmed");
  const candidates =
    input.policy.authority === "recovery" &&
    input.policy.operation === "acknowledge" &&
    successors.length
      ? successors
      : confirmed.length
        ? confirmed
        : active;
  if (candidates.length > 1) {
    if (nullableSelection) return null;
    throw conflict();
  }
  return candidates[0] ?? null;
}

function confirmedProof(value: ProvedGuestCredential | null): Confirmed {
  if (value?.state === "revoked") throw refused("guest_proof_revoked");
  if (value?.state !== "confirmed") throw refused("guest_proof_required");
  return { ...value, state: "confirmed" };
}

function recoveryAccess(value: Confirmed): GuestRecoveryAccess {
  return {
    kind: "guest",
    ownerId: value.ownerId,
    credentialId: value.credentialId,
    origin: value.origin,
  };
}

export interface GuestBrowserAuthenticationServices {
  readonly verifier: GuestCredentialVerifier;
  /** Database clock/state check. Stores repeat it in their owning transaction. */
  readonly isLearningLeaseActive: (proof: Confirmed) => Promise<boolean>;
  /** Existing ordinary cookie CSRF check, before any body read. */
  readonly assertAccountCsrf: (headers: Headers, trustedOrigin: string) => void;
}

export function isMixedGuestOperation(policy: BrowserParticipationPolicy): boolean {
  return (
    (policy.authority === "learning" && policy.operation !== "start") ||
    (policy.authority === "recovery" &&
      (policy.operation === "participations" ||
        policy.operation === "retention" ||
        policy.operation === "delete_audio"))
  );
}

/** Header-only boundary. Call before account verification, body reads or proof hashing. */
export function assertGuestBrowserRequestBoundary(
  input: Pick<Input, "requestHeaders" | "trustedProductOrigin" | "policy">,
) {
  const { requestHeaders: headers, trustedProductOrigin: origin, policy } = input;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.origin !== origin) throw new Error();
  } catch {
    throw refused("guest_origin_or_csrf_invalid");
  }
  if (headers.has("authorization")) throw refused("guest_proof_required");
  const cleanup = policy.authority === "recovery" && policy.operation === "cleanup";
  const cookies = parseGuestBrowserCookies(headers, cleanup);
  if (
    (headers.has("origin") && headers.get("origin") !== origin) ||
    (isUnsafeGuestOperation(policy) &&
      (headers.get("origin") !== origin ||
        cookies.csrf === null ||
        headers.get("x-guest-csrf-token") !== cookies.csrf))
  )
    throw refused("guest_origin_or_csrf_invalid");
  return cookies;
}

/** Credentials remain transport-owned and never become an ordinary account Principal. */
export function makeGuestBrowserAuthenticationAdapter(
  services: GuestBrowserAuthenticationServices,
): GuestBrowserAuthenticationAdapter {
  const assertAccountCsrf = (headers: Headers, origin: string) => {
    try {
      services.assertAccountCsrf(headers, origin);
    } catch {
      throw refused("guest_origin_or_csrf_invalid");
    }
  };
  const learningAccess = async (proof: Confirmed): Promise<GuestLearningAccess> => {
    if (proof.leaseUntil === null || !(await services.isLearningLeaseActive(proof)))
      throw refused("guest_learning_lease_expired");
    return { ...recoveryAccess(proof), leaseUntil: proof.leaseUntil };
  };
  return {
    async authenticate(input): Promise<BrowserParticipationContext> {
      const { requestHeaders: headers, trustedProductOrigin: origin, policy, account } = input;
      const cookies = assertGuestBrowserRequestBoundary(input);
      const unsafe = isUnsafeGuestOperation(policy);
      const mixed = isMixedGuestOperation(policy);
      // Preserve both-CSRF semantics, but check account CSRF before guest proof hashes.
      if (
        (mixed &&
          input.selectedCredentialId === null &&
          account?.kind === "ordinary_account" &&
          unsafe) ||
        (policy.authority === "attachment" && account !== null)
      )
        assertAccountCsrf(headers, origin);
      const cleanup = policy.authority === "recovery" && policy.operation === "cleanup";

      const proofs = await Effect.runPromise(
        services.verifier.verify({
          origin,
          cleanup,
          credentialProofs: await Promise.all(
            cookies.credentials.map(async (c) => ({
              credentialId: c.credentialId,
              digest: await digestGuestProof(c.secret),
            })),
          ),
          intentProofs: await Promise.all(
            cookies.intents.map(async (c) => ({
              intentId: c.intentId,
              digest: await digestGuestProof(c.secret),
            })),
          ),
        }),
      );
      if (
        proofs.origin !== origin ||
        proofs.provedCredentials.some((c) => c.origin !== origin) ||
        proofs.provedIntents.some((i) => i.origin !== origin)
      )
        throw new InternalError({ message: "Invalid guest proof projection" });
      const base = {
        origin,
        provedCredentials: proofs.provedCredentials,
        provedIntents: proofs.provedIntents,
      };
      const checked = { ...base, originAndCsrfChecked: true as const };
      if (mixed && input.selectedCredentialId === null && account?.kind === "ordinary_account") {
        if (policy.authority === "learning") {
          const access = {
            kind: "account" as const,
            accountId: account.accountId,
            sessionBinding: account.sessionBinding,
          };
          if (policy.operation === "read" || policy.operation === "operation_result")
            return { ...base, authority: "learning", operation: policy.operation, access };
          if (policy.operation === "answer")
            return { ...checked, authority: "learning", operation: "answer", access };
        }
        if (policy.authority === "recovery") {
          const access = {
            kind: "bound_account" as const,
            accountId: account.accountId,
            sessionBinding: account.sessionBinding,
          };
          if (policy.operation === "participations")
            return { ...base, authority: "recovery", operation: "participations", access };
          if (policy.operation === "retention" || policy.operation === "delete_audio")
            return { ...checked, authority: "recovery", operation: policy.operation, access };
        }
      }
      const selected = selectProof(base.provedCredentials, input);
      switch (policy.authority) {
        case "bootstrap":
          if (policy.operation === "discover")
            return { ...base, authority: "bootstrap", operation: "discover", selected };
          if (policy.operation === "issue")
            return { ...checked, authority: "bootstrap", operation: "issue", selected };
          if (selected?.state !== "pending_bootstrap" && selected?.state !== "confirmed")
            throw refused(
              selected?.state === "revoked" ? "guest_proof_revoked" : "guest_proof_required",
            );
          return {
            ...checked,
            authority: "bootstrap",
            operation: "confirm",
            selected: { ...selected, state: selected.state },
          };
        case "recovery":
          if (policy.operation === "cleanup")
            return { ...checked, authority: "recovery", operation: "cleanup", selected };
          if (policy.operation === "acknowledge") {
            if (
              (selected?.state !== "pending_successor" && selected?.state !== "confirmed") ||
              selected.predecessorCredentialId === null
            )
              throw refused("guest_proof_required");
            return {
              ...checked,
              authority: "recovery",
              operation: "acknowledge",
              selected: {
                ...selected,
                state: selected.state,
                predecessorCredentialId: selected.predecessorCredentialId,
              },
            };
          }
          if (policy.operation === "participations")
            return {
              ...base,
              authority: "recovery",
              operation: "participations",
              access: recoveryAccess(confirmedProof(selected)),
            };
          if (policy.operation === "retention" || policy.operation === "delete_audio")
            return {
              ...checked,
              authority: "recovery",
              operation: policy.operation,
              access: recoveryAccess(confirmedProof(selected)),
            };
          return {
            ...checked,
            authority: "recovery",
            operation: policy.operation,
            selected: confirmedProof(selected),
            access: recoveryAccess(confirmedProof(selected)),
          };
        case "learning": {
          const proof = confirmedProof(selected);
          const access = await learningAccess(proof);
          if (policy.operation === "start")
            return {
              ...checked,
              authority: "learning",
              operation: "start",
              selected: proof,
              access,
            };
          if (policy.operation === "answer")
            return { ...checked, authority: "learning", operation: "answer", access };
          return { ...base, authority: "learning", operation: policy.operation, access };
        }
        case "attachment": {
          const proof = confirmedProof(selected);
          if (account === null) throw refused("account_proof_required");
          const intents = base.provedIntents.filter(
            (i) =>
              i.ownerId === proof.ownerId &&
              i.credentialId === proof.credentialId &&
              (i.state === "awaiting_account" || i.state === "awaiting_confirmation"),
          );
          if (intents.length !== 1) throw refused("guest_proof_required");
          const intent = intents[0];
          if (
            !intent ||
            (intent.state !== "awaiting_account" && intent.state !== "awaiting_confirmation")
          )
            throw refused("guest_proof_required");
          return {
            ...checked,
            authority: "attachment",
            operation: policy.operation,
            selected: proof,
            access: recoveryAccess(proof),
            account,
            accountCsrfChecked: true,
            intent: { ...intent, state: intent.state },
          };
        }
      }
    },
  };
}

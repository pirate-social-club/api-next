import {
  type AuthPolicy,
  type BrowserParticipationPolicy,
  type EndpointDefinition,
  isBrowserParticipationOperation,
} from "@pirate/contracts";

const SUPPORTED_SHARED_SECRET_POLICIES = ["hns-edge-alert", "hns-edge-status"] as const;

type SupportedAuthPolicy =
  | BrowserParticipationPolicy
  | { readonly kind: "public" }
  | { readonly kind: "admin"; readonly scope: "avatars:moderate" }
  | { readonly kind: "user" | "userOrAdmin" }
  | {
      readonly kind: "sharedSecret";
      readonly name: (typeof SUPPORTED_SHARED_SECRET_POLICIES)[number];
    };

export function supportedAuthPolicy(policy: AuthPolicy): SupportedAuthPolicy {
  switch (policy.kind) {
    case "browserParticipation":
      if (isBrowserParticipationOperation(policy)) return policy;
      break;
    case "public":
    case "user":
    case "userOrAdmin":
      return policy;
    case "admin":
      if (policy.scope === "avatars:moderate") return { kind: "admin", scope: "avatars:moderate" };
      break;
    case "sharedSecret":
      if (SUPPORTED_SHARED_SECRET_POLICIES.some((name) => name === policy.name)) {
        return policy as SupportedAuthPolicy;
      }
      break;
  }
  throw new Error("HTTP worker authentication policy is unsupported");
}

export function assertSupportedAuthPolicies(endpoints: readonly EndpointDefinition[]): void {
  for (const endpoint of endpoints) supportedAuthPolicy(endpoint.auth.policy);
}

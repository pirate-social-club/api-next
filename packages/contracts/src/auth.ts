/**
 * Declarative auth-policy vocabulary (api-next 000 §5; 001 phase 0 step 3).
 *
 * Auth is a policy VALUE on each endpoint, not middleware matched by path.
 * This vocabulary replaces all seven auth idioms of the old API; migrating
 * each old route means writing down its effective policy — which is itself
 * the auth audit. Shapes frozen at phase 0; lane A implements enforcement.
 */

export type AuthScope = string;

export type AuthPolicy =
  | { readonly kind: "public" }
  | { readonly kind: "user" }
  | { readonly kind: "userOrAdmin" }
  | { readonly kind: "userOrAdminOrAgentDelegated"; readonly scope: AuthScope }
  | { readonly kind: "admin"; readonly scope: AuthScope }
  | { readonly kind: "operator"; readonly scope: AuthScope }
  | { readonly kind: "agentDelegated"; readonly scope: AuthScope }
  | { readonly kind: "device"; readonly scope: AuthScope }
  | { readonly kind: "sharedSecret"; readonly name: string };

/** Modifiers any principal policy may carry. */
export interface AuthModifiers {
  readonly altcha?: AuthScope;
  readonly optionalUser?: boolean;
  /** Require the host-only browser session cookie and reject Authorization credentials. */
  readonly browserSessionOnly?: boolean;
}

/** What an endpoint declares: a principal policy plus optional modifiers. */
export interface AuthPolicyApplication extends AuthModifiers {
  readonly policy: AuthPolicy;
}

export const Auth = {
  public: (): AuthPolicyApplication => ({ policy: { kind: "public" } }),
  user: (modifiers: AuthModifiers = {}): AuthPolicyApplication => ({
    policy: { kind: "user" },
    ...modifiers,
  }),
  userOrAdmin: (modifiers: AuthModifiers = {}): AuthPolicyApplication => ({
    policy: { kind: "userOrAdmin" },
    ...modifiers,
  }),
  userOrAdminOrAgentDelegated: (
    scope: AuthScope,
    modifiers: AuthModifiers = {},
  ): AuthPolicyApplication => ({
    policy: { kind: "userOrAdminOrAgentDelegated", scope },
    ...modifiers,
  }),
  admin: (scope: AuthScope, modifiers: AuthModifiers = {}): AuthPolicyApplication => ({
    policy: { kind: "admin", scope },
    ...modifiers,
  }),
  operator: (scope: AuthScope, modifiers: AuthModifiers = {}): AuthPolicyApplication => ({
    policy: { kind: "operator", scope },
    ...modifiers,
  }),
  agentDelegated: (scope: AuthScope, modifiers: AuthModifiers = {}): AuthPolicyApplication => ({
    policy: { kind: "agentDelegated", scope },
    ...modifiers,
  }),
  device: (scope: AuthScope, modifiers: AuthModifiers = {}): AuthPolicyApplication => ({
    policy: { kind: "device", scope },
    ...modifiers,
  }),
  sharedSecret: (name: string, modifiers: AuthModifiers = {}): AuthPolicyApplication => ({
    policy: { kind: "sharedSecret", name },
    ...modifiers,
  }),
} as const;

import {
  type SessionAccount,
  type SessionExchangeServices,
  SessionIdentityRejected,
  type VerifiedSessionIdentity,
} from "@pirate/application/use-cases/session-exchange";
import { AuthError, InternalError } from "@pirate/contracts";
import {
  HttpWorkerConfig,
  type HttpWorkerConfigValue,
  loadConfigFrom,
} from "@pirate/platform-cf/config";
import {
  ControlPlaneDb,
  type HyperdriveConnection,
  makeHyperdriveControlPlaneLayer,
} from "@pirate/platform-cf/postgres";
import {
  makeSessionBridgeFromEnv,
  type SessionBridge,
  type SessionBridgeEnvironment,
} from "@pirate/platform-cf/session-bridge";
import { Effect, ManagedRuntime, Redacted } from "effect";
import { createHttpWorker, type EndpointHandler, type Principal } from "./transport.ts";

export interface HttpWorkerBindings extends SessionBridgeEnvironment {
  readonly CONTROL_PLANE?: HyperdriveConnection;
  readonly API_NEXT_ENV?: string;
  readonly CORS_ORIGIN?: string;
  readonly PRIVY_APP_ID?: string;
  readonly PRIVY_APP_SECRET?: string;
  readonly PRIVY_API_URL?: string;
}

type IdentityRow = Readonly<Record<string, unknown>>;

type WorkerConfig = HttpWorkerConfigValue;

const defaultVerificationCapabilities = {
  unique_human: { state: "unverified" as const },
  age_over_18: { state: "unverified" as const },
  minimum_age: { state: "unverified" as const },
  nationality: { state: "unverified" as const },
  gender: { state: "unverified" as const },
  wallet_score: { state: "unverified" as const },
};

const identityFailure = () => new SessionIdentityRejected({ reason: "invalid" });

function redactedValue(value: Redacted.Redacted<string>): string {
  return Redacted.value(value);
}

function configSource(bindings: HttpWorkerBindings): Record<string, string | undefined> {
  return {
    API_NEXT_ENV: bindings.API_NEXT_ENV,
    CORS_ORIGIN: bindings.CORS_ORIGIN,
    PIRATE_APP_JWT_PRIVATE_KEY: bindings.PIRATE_APP_JWT_PRIVATE_KEY,
    PIRATE_APP_JWT_PUBLIC_KEY: bindings.PIRATE_APP_JWT_PUBLIC_KEY,
    PIRATE_APP_JWT_ISSUER: bindings.PIRATE_APP_JWT_ISSUER,
    PIRATE_APP_JWT_AUDIENCE: bindings.PIRATE_APP_JWT_AUDIENCE,
    PIRATE_APP_JWT_TTL_SECONDS: bindings.PIRATE_APP_JWT_TTL_SECONDS,
    PRIVY_APP_ID: bindings.PRIVY_APP_ID,
    PRIVY_APP_SECRET: bindings.PRIVY_APP_SECRET,
    PRIVY_API_URL: bindings.PRIVY_API_URL,
  };
}

function loadWorkerConfig(bindings: HttpWorkerBindings): WorkerConfig {
  try {
    const config = loadConfigFrom(HttpWorkerConfig, configSource(bindings));
    if (config.PIRATE_APP_JWT_TTL_SECONDS <= 0) throw new Error("invalid TTL");
    if (bindings.CONTROL_PLANE === undefined) throw new Error("CONTROL_PLANE is missing");
    return config;
  } catch {
    // Do not surface ConfigError details because a secret name or value must
    // never reach a Worker response or startup log.
    throw new Error("HTTP worker configuration is incomplete or invalid");
  }
}

function text(row: IdentityRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function number(row: IdentityRow, key: string): number | null {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime() / 1_000;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed > 1_000_000_000_000 ? parsed / 1_000 : parsed;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return date / 1_000;
  }
  return null;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return jsonObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function capabilities(row: IdentityRow): typeof defaultVerificationCapabilities {
  const parsed = jsonObject(row.verification_capabilities_json);
  if (parsed === null) return defaultVerificationCapabilities;
  return {
    unique_human: jsonObject(parsed.unique_human) ?? defaultVerificationCapabilities.unique_human,
    age_over_18: jsonObject(parsed.age_over_18) ?? defaultVerificationCapabilities.age_over_18,
    minimum_age: jsonObject(parsed.minimum_age) ?? defaultVerificationCapabilities.minimum_age,
    nationality: jsonObject(parsed.nationality) ?? defaultVerificationCapabilities.nationality,
    gender: jsonObject(parsed.gender) ?? defaultVerificationCapabilities.gender,
    wallet_score: jsonObject(parsed.wallet_score) ?? defaultVerificationCapabilities.wallet_score,
  } as typeof defaultVerificationCapabilities;
}

function verificationState(
  row: IdentityRow,
): "unverified" | "pending" | "verified" | "reverification_required" {
  const value = text(row, "verification_state");
  return value === "pending" || value === "verified" || value === "reverification_required"
    ? value
    : "unverified";
}

function capabilityProvider(row: IdentityRow): "self" | "zkpassport" | "very" | null {
  const value = text(row, "capability_provider");
  if (value === "self" || value === "zkpassport" || value === "very") return value;
  if (value === "zkpass") return "zkpassport";
  return null;
}

function statement(label: string, textValue: string, values: readonly unknown[]) {
  return { label, text: textValue, values, readonly: true } as const;
}

const userStatement = (userId: string) =>
  statement(
    "session.user",
    `SELECT user_id, primary_wallet_attachment_id, verification_state,
       capability_provider, verification_capabilities_json, verified_at, created_at
     FROM users WHERE user_id = $1 LIMIT 1`,
    [userId],
  );

const aliasStatement = (userId: string) =>
  statement(
    "session.alias",
    `SELECT canonical_user_id
     FROM user_account_aliases
     WHERE source_user_id = $1 AND status = 'active'
     LIMIT 1`,
    [userId],
  );

const profileStatement = (userId: string) =>
  statement(
    "session.profile",
    `SELECT user_id, display_name, bio, bio_source, avatar_ref, avatar_source,
       cover_ref, cover_source, preferred_locale, xmtp_inbox_id, created_at
     FROM profiles WHERE user_id = $1 LIMIT 1`,
    [userId],
  );

const handleStatement = (userId: string) =>
  statement(
    "session.global-handle",
    `SELECT global_handle_id, label_display, tier, status, issuance_source,
       redirect_target_global_handle_id, price_paid_usd, free_rename_consumed,
       issued_at, replaced_at
     FROM global_handles
     WHERE user_id = $1 AND status = 'active'
     ORDER BY issued_at DESC LIMIT 1`,
    [userId],
  );

const walletStatement = (userId: string) =>
  statement(
    "session.wallets",
    `SELECT wallet_attachment_id, chain_namespace, wallet_address_display, is_primary
     FROM wallet_attachments
     WHERE user_id = $1 AND status = 'active'
     ORDER BY is_primary DESC, attached_at ASC`,
    [userId],
  );

const linkedHandleStatement = (userId: string) =>
  statement(
    "session.linked-handles",
    `SELECT linked_handle_id, label_display, kind, verification_state, metadata_json
     FROM linked_handles WHERE user_id = $1 ORDER BY label_display ASC`,
    [userId],
  );

function accountFromRows(
  user: IdentityRow,
  profile: IdentityRow,
  handle: IdentityRow,
  wallets: readonly IdentityRow[],
  linkedHandles: readonly IdentityRow[],
): SessionAccount {
  const userId = text(user, "user_id");
  const handleId = text(handle, "global_handle_id");
  const profileUserId = text(profile, "user_id");
  const issuedAt = number(handle, "issued_at");
  const created = number(user, "created_at");
  const profileCreated = number(profile, "created_at");
  if (
    !userId ||
    !profileUserId ||
    !handleId ||
    issuedAt === null ||
    created === null ||
    profileCreated === null
  ) {
    throw identityFailure();
  }

  const globalHandle = {
    id: handleId,
    object: "global_handle" as const,
    label: text(handle, "label_display") ?? handleId,
    tier: (text(handle, "tier") ?? "generated") as "generated" | "standard" | "premium",
    status: (text(handle, "status") ?? "active") as "active" | "redirect" | "retired",
    issuance_source: (text(handle, "issuance_source") ?? "generated_signup") as
      | "generated_signup"
      | "free_cleanup_rename"
      | "reddit_verified_claim"
      | "paid_upgrade"
      | "admin_grant",
    redirect_target_global_handle: text(handle, "redirect_target_global_handle_id"),
    price_paid_cents: number(handle, "price_paid_usd"),
    free_rename_consumed: Boolean(handle.free_rename_consumed),
    issued_at: issuedAt,
    replaced_at: number(handle, "replaced_at"),
  };

  const externalHandles = linkedHandles.map((linked) => ({
    linked_handle: text(linked, "linked_handle_id") ?? "",
    label: text(linked, "label_display") ?? "",
    kind: (text(linked, "kind") === "ens" ? "ens" : "pirate") as "pirate" | "ens",
    verification_state: (text(linked, "verification_state") ?? "unverified") as
      | "verified"
      | "unverified"
      | "stale",
    metadata: null,
  }));

  return {
    canonicalUserId: userId,
    user: {
      id: userId,
      object: "user",
      verification_state: verificationState(user),
      capability_provider: capabilityProvider(user),
      verification_capabilities: capabilities(user),
      primary_wallet_attachment: text(user, "primary_wallet_attachment_id"),
      verified_at: number(user, "verified_at"),
      created,
    },
    profile: {
      id: profileUserId,
      object: "profile",
      display_name: text(profile, "display_name"),
      avatar_ref: text(profile, "avatar_ref"),
      avatar_source: text(profile, "avatar_source") as "ens" | "upload" | "none" | null,
      cover_ref: text(profile, "cover_ref"),
      cover_source: text(profile, "cover_source") as "ens" | "upload" | "none" | null,
      bio: text(profile, "bio"),
      bio_source: text(profile, "bio_source") as "ens" | "manual" | "none" | null,
      preferred_locale: text(profile, "preferred_locale"),
      display_verified_nationality_badge: false,
      nationality_badge_country: null,
      linked_handles: [
        {
          linked_handle: `global:${handleId}`,
          label: globalHandle.label,
          kind: "pirate" as const,
          verification_state: "verified" as const,
        },
        ...externalHandles,
      ],
      primary_public_handle: null,
      primary_wallet_address: wallets.find((wallet) => Boolean(wallet.is_primary))
        ? text(wallets.find((wallet) => Boolean(wallet.is_primary)) ?? {}, "wallet_address_display")
        : null,
      is_bookable: false,
      xmtp_inbox: text(profile, "xmtp_inbox_id"),
      global_handle: globalHandle,
      created: profileCreated,
    },
    onboarding: {
      generated_handle_assigned: true,
      cleanup_rename_available: false,
      unique_human_verification_status: "not_started" as const,
      namespace_verification_status: "not_started" as const,
      community_creation_ready: false,
      missing_requirements: [],
      reddit_verification_status: "not_started" as const,
      reddit_import_status: "not_started" as const,
    },
    wallet_attachments: wallets.map((wallet) => ({
      wallet_attachment: text(wallet, "wallet_attachment_id") ?? "",
      chain_namespace: text(wallet, "chain_namespace") ?? "",
      wallet_address: text(wallet, "wallet_address_display") ?? "",
      is_primary: Boolean(wallet.is_primary),
    })),
  };
}

function resolveAccountEffect(sourceUserId: string) {
  return Effect.gen(function* () {
    const db = yield* ControlPlaneDb;
    let current = sourceUserId;
    const visited = new Set<string>();
    let user: IdentityRow | undefined;

    for (let depth = 0; depth < 8; depth += 1) {
      if (visited.has(current)) return yield* Effect.fail(identityFailure());
      visited.add(current);
      const result = yield* db.execute<IdentityRow>(userStatement(current));
      user = result.rows[0];
      if (user === undefined) return null;
      const alias = yield* db.execute<IdentityRow>(aliasStatement(current));
      const next = text(alias.rows[0] ?? {}, "canonical_user_id");
      if (next === null) break;
      current = next;
    }

    if (user === undefined) return null;
    const profile = yield* db.execute<IdentityRow>(profileStatement(current));
    const handle = yield* db.execute<IdentityRow>(handleStatement(current));
    const profileRow = profile.rows[0];
    const handleRow = handle.rows[0];
    if (profileRow === undefined || handleRow === undefined) return null;
    const wallets = yield* db.execute<IdentityRow>(walletStatement(current));
    const linkedHandles = yield* db.execute<IdentityRow>(linkedHandleStatement(current));
    return accountFromRows(user, profileRow, handleRow, wallets.rows, linkedHandles.rows);
  });
}

async function runWithControlPlane<A>(
  binding: HyperdriveConnection,
  effect: Effect.Effect<A, unknown, ControlPlaneDb>,
): Promise<A> {
  const runtime = ManagedRuntime.make(makeHyperdriveControlPlaneLayer(binding));
  try {
    return await runtime.runPromise(effect);
  } finally {
    await runtime.dispose();
  }
}

function identityStore(binding: HyperdriveConnection): SessionExchangeServices["identityStore"] {
  return {
    resolve: ({ sourceUserId }) =>
      Effect.tryPromise({
        try: () => runWithControlPlane(binding, resolveAccountEffect(sourceUserId)),
        catch: () => identityFailure(),
      }),
  };
}

function bearerToken(value: string): string {
  if (!value.startsWith("Bearer ")) throw new AuthError({ message: "Invalid authorization" });
  const token = value.slice("Bearer ".length).trim();
  if (token === "") throw new AuthError({ message: "Invalid authorization" });
  return token;
}

function makeAuthenticator(bridge: SessionBridge, store: SessionExchangeServices["identityStore"]) {
  return async ({
    credentials,
  }: {
    readonly credentials: { readonly authorization: string };
  }): Promise<Principal> => {
    try {
      const claims = await bridge.verify(bearerToken(credentials.authorization));
      if (claims.scope !== bridge.defaultScope)
        throw new AuthError({ message: "Authentication required" });
      const account = await Effect.runPromise(store.resolve({ sourceUserId: claims.sub }));
      if (account === null) throw new AuthError({ message: "Authentication required" });
      return { kind: "user", subject: account.canonicalUserId };
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError({ message: "Authentication required" });
    }
  };
}

function makePrivyVerifier(
  config: WorkerConfig,
): SessionExchangeServices["proofVerifier"]["verifyPrivy"] {
  return ({ accessToken }) =>
    Effect.tryPromise({
      try: async (): Promise<VerifiedSessionIdentity> => {
        const response = await fetch(`${config.PRIVY_API_URL}/api/v1/users/me`, {
          headers: {
            authorization: `Bearer ${accessToken}`,
            "privy-app-id": config.PRIVY_APP_ID,
            "privy-app-secret": redactedValue(config.PRIVY_APP_SECRET),
          },
        });
        if (!response.ok) throw new Error("Privy rejected proof");
        const payload: unknown = await response.json();
        const record = jsonObject(payload);
        const sourceUserId =
          record === null ? null : (text(record, "id") ?? text(record, "user_id"));
        if (sourceUserId === null) throw new Error("Privy response has no identity");
        return { sourceUserId, classification: "user" };
      },
      catch: () => new Error("Privy proof rejected"),
    });
}

export async function createProductionHttpWorker(bindings: HttpWorkerBindings) {
  const config = loadWorkerConfig(bindings);
  const bridge = await makeSessionBridgeFromEnv({
    PIRATE_APP_JWT_PRIVATE_KEY: redactedValue(config.PIRATE_APP_JWT_PRIVATE_KEY),
    PIRATE_APP_JWT_PUBLIC_KEY: redactedValue(config.PIRATE_APP_JWT_PUBLIC_KEY),
    PIRATE_APP_JWT_ISSUER: config.PIRATE_APP_JWT_ISSUER,
    PIRATE_APP_JWT_AUDIENCE: config.PIRATE_APP_JWT_AUDIENCE,
    PIRATE_APP_JWT_TTL_SECONDS: String(config.PIRATE_APP_JWT_TTL_SECONDS),
  });
  const store = identityStore(bindings.CONTROL_PLANE as HyperdriveConnection);
  const sessionExchange: SessionExchangeServices = {
    proofVerifier: {
      verifyPrivy: makePrivyVerifier(config),
      verifyJwt: ({ jwt }) =>
        Effect.tryPromise({
          try: async (): Promise<VerifiedSessionIdentity> => {
            const claims = await bridge.verify(jwt);
            return {
              sourceUserId: claims.sub,
              classification: claims.scope === bridge.defaultScope ? "user" : "device",
            };
          },
          catch: () => new Error("JWT proof rejected"),
        }),
    },
    identityStore: store,
    tokenMinter: {
      mint: ({ subject, scope }) =>
        Effect.tryPromise({
          try: () => bridge.sign({ sub: subject, scope }),
          catch: () => new InternalError({ message: "Session exchange failed" }),
        }),
    },
  };
  const authenticate = makeAuthenticator(bridge, store);
  const profile: EndpointHandler = async ({ principal }) => {
    if (principal === null) throw new AuthError({ message: "Authentication required" });
    const account = await Effect.runPromise(store.resolve({ sourceUserId: principal.subject }));
    if (account === null) throw new AuthError({ message: "Authentication required" });
    return account.profile;
  };

  return createHttpWorker({
    config: { corsOrigin: config.CORS_ORIGIN },
    sessionExchange,
    profile,
    authenticate,
    authorize: ({ input }) => {
      if (input.principal === null) throw new AuthError({ message: "Authentication required" });
    },
  });
}

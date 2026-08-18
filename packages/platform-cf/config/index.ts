import { Config, ConfigProvider, Effect, Redacted } from "effect";
import type { Redacted as RedactedType } from "effect/Redacted";

/**
 * Configuration system (api-next 000 §9) — Effect `Config`, fail-closed.
 *
 * Every variable is declared exactly once, with type, default or required-
 * ness, and environment applicability. Binding-based Workers load their
 * config before constructing the route application; invalid or missing
 * required config therefore fails the first health-check request rather than
 * limping into a read path (incident api#999 class).
 *
 * Semantics note: `Config.withDefault` swallows parse failures, so a
 * defaulted variable can never be *invalid* — it falls back. Money-path
 * variables are therefore REQUIRED (no defaults): an unset or malformed
 * money-path value must fail startup, and a missing testnet posture is a
 * deploy-time event, not a runtime surprise.
 */

/** Where this Worker build may run; gates per-env config below. */
export const AppEnv = Config.literals(["development", "staging", "production"], "API_NEXT_ENV");

export interface AppEnvValue {
  readonly API_NEXT_ENV: "development" | "staging" | "production";
}

export const isProduction = (env: AppEnvValue): boolean => env.API_NEXT_ENV === "production";

/**
 * Fail-closed loader for process-backed configuration. A binding-based Worker
 * uses {@link loadConfigFrom} from its first-request composition boundary
 * because Cloudflare supplies bindings only to `fetch`.
 */
export function loadConfig<A>(config: Config.Config<A>): A {
  // The default provider snapshots process.env at import; building the
  // provider per call keeps loads honest for tests and per-worker entry.
  return Effect.runSync(
    (config as unknown as Effect.Effect<A>).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: process.env as Record<string, string> }),
      ),
    ),
  );
}

/**
 * The money-path configuration group (000 §9): chain ids, RPC URLs, USDC
 * addresses, treasury/floor thresholds. Deliberately empty until M3 —
 * each money flow declares its member here when it lands, which is the
 * in-code half of the money-path ratchet the invariant test enforces.
 */
export const MoneyPathConfig = Config.all({});

/** Secrets are redacted so they never surface in logs or error text. */
export const secret = (name: string): Config.Config<RedactedType<string>> =>
  // Config.redacted does not read from the default env provider in this RC;
  // wrap explicitly until the pinned Effect bump fixes it.
  Config.string(name).pipe(Config.map((value: string) => Redacted.make(value)));

/**
 * Configuration required before the HTTP application layer is constructed.
 * The Hyperdrive object is a Worker binding rather than an environment
 * variable and is checked by the composition root alongside this group.
 */
export const HttpWorkerConfig = Config.all({
  API_NEXT_ENV: AppEnv,
  CORS_ORIGIN: Config.nonEmptyString("CORS_ORIGIN"),
  PIRATE_API_PUBLIC_ORIGIN: Config.string("PIRATE_API_PUBLIC_ORIGIN").pipe(Config.withDefault("")),
  SELF_PASS_ENABLED: Config.boolean("SELF_PASS_ENABLED").pipe(Config.withDefault(false)),
  SELF_PASS_APP_NAME: Config.string("SELF_PASS_APP_NAME").pipe(Config.withDefault("Pirate")),
  SELF_PASS_MOCK_PASSPORT: Config.boolean("SELF_PASS_MOCK_PASSPORT").pipe(
    Config.withDefault(false),
  ),
  ZKPASSPORT_ENABLED: Config.boolean("ZKPASSPORT_ENABLED").pipe(Config.withDefault(false)),
  ZKPASSPORT_DOMAIN: Config.string("ZKPASSPORT_DOMAIN").pipe(Config.withDefault("")),
  ZKPASSPORT_NAME: Config.string("ZKPASSPORT_NAME").pipe(Config.withDefault("Pirate")),
  ZKPASSPORT_LOGO: Config.string("ZKPASSPORT_LOGO").pipe(Config.withDefault("")),
  ZKPASSPORT_VERIFIER_URL: Config.string("ZKPASSPORT_VERIFIER_URL").pipe(Config.withDefault("")),
  ZKPASSPORT_VERIFIER_SHARED_SECRET: Config.string("ZKPASSPORT_VERIFIER_SHARED_SECRET").pipe(
    Config.withDefault(""),
  ),
  ZKPASSPORT_DEV_MODE: Config.boolean("ZKPASSPORT_DEV_MODE").pipe(Config.withDefault(false)),
  VERIFICATION_CALLBACK_CREDENTIAL_HEADERS: Config.string(
    "VERIFICATION_CALLBACK_CREDENTIAL_HEADERS",
  ).pipe(Config.withDefault("")),
  PIRATE_APP_JWT_PRIVATE_KEY: secret("PIRATE_APP_JWT_PRIVATE_KEY"),
  PIRATE_APP_JWT_PUBLIC_KEY: secret("PIRATE_APP_JWT_PUBLIC_KEY"),
  PIRATE_APP_JWT_ISSUER: Config.string("PIRATE_APP_JWT_ISSUER").pipe(
    Config.withDefault("pirate-api"),
  ),
  PIRATE_APP_JWT_AUDIENCE: Config.string("PIRATE_APP_JWT_AUDIENCE").pipe(
    Config.withDefault("pirate-app"),
  ),
  PIRATE_APP_JWT_TTL_SECONDS: Config.int("PIRATE_APP_JWT_TTL_SECONDS").pipe(
    Config.withDefault(3_600),
  ),
  PRIVY_APP_ID: Config.nonEmptyString("PRIVY_APP_ID"),
  PRIVY_APP_SECRET: secret("PRIVY_APP_SECRET"),
  PRIVY_API_URL: Config.string("PRIVY_API_URL").pipe(Config.withDefault("https://auth.privy.io")),
  PRIVY_JWKS_URL: Config.nonEmptyString("PRIVY_JWKS_URL"),
  PRIVY_JWT_ISSUER: Config.nonEmptyString("PRIVY_JWT_ISSUER"),
  PRIVY_JWT_AUDIENCE: Config.nonEmptyString("PRIVY_JWT_AUDIENCE"),
});

export type HttpWorkerConfigValue = Config.Success<typeof HttpWorkerConfig>;

export type ConfigSource = Readonly<Record<string, string | undefined>>;

/** Load against explicit Worker bindings in production and process.env in tests. */
export function loadConfigFrom<A>(config: Config.Config<A>, source: ConfigSource): A {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) environment[key] = value;
  }
  return Effect.runSync(
    (config as unknown as Effect.Effect<A>).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: environment }),
      ),
    ),
  );
}

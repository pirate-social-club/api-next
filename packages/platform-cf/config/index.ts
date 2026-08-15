import { Config, ConfigProvider, Effect, Redacted } from "effect";
import type { Redacted as RedactedType } from "effect/Redacted";

/**
 * Configuration system (api-next 000 §9) — Effect `Config`, fail-at-startup.
 *
 * Every variable is declared exactly once, with type, default or required-
 * ness, and environment applicability. A Worker loads its config at module
 * init via {@link loadConfig}; invalid or missing required config therefore
 * fails the deploy health check rather than limping into a read path
 * (incident api#999 class).
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
 * Fail-at-startup loader. Run at module scope of a Worker entry so the
 * failure happens during deploy/init, never on a request path.
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

// This module is bundled by Workers, while the root typecheck also traverses
// its adapter export. Keep the runtime-only import isolated from Node/Bun's
// ambient DOM declarations with a small structural compile-time shim.
// biome-ignore lint/suspicious/noTsIgnore: cloudflare:workers exists only in the Workers runtime
// @ts-ignore cloudflare:workers exists only in the Workers runtime
import { DurableObject as CloudflareDurableObject } from "cloudflare:workers";
import type { RegistrationRateLimiterDecision } from "./registration-rate-limiter";

export interface RegistrationRateLimiterEnvironment {
  readonly REGISTRATION_IP_LIMIT: string;
  readonly REGISTRATION_IP_WINDOW_SECONDS: string;
  readonly REGISTRATION_APPLICATION_LIMIT: string;
  readonly REGISTRATION_APPLICATION_WINDOW_SECONDS: string;
}

type FixedWindowConfig = {
  readonly limit: number;
  readonly windowMs: number;
};

type WindowRow = {
  readonly window_start_ms: number;
  readonly count: number;
};

type SqlCursor<T> = { readonly toArray: () => readonly T[] };
type DurableObjectStateLike = {
  readonly storage: {
    readonly sql: {
      readonly exec: <T = unknown>(query: string, ...bindings: readonly unknown[]) => SqlCursor<T>;
    };
  };
  readonly blockConcurrencyWhile: (callback: () => void | Promise<void>) => unknown;
};

const parsePositiveInteger = (name: string, value: string): number => {
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

const fixedWindowConfig = (
  environment: RegistrationRateLimiterEnvironment,
  bucket: "ip" | "application",
): FixedWindowConfig => {
  const limitName = bucket === "ip" ? "REGISTRATION_IP_LIMIT" : "REGISTRATION_APPLICATION_LIMIT";
  const windowName =
    bucket === "ip" ? "REGISTRATION_IP_WINDOW_SECONDS" : "REGISTRATION_APPLICATION_WINDOW_SECONDS";
  return {
    limit: parsePositiveInteger(limitName, environment[limitName]),
    windowMs: parsePositiveInteger(windowName, environment[windowName]) * 1_000,
  };
};

abstract class FixedWindowRegistrationRateLimiterDO extends CloudflareDurableObject {
  protected abstract readonly bucket: "ip" | "application";
  private readonly environment: RegistrationRateLimiterEnvironment;

  constructor(ctx: DurableObjectStateLike, env: RegistrationRateLimiterEnvironment) {
    super(ctx as never, env as never);
    this.environment = env;
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS registration_rate_window (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          window_start_ms INTEGER NOT NULL,
          count INTEGER NOT NULL CHECK (count >= 0)
        )`,
      );
    });
  }

  /** Atomically consumes one slot in the current fixed window. */
  check(): RegistrationRateLimiterDecision {
    const config = fixedWindowConfig(this.environment, this.bucket);
    const now = Date.now();
    const windowStartMs = Math.floor(now / config.windowMs) * config.windowMs;
    const state = (this as unknown as { readonly ctx: DurableObjectStateLike }).ctx;
    const current = state.storage.sql
      .exec<WindowRow>("SELECT window_start_ms, count FROM registration_rate_window WHERE id = 1")
      .toArray()[0];

    if (current === undefined || current.window_start_ms !== windowStartMs) {
      state.storage.sql.exec(
        `INSERT INTO registration_rate_window (id, window_start_ms, count)
         VALUES (1, ?, 1)
         ON CONFLICT(id) DO UPDATE SET window_start_ms = excluded.window_start_ms, count = 1`,
        windowStartMs,
      );
      return { allowed: true };
    }

    if (current.count >= config.limit) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((windowStartMs + config.windowMs - now) / 1_000),
      );
      return { allowed: false, retryAfterSeconds };
    }

    state.storage.sql.exec("UPDATE registration_rate_window SET count = count + 1 WHERE id = 1");
    return { allowed: true };
  }
}

export class RegistrationIpRateLimiterDO extends FixedWindowRegistrationRateLimiterDO {
  protected readonly bucket = "ip" as const;
}

export class RegistrationApplicationRateLimiterDO extends FixedWindowRegistrationRateLimiterDO {
  protected readonly bucket = "application" as const;
}

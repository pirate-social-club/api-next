// This module is bundled by Workers, while the root typecheck also traverses
// its adapter export. Keep the runtime-only import isolated from Node/Bun's
// ambient DOM declarations with a small structural compile-time shim.
// biome-ignore lint/suspicious/noTsIgnore: cloudflare:workers exists only in the Workers runtime
// @ts-ignore cloudflare:workers exists only in the Workers runtime
import { DurableObject as CloudflareDurableObject } from "cloudflare:workers";

type SqlCursor = Readonly<{
  readonly toArray: () => readonly unknown[];
}>;

type DurableObjectStateLike = Readonly<{
  readonly storage: Readonly<{
    readonly sql: Readonly<{
      readonly exec: (query: string, ...bindings: readonly unknown[]) => SqlCursor;
    }>;
  }>;
  readonly blockConcurrencyWhile: (callback: () => void | Promise<void>) => unknown;
}>;

const noncePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function validUnixSeconds(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** SQLite-backed atomic replay fence for one consumer-scope and key-id shard. */
export class HnsForwarderReplayStoreDO extends CloudflareDurableObject {
  private readonly state: DurableObjectStateLike;

  constructor(ctx: DurableObjectStateLike, env: Readonly<Record<never, never>>) {
    super(ctx as never, env as never);
    this.state = ctx;
    ctx.blockConcurrencyWhile(() => {
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS hns_forwarder_replay_nonce (
          nonce TEXT PRIMARY KEY,
          expires_at_unix_seconds INTEGER NOT NULL
            CHECK (expires_at_unix_seconds >= 0)
        )`,
      );
    });
  }

  /** Consumes a nonce once; expired rows are pruned before the atomic insert. */
  consume(nonce: string, expiresAtUnixSeconds: number, nowUnixSeconds: number): boolean {
    if (
      !noncePattern.test(nonce) ||
      !validUnixSeconds(expiresAtUnixSeconds) ||
      !validUnixSeconds(nowUnixSeconds) ||
      expiresAtUnixSeconds <= nowUnixSeconds
    ) {
      throw new Error("Invalid HNS forwarder replay record");
    }
    this.state.storage.sql.exec(
      "DELETE FROM hns_forwarder_replay_nonce WHERE expires_at_unix_seconds <= ?",
      nowUnixSeconds,
    );
    const inserted = this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO hns_forwarder_replay_nonce (nonce, expires_at_unix_seconds)
       VALUES (?, ?)
       RETURNING nonce`,
      nonce,
      expiresAtUnixSeconds,
    );
    return inserted.toArray().length === 1;
  }
}

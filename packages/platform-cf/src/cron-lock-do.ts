/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";

import { evaluateLease, type LeaseRecord } from "./cron-lock";

/**
 * Durable-Object-backed lease guaranteeing only ONE scheduled batch runs at a
 * time per lane across the deployment, ported from the old API's
 * `ScheduledCronLockDO` (rated best-in-codebase by the audits). A single
 * deterministic instance per lane name is the arbiter; leases self-expire by
 * timestamp so a crashed batch that never calls `release` cannot deadlock
 * future invocations. Pure lease semantics stay in `cron-lock.ts`; this class
 * is a thin SQLite wrapper with no Effect runtime (000 §2 DO rule).
 */
export class ScheduledCronLockDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL)",
      );
    });
  }

  /**
   * Atomically acquires the lease if free or expired (or already owned). The
   * read and write are SYNCHRONOUS `sql.exec` with no `await` between them, so
   * no other request to this DO can interleave — the read-modify-write is
   * atomic.
   */
  tryAcquire(ttlMs: number, owner: string, now: number): boolean {
    const decision = evaluateLease(this.readLease(), ttlMs, owner, now);
    if (decision.acquired && decision.lease) {
      this.ctx.storage.sql.exec(
        "INSERT INTO lease (id, owner, expires_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at",
        decision.lease.owner,
        decision.lease.expiresAt,
      );
    }
    return decision.acquired;
  }

  /** Releases the lease only if still held by `owner` (never clobbers a newer holder). */
  release(owner: string): void {
    this.ctx.storage.sql.exec("DELETE FROM lease WHERE id = 1 AND owner = ?", owner);
  }

  /** Current lease record, or null — exposed for observability and tests. */
  currentLease(): LeaseRecord | null {
    return this.readLease();
  }

  private readLease(): LeaseRecord | null {
    const rows = this.ctx.storage.sql
      .exec<{ owner: string; expires_at: number }>(
        "SELECT owner, expires_at FROM lease WHERE id = 1",
      )
      .toArray();
    const row = rows[0];
    return row ? { expiresAt: Number(row.expires_at), owner: row.owner } : null;
  }
}

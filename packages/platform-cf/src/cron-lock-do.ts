/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";

import { evaluateFencedLease, type FencedLeaseRecord, type LeaseRecord } from "./cron-lock";

const ALERT_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
        "CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL, generation INTEGER NOT NULL)",
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS lease_fence (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL)",
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS alert_delivery (delivery_key TEXT PRIMARY KEY, marked_at INTEGER NOT NULL)",
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
    return this.tryAcquireWithFence(ttlMs, owner, now) !== null;
  }

  /** Acquires or renews and returns the generation used for write fencing. */
  tryAcquireWithFence(ttlMs: number, owner: string, now: number): FencedLeaseRecord | null {
    const decision = evaluateFencedLease(this.readFencedLease(), ttlMs, owner, now);
    if (decision.acquired && decision.lease) {
      const lease: FencedLeaseRecord = {
        ...decision.lease,
        generation: this.nextGeneration(),
      };
      this.ctx.storage.sql.exec(
        "INSERT INTO lease_fence (id, generation) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET generation = excluded.generation",
        lease.generation,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO lease (id, owner, expires_at, generation) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at, generation = excluded.generation",
        lease.owner,
        lease.expiresAt,
        lease.generation,
      );
      return lease;
    }
    return null;
  }

  /** Renews only the exact active token; a stale runner cannot extend a lease. */
  renew(ttlMs: number, owner: string, generation: number, now: number): FencedLeaseRecord | null {
    const current = this.readFencedLease();
    if (current === null || current.owner !== owner || current.generation !== generation) {
      return null;
    }
    return this.tryAcquireWithFence(ttlMs, owner, now);
  }

  /** Releases the lease only if still held by `owner` (never clobbers a newer holder). */
  release(owner: string): void {
    this.ctx.storage.sql.exec("DELETE FROM lease WHERE id = 1 AND owner = ?", owner);
  }

  /** Releases only the exact active token, preserving a newer holder. */
  releaseWithFence(owner: string, generation: number): boolean {
    const current = this.readFencedLease();
    if (current === null || current.owner !== owner || current.generation !== generation) {
      return false;
    }
    this.ctx.storage.sql.exec(
      "DELETE FROM lease WHERE id = 1 AND owner = ? AND generation = ?",
      owner,
      generation,
    );
    return true;
  }

  /** Current lease record, or null — exposed for observability and tests. */
  currentLease(): LeaseRecord | null {
    return this.readLease();
  }

  /** Current owner, expiry, and fencing generation for adapter boundaries. */
  currentLeaseWithFence(): FencedLeaseRecord | null {
    return this.readFencedLease();
  }

  /** Marks an aggregated alert before dispatch; duplicates are suppressed. */
  markAlertSent(deliveryKey: string): boolean {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "DELETE FROM alert_delivery WHERE marked_at < ?",
      now - ALERT_DELIVERY_RETENTION_MS,
    );
    const existing = this.ctx.storage.sql
      .exec<{ delivery_key: string }>(
        "SELECT delivery_key FROM alert_delivery WHERE delivery_key = ?",
        deliveryKey,
      )
      .toArray();
    if (existing.length > 0) return false;
    this.ctx.storage.sql.exec(
      "INSERT INTO alert_delivery (delivery_key, marked_at) VALUES (?, ?)",
      deliveryKey,
      now,
    );
    return true;
  }

  /** Compensates a mark only after the sink reports a known dispatch failure. */
  compensateAlert(deliveryKey: string): void {
    this.ctx.storage.sql.exec("DELETE FROM alert_delivery WHERE delivery_key = ?", deliveryKey);
  }

  private readLease(): LeaseRecord | null {
    const fenced = this.readFencedLease();
    return fenced === null ? null : { expiresAt: fenced.expiresAt, owner: fenced.owner };
  }

  private readFencedLease(): FencedLeaseRecord | null {
    const rows = this.ctx.storage.sql
      .exec<{ owner: string; expires_at: number; generation: number }>(
        "SELECT owner, expires_at, generation FROM lease WHERE id = 1",
      )
      .toArray();
    const row = rows[0];
    return row
      ? {
          expiresAt: Number(row.expires_at),
          generation: Number(row.generation),
          owner: row.owner,
        }
      : null;
  }

  private nextGeneration(): number {
    const rows = this.ctx.storage.sql
      .exec<{ generation: number }>("SELECT generation FROM lease_fence WHERE id = 1")
      .toArray();
    return Number(rows[0]?.generation ?? 0) + 1;
  }
}

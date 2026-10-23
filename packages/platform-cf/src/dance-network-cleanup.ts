import type { DurableObjectState } from "@cloudflare/workers-types";
import { DANCE_NETWORK_DAY_MS } from "./dance-network-admission-model.ts";

export const DANCE_NETWORK_CLEANUP_COORDINATOR = "dance-network-maintenance-v1";
export const danceNetworkRegistryName = (day: number) => `dance-network-registry-v1:${day}`;
const DANCE_NETWORK_REGISTRY_LIMIT = 1024;
const MAX_DAYS = 3;
const BATCH_SIZE = 8;
const FRESH_MS = 120_000;
type DayObservation = { readonly drained: boolean; readonly remaining: number };
export interface DanceNetworkCleanupNamespace {
  readonly idFromName: (name: string) => { toString(): string };
  readonly getByName: (name: string) => {
    readonly registerDay: (day: number) => Promise<void>;
    readonly registerBucket: (day: number, bucketName: string) => Promise<void>;
    readonly sweepDay: (day: number) => Promise<DayObservation>;
    readonly clearBucket: (bucketName: string) => Promise<boolean>;
    readonly maintain: () => Promise<DanceNetworkCleanupObservation>;
  };
}
interface DanceNetworkCleanupObservation {
  readonly observedAt: number;
  readonly healthy: boolean;
  readonly days: number;
  readonly remaining: number;
  readonly failures: number;
  readonly oldestDeadline: number | null;
}

async function bounded<A>(work: Promise<A>, ms: number): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Dance cleanup observation timed out")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Discovery retains dates and aggregate health only. Keyed names live in the
 * bounded daily registry, which is wholly erased after confirmed bucket drain. */
export class DanceNetworkCleanup {
  private sweep: Promise<DayObservation> | undefined;
  private maintenance: Promise<DanceNetworkCleanupObservation> | undefined;
  constructor(
    private readonly state: DurableObjectState,
    private readonly namespace: DanceNetworkCleanupNamespace,
  ) {}
  private assertIdentity(name: string) {
    if (this.state.id.toString() !== this.namespace.idFromName(name).toString())
      throw new Error("Invalid Dance cleanup identity");
  }
  private assertDay(day: number) {
    if (!Number.isSafeInteger(day) || day < 1 || day > 99_999_999)
      throw new Error("Invalid Dance cleanup day");
  }
  private assertToday(day: number) {
    this.assertDay(day);
    if (day !== Math.floor(Date.now() / DANCE_NETWORK_DAY_MS))
      throw new Error("Expired Dance cleanup registration");
  }
  private hasTable(name: string) {
    return (
      this.state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name)
        .toArray().length > 0
    );
  }
  isControlObject() {
    return (
      this.state.id.toString() ===
        this.namespace.idFromName(DANCE_NETWORK_CLEANUP_COORDINATOR).toString() ||
      this.hasTable("dance_network_registry") ||
      this.hasTable("dance_network_registry_state")
    );
  }
  private coordinatorTables() {
    this.assertIdentity(DANCE_NETWORK_CLEANUP_COORDINATOR);
    const sql = this.state.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS dance_network_dates (day INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, healthy INTEGER NOT NULL, remaining INTEGER NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS dance_network_maintenance (id INTEGER PRIMARY KEY CHECK(id=1), cursor_day INTEGER NOT NULL, observed_at INTEGER NOT NULL)",
    );
    sql.exec("INSERT OR IGNORE INTO dance_network_maintenance VALUES(1,0,0)");
  }
  async registerDay(day: number): Promise<void> {
    this.assertIdentity(DANCE_NETWORK_CLEANUP_COORDINATOR);
    this.assertToday(day);
    this.coordinatorTables();
    this.state.storage.transactionSync(() => {
      this.assertToday(day);
      const sql = this.state.storage.sql,
        now = Date.now();
      const observed = sql
        .exec<{ observed_at: number }>(
          "SELECT observed_at FROM dance_network_maintenance WHERE id=1",
        )
        .toArray()[0];
      const dates = sql
        .exec<{ day: number; observed_at: number; healthy: number }>(
          "SELECT day,observed_at,healthy FROM dance_network_dates",
        )
        .toArray();
      if (
        !observed ||
        observed.observed_at > now ||
        now - observed.observed_at > FRESH_MS ||
        dates.some(
          (row) =>
            !row.healthy ||
            row.observed_at > now ||
            now - row.observed_at > FRESH_MS ||
            (row.day + 2) * DANCE_NETWORK_DAY_MS <= now,
        )
      )
        throw new Error("Dance network cleanup coverage unavailable");
      if (dates.some((row) => row.day === day)) return;
      if (dates.length >= MAX_DAYS) throw new Error("Dance network discovery full");
      // A newly registered current day has no expired data. Discovery commits
      // before its registry can contain any keyed name.
      sql.exec("INSERT INTO dance_network_dates VALUES(?,?,1,0)", day, now);
    });
  }
  async registerBucket(day: number, bucketName: string): Promise<void> {
    this.assertDay(day);
    this.assertIdentity(danceNetworkRegistryName(day));
    this.assertToday(day);
    if (!new RegExp(`^dance-network-v1:${day}:[a-f0-9]{64}$`, "u").test(bucketName))
      throw new Error("Invalid Dance registry bucket");
    this.state.storage.transactionSync(() => {
      this.assertToday(day);
      const sql = this.state.storage.sql;
      sql.exec("CREATE TABLE IF NOT EXISTS dance_network_registry (bucket TEXT PRIMARY KEY)");
      sql.exec(
        "CREATE TABLE IF NOT EXISTS dance_network_registry_state (id INTEGER PRIMARY KEY CHECK(id=1), day INTEGER NOT NULL, cursor TEXT NOT NULL)",
      );
      sql.exec("INSERT OR IGNORE INTO dance_network_registry_state VALUES(1,?,'')", day);
      const identity = sql
        .exec<{ day: number }>("SELECT day FROM dance_network_registry_state WHERE id=1")
        .toArray()[0];
      if (identity?.day !== day) throw new Error("Dance registry day changed");
      if (
        sql.exec("SELECT bucket FROM dance_network_registry WHERE bucket=?", bucketName).toArray()
          .length
      )
        return;
      const count = sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM dance_network_registry")
        .toArray()[0]?.n;
      if (count === undefined || count >= DANCE_NETWORK_REGISTRY_LIMIT)
        throw new Error("Dance network registry full");
      sql.exec("INSERT INTO dance_network_registry VALUES(?)", bucketName);
    });
  }
  sweepDay(day: number): Promise<DayObservation> {
    this.assertDay(day);
    this.assertIdentity(danceNetworkRegistryName(day));
    if (day > Math.floor(Date.now() / DANCE_NETWORK_DAY_MS))
      throw new Error("Future Dance registry");
    if (this.sweep) return this.sweep;
    this.sweep = this.sweepRegistry(day).finally(() => {
      this.sweep = undefined;
    });
    return this.sweep;
  }
  private async sweepRegistry(day: number): Promise<DayObservation> {
    const sql = this.state.storage.sql;
    if (!this.hasTable("dance_network_registry_state")) {
      if (
        sql
          .exec(
            "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND lower(name) NOT IN ('__cf_kv','_cf_kv','_cf_metadata')",
          )
          .toArray().length ||
        (await this.state.storage.getAlarm()) !== null ||
        (await this.state.storage.list({ limit: 1 })).size > 0
      )
        throw new Error("Unknown Dance registry storage");
      return { drained: day < Math.floor(Date.now() / DANCE_NETWORK_DAY_MS), remaining: 0 };
    }
    const identity = sql
      .exec<{ day: number; cursor: string }>(
        "SELECT day,cursor FROM dance_network_registry_state WHERE id=1",
      )
      .toArray()[0];
    if (identity?.day !== day) throw new Error("Dance registry day changed");
    const expired = day < Math.floor(Date.now() / DANCE_NETWORK_DAY_MS);
    if (expired) {
      let batch = sql
        .exec<{ bucket: string }>(
          "SELECT bucket FROM dance_network_registry WHERE bucket>? ORDER BY bucket LIMIT ?",
          identity.cursor,
          BATCH_SIZE,
        )
        .toArray();
      if (!batch.length)
        batch = sql
          .exec<{ bucket: string }>(
            "SELECT bucket FROM dance_network_registry ORDER BY bucket LIMIT ?",
            BATCH_SIZE,
          )
          .toArray();
      // Consume cursors before awaiting another object. Persist fair progress
      // even when a bucket fails or its successful acknowledgement is lost.
      for (const { bucket } of batch) {
        sql.exec("UPDATE dance_network_registry_state SET cursor=? WHERE id=1", bucket);
        try {
          const cleared = await bounded(
            this.namespace.getByName(bucket).clearBucket(bucket),
            1_000,
          );
          this.assertIdentity(danceNetworkRegistryName(day));
          if (day >= Math.floor(Date.now() / DANCE_NETWORK_DAY_MS))
            throw new Error("Dance cleanup clock changed");
          if (cleared) sql.exec("DELETE FROM dance_network_registry WHERE bucket=?", bucket);
        } catch {
          /* Retain unknown deletion and visit the next bounded entry. */
        }
      }
    }
    const remaining = sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM dance_network_registry")
      .toArray()[0]?.n;
    if (remaining === undefined) throw new Error("Missing Dance registry count");
    if (!expired || remaining) return { drained: false, remaining };
    if (day >= Math.floor(Date.now() / DANCE_NETWORK_DAY_MS))
      throw new Error("Dance cleanup clock changed");
    await this.state.storage.deleteAll();
    const empty =
      sql
        .exec(
          "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND lower(name) NOT IN ('__cf_kv','_cf_kv','_cf_metadata')",
        )
        .toArray().length === 0 &&
      (await this.state.storage.getAlarm()) === null &&
      (await this.state.storage.list({ limit: 1 })).size === 0;
    if (!empty) throw new Error("Dance registry erasure unknown");
    return { drained: true, remaining: 0 };
  }
  maintain(): Promise<DanceNetworkCleanupObservation> {
    this.assertIdentity(DANCE_NETWORK_CLEANUP_COORDINATOR);
    if (this.maintenance) return this.maintenance;
    this.maintenance = this.maintainDates().finally(() => {
      this.maintenance = undefined;
    });
    return this.maintenance;
  }
  private async maintainDates(): Promise<DanceNetworkCleanupObservation> {
    this.coordinatorTables();
    const sql = this.state.storage.sql;
    const cursor = sql
      .exec<{ cursor_day: number }>("SELECT cursor_day FROM dance_network_maintenance WHERE id=1")
      .toArray()[0]?.cursor_day;
    if (cursor === undefined) throw new Error("Missing Dance maintenance cursor");
    const dates = sql
      .exec<{ day: number }>("SELECT day FROM dance_network_dates ORDER BY day")
      .toArray();
    if (dates.length > MAX_DAYS) throw new Error("Dance date discovery exceeded bound");
    const ordered = [
      ...dates.filter((row) => row.day > cursor),
      ...dates.filter((row) => row.day <= cursor),
    ];
    let failures = 0;
    for (const { day } of ordered) {
      sql.exec("UPDATE dance_network_maintenance SET cursor_day=? WHERE id=1", day);
      try {
        const result = await bounded(
          this.namespace.getByName(danceNetworkRegistryName(day)).sweepDay(day),
          10_000,
        );
        this.assertIdentity(DANCE_NETWORK_CLEANUP_COORDINATOR);
        if (
          typeof result.drained !== "boolean" ||
          !Number.isSafeInteger(result.remaining) ||
          result.remaining < 0 ||
          result.remaining > DANCE_NETWORK_REGISTRY_LIMIT ||
          (result.drained &&
            (result.remaining !== 0 || day >= Math.floor(Date.now() / DANCE_NETWORK_DAY_MS)))
        )
          throw new Error("Invalid Dance registry observation");
        if (result.drained) sql.exec("DELETE FROM dance_network_dates WHERE day=?", day);
        else
          sql.exec(
            "UPDATE dance_network_dates SET observed_at=?,healthy=1,remaining=? WHERE day=?",
            Date.now(),
            result.remaining,
            day,
          );
      } catch {
        failures++;
        sql.exec("UPDATE dance_network_dates SET healthy=0 WHERE day=?", day);
      }
    }
    const now = Date.now();
    const remaining = sql
      .exec<{ day: number; observed_at: number; healthy: number; remaining: number }>(
        "SELECT * FROM dance_network_dates",
      )
      .toArray();
    const healthy =
      !failures &&
      remaining.every(
        (row) =>
          row.healthy &&
          row.observed_at <= now &&
          now - row.observed_at <= FRESH_MS &&
          (row.day + 2) * DANCE_NETWORK_DAY_MS > now,
      );
    if (healthy) sql.exec("UPDATE dance_network_maintenance SET observed_at=? WHERE id=1", now);
    return {
      observedAt: now,
      healthy,
      days: remaining.length,
      remaining: remaining.reduce((sum, row) => sum + row.remaining, 0),
      failures,
      oldestDeadline: remaining.length
        ? Math.min(...remaining.map((row) => (row.day + 2) * DANCE_NETWORK_DAY_MS))
        : null,
    };
  }
}

/** Runs before application composition, so missing API/database configuration
 * cannot prevent this independent cleanup path from making progress. */
export async function maintainDanceNetworkCleanup(
  namespace: { readonly getByName: (name: string) => unknown } | undefined,
): Promise<void> {
  if (!namespace) return;
  const stub = namespace.getByName(DANCE_NETWORK_CLEANUP_COORDINATOR) as {
    readonly maintain?: () => Promise<DanceNetworkCleanupObservation>;
  };
  if (typeof stub?.maintain !== "function") throw new Error("Dance cleanup binding unavailable");
  const observation = await bounded(stub.maintain(), 31_000);
  console.log("Dance network cleanup", {
    observedAt: observation.observedAt,
    healthy: observation.healthy,
    days: observation.days,
    remaining: observation.remaining,
    failures: observation.failures,
    oldestDeadline: observation.oldestDeadline,
  });
  if (!observation.healthy) throw new Error("Dance network cleanup overdue or unknown");
}

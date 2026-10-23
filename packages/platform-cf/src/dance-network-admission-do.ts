// biome-ignore lint/suspicious/noTsIgnore: cloudflare:workers exists only in the Workers runtime
// @ts-ignore cloudflare:workers exists only in the Workers runtime
import { DurableObject } from "cloudflare:workers";
import type { DurableObjectNamespace, DurableObjectState } from "@cloudflare/workers-types";
import { Schema } from "effect";
import {
  DANCE_NETWORK_DAILY_LIMIT,
  DANCE_NETWORK_DAY_MS,
  type DanceNetworkAdmissionDecision,
  DanceNetworkAdmissionRequest,
} from "./dance-network-admission-model.ts";

type Environment = {
  readonly DANCE_NETWORK_RATE_LIMITER: Pick<DurableObjectNamespace, "idFromName">;
};

/** One fixed UTC day per keyed network. No raw address, account or command key
 * is stored. A caller cannot reopen yesterday's erased object under a new day. */
export class DanceNetworkRateLimiterDO extends DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly environment: Environment,
  ) {
    super(state as never, environment as never);
  }

  async admit(
    raw: typeof DanceNetworkAdmissionRequest.Type,
  ): Promise<DanceNetworkAdmissionDecision> {
    const request = Schema.decodeUnknownSync(DanceNetworkAdmissionRequest, {
      onExcessProperty: "error",
    })(raw);
    const day = Number(request.bucketName.split(":")[1]);
    const now = Date.now();
    if (
      !this.state.id.equals(
        this.environment.DANCE_NETWORK_RATE_LIMITER.idFromName(request.bucketName),
      )
    ) {
      throw new Error("Invalid Dance network bucket");
    }
    if (day !== Math.floor(now / DANCE_NETWORK_DAY_MS)) {
      if (day < Math.floor(now / DANCE_NETWORK_DAY_MS)) await this.alarm();
      throw new Error("Expired Dance network bucket");
    }
    const end = (day + 1) * DANCE_NETWORK_DAY_MS;
    // Establish cleanup before storing any command. A failed first alarm must
    // leave no bucket material behind. The await can cross the UTC boundary.
    await this.state.storage.setAlarm(end);
    if (day !== Math.floor(Date.now() / DANCE_NETWORK_DAY_MS)) {
      await this.alarm();
      throw new Error("Expired Dance network bucket");
    }
    const sql = this.state.storage.sql;
    // Validate day and object identity before creating even empty SQL metadata:
    // an expired request after deleteAll must leave the object erased.
    const decision = this.state.storage.transactionSync((): DanceNetworkAdmissionDecision => {
      sql.exec(
        "CREATE TABLE IF NOT EXISTS dance_network_day (id INTEGER PRIMARY KEY CHECK(id=1), end_ms INTEGER NOT NULL)",
      );
      sql.exec("CREATE TABLE IF NOT EXISTS dance_network_commands (digest TEXT PRIMARY KEY)");
      const current = sql
        .exec<{ end_ms: number }>("SELECT end_ms FROM dance_network_day WHERE id=1")
        .toArray()[0];
      if (current && current.end_ms !== end) throw new Error("Dance network day mismatch");
      sql.exec("INSERT OR IGNORE INTO dance_network_day(id,end_ms) VALUES(1,?)", end);
      if (
        sql
          .exec("SELECT digest FROM dance_network_commands WHERE digest=?", request.commandDigest)
          .toArray().length
      )
        return { allowed: true, retryAfterSeconds: 0 };
      const count = sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM dance_network_commands")
        .toArray()[0]?.n;
      if (count === undefined) throw new Error("Missing Dance network count");
      if (count >= DANCE_NETWORK_DAILY_LIMIT)
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((end - now) / 1000)) };
      sql.exec("INSERT INTO dance_network_commands(digest) VALUES(?)", request.commandDigest);
      return { allowed: true, retryAfterSeconds: 0 };
    });
    return decision;
  }

  async alarm(): Promise<void> {
    const sql = this.state.storage.sql;
    const hasDay =
      sql
        .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='dance_network_day'")
        .toArray().length > 0;
    const row = hasDay
      ? sql.exec<{ end_ms: number }>("SELECT end_ms FROM dance_network_day WHERE id=1").toArray()[0]
      : undefined;
    if (hasDay && !row) throw new Error("Missing Dance network cleanup deadline");
    if (row && Date.now() < row.end_ms) {
      await this.state.storage.setAlarm(row.end_ms);
      return;
    }
    try {
      await this.state.storage.deleteAll();
    } catch (error) {
      // Persist another attempt rather than depending only on six automatic
      // alarm retries. Expired RPCs cannot admit or renew the old day.
      await this.state.storage.setAlarm(Date.now() + 60_000);
      throw error;
    }
  }
}

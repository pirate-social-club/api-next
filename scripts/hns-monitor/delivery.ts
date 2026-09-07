import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { HNS_EDGE_ALERT_TEXT_MAX_BYTES } from "../../packages/contracts/src/hns-edge-alerts.ts";
import type { MonitorCondition } from "./evaluate.ts";

/** The operator timer has its own local delivery receipt, independent of Workers Logs. */
export async function deliverMonitorConditions(
  statePath: string,
  conditions: readonly MonitorCondition[],
  now: number,
  deliver: (text: string) => Promise<void>,
): Promise<"delivered" | "suppressed"> {
  const db = new Database(statePath, { create: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout=1000");
    db.exec(
      "CREATE TABLE IF NOT EXISTS delivery (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL, delivered_at REAL NOT NULL, unhealthy INTEGER NOT NULL)",
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      const messages = conditions.map(({ subject, code }) => `${subject}: ${code}`).sort();
      const fingerprint = createHash("sha256").update(JSON.stringify(messages)).digest("hex");
      const previous = db
        .query<{ fingerprint: string; delivered_at: number; unhealthy: number }, []>(
          "SELECT fingerprint,delivered_at,unhealthy FROM delivery WHERE id=1",
        )
        .get();
      const unchanged = previous?.fingerprint === fingerprint;
      if (
        (unchanged && now >= previous.delivered_at && now - previous.delivered_at < 6 * 3600) ||
        (conditions.length === 0 && previous?.unhealthy !== 1)
      ) {
        db.exec("COMMIT");
        return "suppressed";
      }
      if (messages.length === 0)
        await deliver("HNS monitor: previously reported conditions cleared.");
      else {
        let chunk = "HNS monitor";
        for (const message of messages) {
          if (Buffer.byteLength(`HNS monitor\n${message}`) > HNS_EDGE_ALERT_TEXT_MAX_BYTES)
            throw new Error();
          if (Buffer.byteLength(`${chunk}\n${message}`) > HNS_EDGE_ALERT_TEXT_MAX_BYTES) {
            await deliver(chunk);
            chunk = "HNS monitor";
          }
          chunk += `\n${message}`;
        }
        await deliver(chunk);
      }
      db.query(
        "INSERT INTO delivery VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,delivered_at=excluded.delivered_at,unhealthy=excluded.unhealthy",
      ).run(fingerprint, now, conditions.length > 0 ? 1 : 0);
      db.exec("COMMIT");
      return "delivered";
    } catch {
      db.exec("ROLLBACK");
      throw new Error("HNS monitor delivery unavailable");
    }
  } finally {
    db.close();
  }
}

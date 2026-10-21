import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { Schema } from "effect";
import { Client } from "pg";
import { probePinnedCertificate } from "./hns-monitor/certificate.ts";
import { deliverMonitorConditions, makeMonitorHeartbeatSender } from "./hns-monitor/delivery.ts";
import {
  evaluateMonitorSnapshot,
  type MonitorCondition,
  monitorSubject,
} from "./hns-monitor/evaluate.ts";
import { type MonitorSnapshot, readMonitorSnapshot } from "./hns-monitor/snapshot.ts";
import { probeZoneFreshness, ZoneFreshnessConfig } from "./hns-monitor/zone-freshness.ts";

const Config = Schema.Struct({
  gateway_address: Schema.String.check(Schema.makeFilter((value) => isIP(value) !== 0)),
  zone_freshness: ZoneFreshnessConfig,
  checkpoints: Schema.Array(
    Schema.Struct({
      root: Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u)),
      activation_generation: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u)),
      due_at: Schema.Number.check(Schema.isFinite()),
    }),
  ),
});

async function main(): Promise<void> {
  process.umask(0o077);
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      "healthcheck-sender": { type: "string" },
      "healthcheck-python": { type: "string", default: "/usr/bin/python3" },
      "dry-run": { type: "boolean" },
      deliver: { type: "boolean" },
      "delivery-test": { type: "boolean" },
      "delivery-state": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if ([values["dry-run"], values.deliver, values["delivery-test"]].filter(Boolean).length !== 1)
    throw new Error();
  const delivery = values["dry-run"]
    ? undefined
    : makeMonitorHeartbeatSender(
        values["healthcheck-python"] ?? "/usr/bin/python3",
        values["healthcheck-sender"] ?? "",
        process.env.HNS_HEALTHCHECK_URL_FILE ?? "",
        values["delivery-test"] ? "hns-operator-monitor-fixture" : "hns-operator-monitor",
      );
  if (values["delivery-test"]) {
    if (delivery === undefined) throw new Error();
    const state = values["delivery-state"];
    if (state !== "success" && state !== "failure") throw new Error();
    await delivery(state);
    console.log(JSON.stringify({ delivery: "acknowledged", synthetic: true, state }));
    return;
  }
  if (values["delivery-state"] !== undefined) throw new Error();
  if (values.config === undefined || !isAbsolute(values.config)) throw new Error();
  const config = Schema.decodeUnknownSync(Config)(await Bun.file(values.config).json(), {
    onExcessProperty: "error",
  });
  const identities = config.checkpoints.map(
    (entry) => `${entry.root}:${entry.activation_generation}`,
  );
  if (new Set(identities).size !== identities.length) throw new Error();
  let conditions: MonitorCondition[];
  let observedAt = Date.now() / 1000;
  let rootCount: number | null = null;
  try {
    const databaseUrl = new URL(process.env.HNS_OPERATOR_MONITOR_POSTGRES_URL ?? "");
    if (databaseUrl.searchParams.get("sslrootcert") === "system")
      databaseUrl.searchParams.delete("sslrootcert");
    const client = new Client({
      connectionString: databaseUrl.toString(),
      connectionTimeoutMillis: 10000,
    });
    let snapshot: MonitorSnapshot;
    try {
      await client.connect();
      snapshot = await readMonitorSnapshot(client);
    } finally {
      await client.end();
    }
    observedAt = snapshot.observed_at;
    rootCount = snapshot.roots.length;
    conditions = evaluateMonitorSnapshot(snapshot, config.checkpoints);
    const probeDeadline = performance.now() + 75_000;
    // Bounded batches avoid creating an unbounded socket burst as roots grow.
    for (let index = 0; index < snapshot.roots.length; index += 4) {
      if (probeDeadline - performance.now() < 35_000) {
        conditions.push({ subject: "monitor", code: "dns_observation_capacity" });
        break;
      }
      const batch = snapshot.roots.slice(index, index + 4);
      const results = await Promise.all(
        batch.map(async (root) => {
          const [certificate, dns] = await Promise.all([
            probePinnedCertificate(
              config.gateway_address,
              `app.${root.root}`,
              root.pin,
              snapshot.observed_at,
            ),
            probeZoneFreshness(config.zone_freshness, root),
          ]);
          return {
            subject: monitorSubject(root.root),
            codes: certificate === null ? dns : [...dns, certificate],
          };
        }),
      );
      for (const result of results)
        for (const code of result.codes) conditions.push({ subject: result.subject, code });
    }
  } catch {
    conditions = [{ subject: "monitor", code: "observation_unavailable" }];
  }
  let disposition = "dry-run";
  let deliveryUnavailable = false;
  if (delivery !== undefined) {
    try {
      disposition = await deliverMonitorConditions(conditions, delivery);
    } catch {
      disposition = "unavailable";
      deliveryUnavailable = true;
    }
  }
  console.log(
    JSON.stringify({
      observed_at: observedAt,
      root_count: rootCount,
      conditions,
      delivery: disposition,
    }),
  );
  if (deliveryUnavailable) process.exitCode = 2;
  else if (conditions.length > 0) process.exitCode = 1;
}

main().catch(() => {
  console.error("HNS monitor failed; configuration, credentials and transport errors suppressed");
  process.exitCode = 2;
});

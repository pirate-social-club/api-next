import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { Effect, Schema } from "effect";
import { makeHnsEdgeAlertService } from "../packages/application/src/use-cases/hns-edge-alerts.ts";
import { makeHnsEdgeWebhookAlertSink } from "../packages/platform-cf/src/hns-edge-alert-webhook.ts";
import { openContinuityDatabase } from "./hns-continuity/database.mjs";
import { probePinnedCertificate } from "./hns-monitor/certificate.ts";
import { deliverMonitorConditions } from "./hns-monitor/delivery.ts";
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
      state: { type: "string" },
      "dry-run": { type: "boolean" },
      deliver: { type: "boolean" },
      "delivery-test": { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  if ([values["dry-run"], values.deliver, values["delivery-test"]].filter(Boolean).length !== 1)
    throw new Error();
  const delivery = values["dry-run"]
    ? undefined
    : makeHnsEdgeAlertService(
        makeHnsEdgeWebhookAlertSink(process.env.HNS_OPERATOR_ALERT_WEBHOOK_URL ?? ""),
      );
  if (values["delivery-test"]) {
    if (delivery === undefined) throw new Error();
    await Effect.runPromise(
      delivery.deliver({
        text: "HNS monitor delivery test: synthetic terminal renewal condition; no production state changed.",
      }),
    );
    console.log(JSON.stringify({ delivery: "acknowledged", synthetic: true }));
    return;
  }
  if (values.config === undefined || !isAbsolute(values.config)) throw new Error();
  if (values.deliver && (values.state === undefined || !isAbsolute(values.state)))
    throw new Error();
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
    const client = openContinuityDatabase(process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL ?? "");
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
  if (delivery !== undefined && values.state !== undefined) {
    disposition = await deliverMonitorConditions(values.state, conditions, observedAt, (text) =>
      Effect.runPromise(delivery.deliver({ text })),
    );
  }
  console.log(
    JSON.stringify({
      observed_at: observedAt,
      root_count: rootCount,
      conditions,
      delivery: disposition,
    }),
  );
  if (conditions.length > 0) process.exitCode = 1;
}

main().catch(() => {
  console.error("HNS monitor failed; configuration, credentials and transport errors suppressed");
  process.exitCode = 2;
});

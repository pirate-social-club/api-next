import { describe, expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPinnedCertificate } from "./certificate.ts";
import { deliverMonitorConditions } from "./delivery.ts";
import { evaluateMonitorSnapshot } from "./evaluate.ts";
import type { MonitorSnapshot } from "./snapshot.ts";

const now = 1_800_000_000;
const root = {
  root: "fixture",
  activation_generation: "2",
  pin: "a".repeat(64),
  imported: true,
  inventory_remaining: 604800,
  inventory_age: 0,
  health_remaining: 604800,
  healthy: true,
  delayed_age: null,
  terminal: false,
};
const snapshot = (changes = {}): MonitorSnapshot => ({
  observed_at: now,
  heartbeat_remaining: 7200,
  roots: [{ ...root, ...changes }],
});
const codes = (input: MonitorSnapshot) =>
  evaluateMonitorSnapshot(input, []).map((entry) => entry.code);

test("inventory expiry alerts even while health is fresh; missing evidence cannot disappear", () => {
  expect(codes(snapshot())).toEqual([]);
  expect(codes(snapshot({ inventory_remaining: 172800 }))).toEqual([]);
  expect(codes(snapshot({ inventory_remaining: 172799 }))).toContain("serving_validity_low");
  expect(codes(snapshot({ health_remaining: null }))).toContain("serving_evidence_missing");
  expect(codes(snapshot({ inventory_remaining: null }))).toContain("serving_evidence_missing");
  expect(codes(snapshot({ healthy: false }))).toContain("health_unhealthy");
});

test("terminal and three-hour delayed jobs alert regardless of serving freshness", () => {
  expect(codes(snapshot({ terminal: true }))).toEqual(["renewal_terminal"]);
  expect(codes(snapshot({ delayed_age: 10799 }))).toEqual([]);
  expect(codes(snapshot({ delayed_age: 10800 }))).toEqual(["renewal_delayed"]);
  expect(codes({ ...snapshot(), roots: [], heartbeat_remaining: null })).toEqual([
    "heartbeat_stale",
  ]);
});

test("retained roots have a five-day checkpoint plus an explicit generation-bound deadline", () => {
  expect(codes(snapshot({ imported: false, inventory_age: 5 * 86400 }))).toEqual([
    "inventory_checkpoint_missed",
  ]);
  const checkpoint = { root: "fixture", activation_generation: "2", due_at: now };
  expect(
    evaluateMonitorSnapshot(snapshot({ imported: false }), [checkpoint]).map((entry) => entry.code),
  ).toEqual(["inventory_checkpoint_missed"]);
  expect(
    evaluateMonitorSnapshot(snapshot({ imported: false, activation_generation: "3" }), [
      checkpoint,
    ]),
  ).toEqual([]);
  expect(evaluateMonitorSnapshot(snapshot(), [checkpoint])).toEqual([]);
});

test("certificate renewal changes validity without weakening the retained SPKI or hostname checks", async () => {
  const bytes = new Uint8Array(
    await Bun.file(
      new URL("../hns-continuity/fixtures/gateway-certificate.der", import.meta.url),
    ).arrayBuffer(),
  );
  const cert = new X509Certificate(bytes);
  const hostname = cert.subjectAltName
    ?.split(", ")
    .find((entry) => entry.startsWith("DNS:app."))
    ?.slice(4);
  if (hostname === undefined) throw new Error("Fixture lacks app hostname");
  const pin = createHash("sha256")
    .update(cert.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  const expiry = Date.parse(cert.validTo) / 1000;
  expect(inspectPinnedCertificate(bytes, hostname, pin, expiry - 14 * 86400)).toBeNull();
  expect(inspectPinnedCertificate(bytes, hostname, pin, expiry - 14 * 86400 + 1)).toBe(
    "certificate_validity_low",
  );
  expect(inspectPinnedCertificate(bytes, hostname, "0".repeat(64), expiry - 86400)).toBe(
    "certificate_identity_mismatch",
  );
  expect(inspectPinnedCertificate(bytes, "app.invalid", pin, expiry - 86400)).toBe(
    "certificate_identity_mismatch",
  );
});

describe("monitor delivery receipt", () => {
  test("many affected roots are delivered in bounded messages before advancing the receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hns-monitor-test-"));
    const path = join(directory, "receipt.sqlite");
    const conditions = Array.from({ length: 250 }, (_, index) => ({
      subject: `root-${index}`,
      code: "serving_validity_low",
    }));
    const messages: string[] = [];
    try {
      expect(
        await deliverMonitorConditions(path, conditions, now, async (text) => {
          messages.push(text);
        }),
      ).toBe("delivered");
      expect(messages.length).toBeGreaterThan(1);
      expect(messages.every((text) => Buffer.byteLength(text) <= 4096)).toBe(true);
      expect(messages.join("\n").match(/serving_validity_low/gu)).toHaveLength(250);
      expect(
        await deliverMonitorConditions(path, conditions, now + 1, async () => {
          throw new Error();
        }),
      ).toBe("suppressed");
    } finally {
      await rm(directory, { recursive: true });
    }
  });
  test("failed delivery retries, successful delivery suppresses, changes and recovery deliver", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hns-monitor-test-"));
    const path = join(directory, "receipt.sqlite");
    const condition = [{ subject: "scheduler", code: "heartbeat_stale" }];
    const delivered: string[] = [];
    const send = async (text: string) => {
      delivered.push(text);
    };
    try {
      await expect(
        deliverMonitorConditions(path, condition, now, async () => {
          throw new Error("secret");
        }),
      ).rejects.toThrow("HNS monitor delivery unavailable");
      expect(await deliverMonitorConditions(path, condition, now, send)).toBe("delivered");
      expect(await deliverMonitorConditions(path, condition, now + 1, send)).toBe("suppressed");
      expect(await deliverMonitorConditions(path, condition, now + 6 * 3600, send)).toBe(
        "delivered",
      );
      expect(await deliverMonitorConditions(path, [], now + 6 * 3600 + 1, send)).toBe("delivered");
      expect(await deliverMonitorConditions(path, [], now + 6 * 3600 + 2, send)).toBe("suppressed");
      expect(delivered).toHaveLength(3);
      expect(delivered[2]).toContain("cleared");
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});

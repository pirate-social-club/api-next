import { describe, expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPinnedCertificate } from "./certificate.ts";
import { deliverMonitorConditions, makeMonitorHeartbeatSender } from "./delivery.ts";
import { evaluateMonitorSnapshot } from "./evaluate.ts";
import type { MonitorSnapshot } from "./snapshot.ts";

const now = 1_800_000_000;
const root = {
  root: "fixture",
  activation_generation: "2",
  pin: "a".repeat(64),
  inventory_hex: null,
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

test("DANE-EE certificate identity uses the retained SPKI without a WebPKI hostname requirement", async () => {
  const bytes = new Uint8Array(
    await Bun.file(
      new URL("../hns-continuity/fixtures/gateway-certificate.der", import.meta.url),
    ).arrayBuffer(),
  );
  const cert = new X509Certificate(bytes);
  expect(cert.checkHost("app.other-fixture.invalid")).toBeUndefined();
  const pin = createHash("sha256")
    .update(cert.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  const expiry = Date.parse(cert.validTo) / 1000;
  expect(inspectPinnedCertificate(bytes, pin, expiry - 14 * 86400)).toBeNull();
  expect(inspectPinnedCertificate(bytes, pin, expiry - 14 * 86400 + 1)).toBe(
    "certificate_validity_low",
  );
  expect(inspectPinnedCertificate(bytes, "0".repeat(64), expiry - 86400)).toBe(
    "certificate_identity_mismatch",
  );
  expect(inspectPinnedCertificate(bytes, pin, Date.parse(cert.validFrom) / 1000 - 1)).toBe(
    "certificate_invalid",
  );
});

describe("external monitor heartbeat", () => {
  test("every observation reports its state, including repeated healthy or failed results", async () => {
    const condition = [{ subject: "scheduler", code: "heartbeat_stale" }];
    const delivered: string[] = [];
    const send = async (state: string) => {
      delivered.push(state);
    };
    for (const conditions of [[], [], condition, condition, []])
      expect(await deliverMonitorConditions(conditions, send)).toBe("delivered");
    expect(delivered).toEqual(["success", "success", "failure", "failure", "success"]);
  });

  test("a failed acknowledgment is retried on the next observation", async () => {
    const condition = [{ subject: "monitor", code: "observation_unavailable" }];
    await expect(
      deliverMonitorConditions(condition, async () => {
        throw new Error("transport unavailable");
      }),
    ).rejects.toThrow("transport unavailable");
    const delivered: string[] = [];
    expect(
      await deliverMonitorConditions(condition, async (state) => {
        delivered.push(state);
      }),
    ).toBe("delivered");
    expect(delivered).toEqual(["failure"]);
  });

  test("the sender gets only its private file path, with no parent credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hns-monitor-test-"));
    const credential = join(directory, "managed-url");
    const helper = join(directory, "sender.py");
    const secret = "fixture-private-url-value";
    try {
      await writeFile(credential, secret, { mode: 0o600 });
      await writeFile(
        helper,
        "import json, os, pathlib, sys\n" +
          "assert 'HNS_OPERATOR_MONITOR_POSTGRES_URL' not in os.environ\n" +
          "assert 'HNS_HEALTHCHECKS_API_KEY' not in os.environ\n" +
          "pathlib.Path(os.environ['HNS_HEALTHCHECK_URL_FILE'] + '.receipt').write_text(json.dumps(sys.argv[1:]))\n",
      );
      const sender = makeMonitorHeartbeatSender("/usr/bin/python3", helper, credential);
      await sender("failure");
      const argumentsText = await readFile(`${credential}.receipt`, "utf8");
      expect(JSON.parse(argumentsText)).toEqual([
        "--state",
        "failure",
        "--label",
        "hns-operator-monitor",
      ]);
      expect(argumentsText).not.toContain(secret);
      await writeFile(
        helper,
        "import sys\nprint('fixture-private-url-value', file=sys.stderr)\nraise SystemExit(1)\n",
      );
      await expect(sender("success")).rejects.toThrow("HNS monitor delivery unavailable");
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  test("relative runtime paths are refused before starting a sender", () => {
    expect(() => makeMonitorHeartbeatSender("python3", "/sender.py", "/credential")).toThrow();
    expect(() =>
      makeMonitorHeartbeatSender("/usr/bin/python3", "sender.py", "/credential"),
    ).toThrow();
    expect(() =>
      makeMonitorHeartbeatSender("/usr/bin/python3", "/sender.py", "credential"),
    ).toThrow();
  });
});

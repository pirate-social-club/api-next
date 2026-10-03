import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "pg";
import {
  type RewardShutdownObservation,
  rewardsBinding,
  rewardsLifecycle,
  withRewardsBindingDeployment,
  withRewardsShutdownLock,
} from "./rewards-binding-deploy-preflight.ts";

describe("rewards binding deployment", () => {
  test("a launched release refuses either tracked binding off even before a shutdown query", async () => {
    const root = await mkdtemp(join(tmpdir(), "reward-launch-"));
    try {
      await mkdir(join(root, "docs"));
      await writeFile(
        join(root, "docs/rewards-deployment-lifecycle.json"),
        '{"schema_version":1,"environments":{"prod":"launched"}}',
      );
      for (const worker of ["http", "jobs"]) {
        await mkdir(join(root, `apps/${worker}-worker`), { recursive: true });
        await writeFile(
          join(root, `apps/${worker}-worker/wrangler.jsonc`),
          `{"env":{"prod":{"vars":{"MEGAPOT_REWARDS_ENABLED":"${worker === "http" ? "true" : "false"}"}}}}`,
        );
      }
      let called = false;
      for (const worker of ["http", "jobs"])
        await expect(
          withRewardsBindingDeployment(
            root,
            `apps/${worker}-worker/wrangler.jsonc`,
            "prod",
            async () => {
              called = true;
            },
          ),
        ).rejects.toThrow("both tracked Worker bindings on");
      expect(called).toBe(false);
      await writeFile(
        join(root, "apps/jobs-worker/wrangler.jsonc"),
        '{"env":{"prod":{"vars":{"MEGAPOT_REWARDS_ENABLED":"true"}}}}',
      );
      await withRewardsBindingDeployment(
        root,
        "apps/http-worker/wrangler.jsonc",
        "prod",
        async () => {
          called = true;
        },
      );
      expect(called).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("launch lifecycle is explicit and missing environments fail closed", () => {
    expect(
      rewardsLifecycle('{"schema_version":1,"environments":{"prod":"launched"}}', "prod"),
    ).toBe("launched");
    expect(() => rewardsLifecycle('{"schema_version":1,"environments":{}}', "prod")).toThrow(
      "missing",
    );
    expect(() =>
      rewardsLifecycle('{"schema_version":0,"environments":{"prod":"launched"}}', "prod"),
    ).toThrow("invalid");
  });
  test("uses the selected tracked environment and refuses missing or malformed declarations", () => {
    expect(
      rewardsBinding(
        '{"vars":{"MEGAPOT_REWARDS_ENABLED":"true"},"env":{"staging":{"vars":{"MEGAPOT_REWARDS_ENABLED":"false"}}}}',
        "staging",
      ),
    ).toBe(false);
    expect(
      rewardsBinding(
        '{/* launched */"env":{"prod":{"vars":{"MEGAPOT_REWARDS_ENABLED":"true",}},}}',
        "prod",
      ),
    ).toBe(true);
    for (const source of [
      "{}",
      '{"env":{"staging":{}}}',
      '{"env":{"staging":{"vars":{"MEGAPOT_REWARDS_ENABLED":false}}}}',
    ])
      expect(() => rewardsBinding(source, "staging")).toThrow();
  });

  test("an enabled release preserves obligation visibility without an operator credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "reward-deploy-"));
    try {
      await mkdir(join(root, "apps/jobs-worker"), { recursive: true });
      await mkdir(join(root, "docs"));
      await writeFile(
        join(root, "docs/rewards-deployment-lifecycle.json"),
        '{"schema_version":1,"environments":{"prod":"prelaunch"}}',
      );
      await writeFile(
        join(root, "apps/jobs-worker/wrangler.jsonc"),
        '{"env":{"prod":{"vars":{"MEGAPOT_REWARDS_ENABLED":"true"}}}}',
      );
      let deployed = false;
      expect(
        await withRewardsBindingDeployment(
          root,
          "apps/jobs-worker/wrangler.jsonc",
          "prod",
          async () => {
            deployed = true;
            return "visible";
          },
        ),
      ).toBe("visible");
      expect(deployed).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("maintained guard checks revision before inventory/operation and reports cleanup separately", async () => {
  const events: RewardShutdownObservation[] = [];
  let called = false;
  const db = Object.assign(new EventEmitter(), {
    query: async (sql: string) => {
      if (sql === "ROLLBACK")
        throw Object.assign(Error("private rollback"), { code: "ECONNRESET" });
      if (sql.includes("FOR SHARE"))
        return { rows: [{ state: "paused", paused: true, revision: "10" }] };
      return { rows: [] };
    },
  }) as unknown as Client;
  await expect(
    withRewardsShutdownLock(
      db,
      async () => {
        called = true;
      },
      "api_next",
      {
        expectedRevision: "9",
        observe: (event) => events.push(event),
      },
    ),
  ).rejects.toThrow("revision");
  expect(called).toBe(false);
  expect(events.some((event) => event.stage === "guard-inventory")).toBe(false);
  expect(
    events.find((event) => event.stage === "guard-control" && event.status === "failed")?.failure
      ?.reason,
  ).toBe("revision");
  expect(events.at(-1)?.stage).toBe("guard-rollback");
  expect(events.at(-1)?.failure?.transport).toBe("ECONNRESET");
  expect(JSON.stringify(events)).not.toContain("private");
});

test("a lost guard during an awaited operation reports guard-lost and refuses later work", async () => {
  const db = Object.assign(new EventEmitter(), {
    query: async (sql: string) =>
      sql.includes("FOR SHARE")
        ? { rows: [{ state: "paused", paused: true, revision: "10" }] }
        : { rows: [{ present: false }] },
  }) as unknown as Client;
  const events: RewardShutdownObservation[] = [];
  let later = false;
  await expect(
    withRewardsShutdownLock(
      db,
      async (signal) => {
        db.emit("end");
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else resolve();
        });
        later = true;
      },
      "api_next",
      { expectedRevision: "10", observe: (event) => events.push(event) },
    ),
  ).rejects.toThrow("guard-lost");
  expect(later).toBe(false);
  expect(events.find((e) => e.status === "failed")?.failure?.reason).toBe("guard-lost");
});

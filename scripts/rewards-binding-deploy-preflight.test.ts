import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import {
  REWARD_SHUTDOWN_PREDICATES,
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

async function withStagingRewards(
  phase: "prelaunch" | "launched",
  use: (root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "reward-disabled-preservation-"));
  try {
    await mkdir(join(root, "docs"));
    await writeFile(
      join(root, "docs/rewards-deployment-lifecycle.json"),
      JSON.stringify({ schema_version: 1, environments: { staging: phase } }),
    );
    for (const worker of ["http", "jobs"]) {
      await mkdir(join(root, `apps/${worker}-worker`), { recursive: true });
      await writeFile(
        join(root, `apps/${worker}-worker/wrangler.jsonc`),
        '{"env":{"staging":{"vars":{"MEGAPOT_REWARDS_ENABLED":"true"}}}}',
      );
    }
    await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("effective false cannot bypass the actual shutdown guard when tracked staging is true", async () => {
  await withStagingRewards("prelaunch", async (root) => {
    // The child has no operator/PG/provider environment; a bug cannot contact a database.
    const source = `
      import { withRewardsBindingDeployment } from ${JSON.stringify(new URL("./rewards-binding-deploy-preflight.ts", import.meta.url).href)};
      let called = false;
      try {
        await withRewardsBindingDeployment(${JSON.stringify(root)}, "apps/jobs-worker/wrangler.jsonc", "staging", async () => { called = true; }, "false");
        throw Error("shutdown guard was bypassed");
      } catch (error) {
        if (called || !(error instanceof Error) || error.message !== "reward binding shutdown requires direct operator database URL") throw error;
        console.log("effective-false-shutdown-refused-without-credential");
      }
    `;
    const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", source], {
      env: {
        PATH: process.env.PATH ?? "",
        TMPDIR: tmpdir(),
        XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? tmpdir(),
        BUN_INSTALL_CACHE_DIR: process.env.BUN_INSTALL_CACHE_DIR ?? tmpdir(),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe("effective-false-shutdown-refused-without-credential");
  });
});

test("launched lifecycle refuses effective false even when both tracked bindings are on", async () => {
  await withStagingRewards("launched", async (root) => {
    for (const worker of ["http", "jobs"]) {
      let called = false;
      await expect(
        withRewardsBindingDeployment(
          root,
          `apps/${worker}-worker/wrangler.jsonc`,
          "staging",
          async () => {
            called = true;
          },
          "false",
        ),
      ).rejects.toThrow("effective Worker binding on");
      expect(called).toBe(false);
    }
  });
});

test("disabled preservation parameter refuses non-target and production use before effects", async () => {
  for (const [config, environment] of [
    ["apps/jobs-worker/wrangler.jsonc", "production"],
    ["apps/media-worker/wrangler.jsonc", "staging"],
  ] as const) {
    let called = false;
    await expect(
      withRewardsBindingDeployment(
        "/unused",
        config,
        environment,
        async () => {
          called = true;
        },
        "false",
      ),
    ).rejects.toThrow("only to staging HTTP/Jobs");
    expect(called).toBe(false);
  }
});

test("the existing paused-control lock and every liability predicate remain mandatory through upload", async () => {
  for (const refusal of ["none", "not-paused", "liability"] as const) {
    const queries: string[] = [];
    let inventories = 0;
    let called = false;
    // Instance-local query fake; no real connect, socket request or global pg mock.
    const db = Object.assign(new pg.Client(), {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes("SELECT paused")) return { rows: [{ paused: refusal !== "not-paused" }] };
        if (sql.includes("SELECT EXISTS")) {
          inventories++;
          return { rows: [{ present: refusal === "liability" && inventories === 1 }] };
        }
        return { rows: [] };
      },
    });
    const run = withRewardsShutdownLock(db, async (signal) => {
      called = true;
      expect(signal.aborted).toBe(false);
      expect(queries.some((sql) => sql.endsWith("FOR SHARE"))).toBe(true);
      expect(queries.at(-1)).not.toBe("ROLLBACK");
      return "uploaded";
    });
    if (refusal === "none") {
      expect(await run).toBe("uploaded");
      expect(called).toBe(true);
    } else {
      await expect(run).rejects.toThrow(
        refusal === "not-paused" ? "persisted pause" : "unpaid_credits",
      );
      expect(called).toBe(false);
    }
    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(inventories).toBe(refusal === "not-paused" ? 0 : REWARD_SHUTDOWN_PREDICATES.length);
  }
});

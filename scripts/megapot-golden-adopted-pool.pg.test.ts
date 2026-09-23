import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { assertGoldenAdoptedPool } from "./megapot-golden-adopted-pool.ts";
import { rehearsalInput } from "./megapot-golden-multi.fixture.ts";
import { parseMultiGoldenInput } from "./megapot-golden-multi-input.ts";
import { applyPostgresTestBaselineConnection } from "./postgres-test-baseline.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("Postgres required");
const pgTest = url ? test : test.skip;

pgTest(
  "the app-funded handoff query is valid under a read-only PostgreSQL 17 session",
  async () => {
    if (!url) throw new Error("Postgres required");
    const schema = `golden_adoption_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString: url });
    const scoped = `${url}${url.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await applyPostgresTestBaselineConnection({ connectionString: scoped });
      const reader = new Client({ connectionString: scoped });
      await reader.connect();
      try {
        await reader.query("BEGIN READ ONLY");
        const plan = parseMultiGoldenInput({
          ...rehearsalInput(),
          app_funded_pool: {
            offer_id: "missing-offer",
            leg_id: "missing-leg",
            funding_effect_id: "missing-funding",
            transaction_hash: `0x${"a".repeat(64)}`,
            sender_address: `0x${"b".repeat(40)}`,
          },
        });
        await expect(
          assertGoldenAdoptedPool(reader, plan, "0x036cbd53842c5426634e7929541ec2318f3dcf7e"),
        ).rejects.toThrow("Exact app-funded pool handoff missing");
        expect((await reader.query("SHOW transaction_read_only")).rows[0]).toEqual({
          transaction_read_only: "on",
        });
      } finally {
        await reader.query("ROLLBACK").catch(() => undefined);
        await reader.end();
      }
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await admin.end();
    }
  },
);

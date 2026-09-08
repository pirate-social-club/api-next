import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import {
  assertKaraokeRuntimeGrantDigest,
  readKaraokeRuntimeGrantDigest,
} from "./staging-karaoke-release-database.ts";
import { restoreReviewedResetGrants } from "./staging-persona-grant-catalog.ts";
import type { ResetGrant } from "./staging-persona-grant-reconciliation.ts";
import { localRecoveryTestUrl } from "./staging-persona-recovery-test-target.ts";

const raw = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!raw && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1")
  throw new Error("local test URL required");
const suite = raw ? describe : describe.skip;

suite("release runtime grant readback", () => {
  test("independent committed readback includes inherited and PUBLIC grants and rejects elevated roles", async () => {
    if (!raw) throw new Error("local test URL required");
    const url = localRecoveryTestUrl(raw);
    const name = `release_${crypto.randomUUID().replaceAll("-", "")}`;
    const inherited = `${name}_member`;
    const root = new Client({ connectionString: url.toString() });
    const scoped = new URL(url);
    scoped.pathname = `/${name}`;
    const admin = new Client({ connectionString: scoped.toString() });
    const observer = new Client({ connectionString: scoped.toString() });
    await root.connect();
    try {
      await root.query(`CREATE DATABASE "${name}"`);
      await root.query(`CREATE ROLE "${name}"`);
      await root.query(`CREATE ROLE "${inherited}"`);
      await admin.connect();
      await observer.connect();
      await admin.query("CREATE SCHEMA api_next");
      await admin.query("CREATE TABLE api_next.release_probe(id integer)");
      const reviewed: ResetGrant[] = [
        {
          schema: "api_next",
          objectKind: "table",
          objectIdentity: "api_next.release_probe",
          grantee: name,
          privilege: "SELECT",
          grantOption: false,
        },
      ];
      const before = await readKaraokeRuntimeGrantDigest(observer, name);
      await admin.query("BEGIN");
      await restoreReviewedResetGrants(admin, reviewed, reviewed);
      const expected = await readKaraokeRuntimeGrantDigest(admin, name);
      expect(expected).not.toBe(before);
      expect(await readKaraokeRuntimeGrantDigest(observer, name)).toBe(before);
      await expect(assertKaraokeRuntimeGrantDigest(admin, name, before)).rejects.toThrow(
        "grants_changed",
      );
      await admin.query("ROLLBACK");
      expect(await readKaraokeRuntimeGrantDigest(observer, name)).toBe(before);
      await admin.query("BEGIN");
      await restoreReviewedResetGrants(admin, reviewed, reviewed);
      expect(await assertKaraokeRuntimeGrantDigest(admin, name, expected)).toBe(expected);
      await admin.query("COMMIT");
      expect(await readKaraokeRuntimeGrantDigest(observer, name)).toBe(expected);
      // A later unproven readback must not compensate committed restoration.
      await expect(assertKaraokeRuntimeGrantDigest(observer, name, before)).rejects.toThrow(
        "grants_changed",
      );
      expect(await readKaraokeRuntimeGrantDigest(observer, name)).toBe(expected);
      await admin.query("GRANT INSERT ON api_next.release_probe TO PUBLIC");
      expect(await readKaraokeRuntimeGrantDigest(observer, name)).not.toBe(expected);
      await admin.query("REVOKE INSERT ON api_next.release_probe FROM PUBLIC");
      await root.query(`GRANT "${inherited}" TO "${name}" WITH INHERIT FALSE, SET TRUE`);
      const membership = await readKaraokeRuntimeGrantDigest(observer, name);
      await admin.query(`GRANT UPDATE ON api_next.release_probe TO "${inherited}"`);
      expect(await readKaraokeRuntimeGrantDigest(observer, name)).not.toBe(membership);
      await root.query(`GRANT pg_read_all_data TO "${name}"`);
      await expect(readKaraokeRuntimeGrantDigest(observer, name)).rejects.toThrow(
        "runtime_elevated",
      );
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin.end();
      await observer.end();
      await root.query(`DROP DATABASE IF EXISTS "${name}"`);
      await root.query(`DROP ROLE IF EXISTS "${name}"`);
      await root.query(`DROP ROLE IF EXISTS "${inherited}"`);
      await root.end();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { Client } from "pg";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
}
const suite = url ? describe : describe.skip;
const address = (byte: string) => `0x${byte.repeat(40)}`;
const block = `0x${"a".repeat(64)}`;

suite("runtime reward admission trigger", () => {
  test("owner guard cuts off all writers without runtime control privileges", async () => {
    if (!url) throw new Error("test URL missing");
    const suffix = `${process.pid}_${Date.now()}`;
    const schema = `reward_brake_${suffix}`;
    const runtime = `reward_runtime_${suffix}`;
    const operator = `reward_operator_${suffix}`;
    const admin = new Client({ connectionString: url });
    const writer = new Client({ connectionString: url });
    const pauser = new Client({ connectionString: url });
    const later = new Client({ connectionString: url });
    await Promise.all([admin.connect(), writer.connect(), pauser.connect(), later.connect()]);
    try {
      await admin.query(
        `CREATE ROLE "${runtime}"; CREATE ROLE "${operator}"; CREATE SCHEMA "${schema}"`,
      );
      await admin.query(`SET search_path TO "${schema}"`);
      // Simulate the existing broad default grants. The actual migration must remove them.
      await admin.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT ALL ON TABLES TO "${runtime}";
         ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT EXECUTE ON FUNCTIONS TO "${runtime}"`,
      );
      const baseline = await Bun.file(
        new URL("../../../db/postgres/schema.sql", import.meta.url),
      ).text();
      const nonceDdl = baseline.match(/CREATE TABLE reward_signer_nonces \([\s\S]*?\n\);/u)?.[0];
      if (!nonceDdl) throw new Error("nonce schema missing");
      await admin.query(nonceDdl);
      await admin.query(`CREATE FUNCTION guard_reward_signer_nonce() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
        CREATE TRIGGER reward_signer_nonces_change_guard BEFORE DELETE OR UPDATE ON reward_signer_nonces
          FOR EACH ROW EXECUTE FUNCTION guard_reward_signer_nonce()`);
      await admin.query(
        await Bun.file(
          new URL(
            "../../../db/postgres/migrations/0230_reward_operations_control.sql",
            import.meta.url,
          ),
        ).text(),
      );
      await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${runtime}","${operator}";
        GRANT EXECUTE ON FUNCTION set_reward_operations_paused_v1(BIGINT,BOOLEAN,TEXT) TO "${operator}";
        GRANT SELECT ON reward_operations_control,reward_operations_control_events TO "${operator}"`);
      for (const [client, role] of [
        [writer, runtime],
        [later, runtime],
        [pauser, operator],
      ] as const) {
        await client.query(`SET search_path TO "${schema}"; SET ROLE "${role}"`);
      }
      expect(
        (await writer.query("SELECT paused,revision::text FROM reward_operations_control")).rows,
      ).toEqual([{ paused: true, revision: "0" }]);
      expect(
        (
          await admin.query(`SELECT tgtype::int AS bits FROM pg_trigger
        WHERE tgrelid='reward_signer_nonces'::regclass AND tgname='reward_signer_nonces_change_guard'`)
        ).rows,
      ).toEqual([{ bits: 31 }]); // ROW + BEFORE + INSERT + DELETE + UPDATE.
      expect(
        (
          await admin.query(`SELECT prosecdef,proconfig FROM pg_proc
        WHERE oid='guard_reward_signer_nonce()'::regprocedure`)
        ).rows[0],
      ).toEqual({ prosecdef: true, proconfig: [`search_path=${schema}, pg_temp`] });
      for (const sql of [
        "UPDATE reward_operations_control SET paused=FALSE",
        "DELETE FROM reward_operations_control",
        "TRUNCATE reward_operations_control",
        "INSERT INTO reward_operations_control_events VALUES(9,FALSE,'tamper','runtime',clock_timestamp())",
        "SELECT set_reward_operations_paused_v1(0,FALSE,'tamper')",
      ]) {
        await expect(writer.query(sql)).rejects.toMatchObject({ code: "42501" });
      }
      const insert = (client: Client, signer: string) =>
        client.query(
          `INSERT INTO reward_signer_nonces
        (chain_id,signer_address,next_nonce,observed_pending_nonce,observed_block_number,observed_block_hash,observed_at)
        VALUES(84532,$1,1,0,1,$2,clock_timestamp())`,
          [signer, block],
        );
      await expect(insert(writer, address("1"))).rejects.toMatchObject({ code: "PR001" });
      await expect(
        pauser.query("SELECT set_reward_operations_paused_v1(NULL,FALSE,'invalid')"),
      ).rejects.toMatchObject({ code: "PR002" });
      await expect(
        pauser.query("SELECT set_reward_operations_paused_v1(1,FALSE,'stale')"),
      ).rejects.toMatchObject({ code: "PR002" });
      await pauser.query("SELECT set_reward_operations_paused_v1(0,FALSE,'rehearsal_start')");
      const pid = (await pauser.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      await writer.query("BEGIN");
      await insert(writer, address("1"));
      const pause = pauser.query("SELECT set_reward_operations_paused_v1(1,TRUE,'incident')");
      // Observe the real lock wait rather than assume that a timed sleep proves ordering.
      const deadline = Date.now() + 2_000;
      let waiting = false;
      while (Date.now() < deadline) {
        waiting =
          (
            await admin.query(
              "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
              [pid],
            )
          ).rows[0]?.waiting === true;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      expect((await admin.query("SELECT paused FROM reward_operations_control")).rows).toEqual([
        { paused: false },
      ]);
      const queuedReservation = insert(later, address("2")).then(
        () => null,
        (error) => error,
      );
      await writer.query("COMMIT");
      await pause;
      expect(await queuedReservation).toMatchObject({ code: "PR001" });
      await expect(
        writer.query(`UPDATE reward_signer_nonces SET next_nonce=2,
        fence_version=fence_version+1,updated_at=clock_timestamp()`),
      ).rejects.toMatchObject({ code: "PR001" });
      await writer.query(`UPDATE reward_signer_nonces SET observed_pending_nonce=1,
        observed_block_number=2,fence_version=fence_version+1,observed_at=clock_timestamp(),updated_at=clock_timestamp()`);
      expect(
        (
          await writer.query(
            "SELECT next_nonce::text,fence_version::text FROM reward_signer_nonces",
          )
        ).rows,
      ).toEqual([{ next_nonce: "1", fence_version: "2" }]);
      await expect(writer.query("DELETE FROM reward_signer_nonces")).rejects.toThrow(
        "cannot be deleted",
      );
      await expect(
        writer.query(`UPDATE reward_signer_nonces SET next_nonce=0,
        fence_version=fence_version+1,updated_at=clock_timestamp()`),
      ).rejects.toThrow("invalid reward signer nonce fence update");
      expect(
        (
          await writer.query(
            "SELECT revision::text,paused,reason FROM reward_operations_control_events ORDER BY revision",
          )
        ).rows,
      ).toEqual([
        { revision: "0", paused: true, reason: "environment_initially_paused" },
        { revision: "1", paused: false, reason: "rehearsal_start" },
        { revision: "2", paused: true, reason: "incident" },
      ]);
      await pauser.query("SELECT set_reward_operations_paused_v1(2,TRUE,'idempotent_pause')");
      expect(
        (await writer.query("SELECT count(*)::int AS events FROM reward_operations_control_events"))
          .rows,
      ).toEqual([{ events: 3 }]);
      await expect(
        admin.query("UPDATE reward_operations_control_events SET reason='tamper'"),
      ).rejects.toThrow("append-only");
      await admin.query("TRUNCATE reward_operations_control");
      await expect(insert(writer, address("3"))).rejects.toMatchObject({ code: "PR001" });
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      await Promise.all([writer.end(), pauser.end(), later.end()]);
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.query(
        `DROP OWNED BY "${runtime}","${operator}"; DROP ROLE "${runtime}","${operator}"`,
      );
      await admin.end();
    }
  }, 30_000);
});

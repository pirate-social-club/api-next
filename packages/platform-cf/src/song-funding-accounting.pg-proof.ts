import { expect } from "bun:test";
import { Client } from "pg";

/** An existing temporary trigger must not acquire authority after an upgrade. */
export async function proveExistingAccountingTriggerRefusal(
  url: string,
  upgrade: () => Promise<void>,
) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`CREATE TEMP TABLE purpose_existing_accounting_trigger(leg_id TEXT);
      CREATE CONSTRAINT TRIGGER purpose_existing_accounting_trigger
      AFTER INSERT ON purpose_existing_accounting_trigger DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION validate_asset_bonus_leg_accounting()`);
    await upgrade();
    await client.query("BEGIN");
    await client.query("INSERT INTO purpose_existing_accounting_trigger VALUES('fixture-leg')");
    await expect(client.query("COMMIT")).rejects.toMatchObject({
      code: "42501",
      message: "trusted asset bonus accounting relation required",
    });
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

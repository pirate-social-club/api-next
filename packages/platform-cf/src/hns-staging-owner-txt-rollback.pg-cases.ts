import { expect } from "bun:test";
import type { Client } from "pg";
import { adoptHnsRootZone } from "./hns-zone-adoption.ts";

export async function verifyHnsOwnerTxtLateRollback(
  admin: Client,
  pointers: () => Promise<unknown>,
  adopt: () => Promise<unknown>,
) {
  const before = await pointers();
  await admin.query("CREATE SEQUENCE txt_sale_failure_reached");
  await admin.query(`CREATE FUNCTION reject_txt_successor_sale() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN PERFORM nextval('txt_sale_failure_reached');
       RAISE EXCEPTION 'forced late TXT successor failure'; END $$`);
  await admin.query(`CREATE TRIGGER reject_txt_successor_sale BEFORE INSERT
    ON community_handle_sale_namespace_activation_revisions FOR EACH ROW EXECUTE FUNCTION reject_txt_successor_sale()`);
  try {
    await expect(adopt()).rejects.toThrow();
    // Sequence advancement survives rollback and proves this exact late
    // trigger ran; an unrelated earlier refusal cannot satisfy the test.
    expect(
      (await admin.query("SELECT is_called, last_value::int FROM txt_sale_failure_reached"))
        .rows[0],
    ).toEqual({ is_called: true, last_value: 1 });
    // Includes every selector and every inventory/DNS/app/health/sale row count.
    expect(await pointers()).toEqual(before);
  } finally {
    await admin.query(
      "DROP TRIGGER reject_txt_successor_sale ON community_handle_sale_namespace_activation_revisions",
    );
    await admin.query("DROP FUNCTION reject_txt_successor_sale()");
    await admin.query("DROP SEQUENCE txt_sale_failure_reached");
  }
}

export async function verifyHnsOwnerTxtExpiryDuringObservation(
  admin: Client,
  operator: Client,
  input: Parameters<typeof adoptHnsRootZone>[1],
  pointers: () => Promise<unknown>,
) {
  const before = await pointers();
  let entered = false;
  let waitedThroughExpiry = false;
  await expect(
    adoptHnsRootZone(operator, {
      ...input,
      observe_current: async (state) => {
        entered = true;
        const wait = (
          await admin.query<{ remaining: number }>(`SELECT
        ceil(extract(epoch FROM expires_at-clock_timestamp())*1000)::int AS remaining
        FROM community_route_ownership_evidence WHERE evidence_ref='owner-txt-evidence'`)
        ).rows[0]?.remaining;
        if (wait === undefined || wait < 0 || wait > 5000)
          throw new Error("invalid owner TXT expiry fixture");
        await Bun.sleep(wait + 50);
        waitedThroughExpiry = true;
        return input.observe_current(state);
      },
    }),
  ).rejects.toThrow("recovery lineage is unavailable");
  expect(entered).toBe(true);
  expect(waitedThroughExpiry).toBe(true);
  expect(await pointers()).toEqual(before);
}

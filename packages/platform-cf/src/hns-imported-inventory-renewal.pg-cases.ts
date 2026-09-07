import { expect } from "bun:test";
import { Client } from "pg";
import { issueImportedRootHandleFixture } from "./hns-imported-inventory-handle.pg-fixture.ts";
import {
  finalizeImportedInventoryRenewal,
  HnsInventoryRenewalCommitUnknown,
} from "./hns-imported-inventory-renewal.ts";

export async function verifyHnsImportedInventoryRenewal(
  admin: Client,
  connection: string,
  ready: (
    environment?: "test" | "production",
    validForSeconds?: number,
  ) => Promise<{ result_bytes: Uint8Array; result_sha256: string }>,
) {
  await admin.query(
    "DROP FUNCTION IF EXISTS prepare_hns_root_inventory_renewal_v1(text,text,bigint,text,text,bytea,text,text)",
  );
  await admin.query(
    "ALTER TABLE hns_root_health_renewal_jobs DROP COLUMN IF EXISTS expected_app_generation, DROP COLUMN IF EXISTS expected_sale_generation",
  );
  // Execute the forward migration against a populated, already-serving root.
  await admin.query(
    await Bun.file(
      new URL(
        "../../../db/postgres/migrations/0121_hns_imported_inventory_renewal.sql",
        import.meta.url,
      ),
    ).text(),
  );
  const pointers = async () =>
    (
      await admin.query(`SELECT dns.current_generation AS dns, app.current_generation AS app, sale.current_generation AS sale,
    (SELECT count(*)::int FROM hns_authority_inventories) AS inventories
    FROM hns_dns_zone_activation_current dns, hns_community_app_host_activation_current app, community_handle_sale_namespace_activation_current sale`)
    ).rows;
  const verifyHandle = await issueImportedRootHandleFixture(admin, connection);
  await verifyHandle();
  const before = await pointers();
  const claim = async () => {
    await admin.query("SELECT * FROM schedule_hns_root_health_renewals_v1(25,259200,7200)");
    const row = (
      await admin.query(
        "SELECT * FROM claim_hns_root_health_renewal_job_v1('inventory-executor',60)",
      )
    ).rows[0];
    if (row === undefined) throw new Error("Expected inventory renewal claim");
    return {
      observation_job_id: String(row.observation_job_id),
      executor_id: "inventory-executor",
      lease_fence: Number(row.lease_fence),
      request_sha256: String(row.request_sha256),
      ...(await ready()),
    };
  };
  // Inventory, not health, is the earlier serving bound for this old root.
  await admin.query(`SELECT record_hns_dns_zone_health_v1('fixture-long-health','fixture-long-health',repeat('f',64),
    dns_zone_activation_id, activation_generation, health_generation,
    stable_chain_delegation_snapshot_reference,stable_chain_delegation_snapshot_digest,
    observed_zone_bytes_digest,observed_dnssec_keyset_reference,observed_dnssec_keyset_version,
    observed_gateway_deployment_reference,observed_gateway_certificate_spki_sha256,
    true,true,true,true,518400) FROM hns_dns_zone_health_observations`);
  await Bun.sleep(5100);
  expect(
    (
      await admin.query(
        "SELECT * FROM resolve_hns_community_app_host_authority_v1('app.newroot',clock_timestamp())",
      )
    ).rows[0]?.stable_chain_delegation_matches,
  ).toBe(false);
  const first = await claim();
  const contender = new Client({ connectionString: connection });
  await contender.connect();
  try {
    await expect(
      finalizeImportedInventoryRenewal(contender, { ...first, ...(await ready("production")) }),
    ).rejects.toThrow("environment changed");
    await expect(
      finalizeImportedInventoryRenewal(contender, {
        ...first,
        ...(await ready(undefined, 604801)),
      }),
    ).rejects.toThrow();
    expect(await pointers()).toEqual(before);
    expect(
      (await contender.query("SELECT * FROM claim_hns_root_health_renewal_job_v1('duplicate',60)"))
        .rows,
    ).toEqual([]);
    await admin.query(
      "CREATE FUNCTION reject_inventory_sale_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'late sale refusal'; END $$",
    );
    await admin.query(
      "CREATE TRIGGER reject_inventory_sale_fixture BEFORE INSERT ON community_handle_sale_namespace_activation_revisions FOR EACH ROW EXECUTE FUNCTION reject_inventory_sale_fixture()",
    );
    await expect(finalizeImportedInventoryRenewal(contender, first)).rejects.toThrow();
    expect(await pointers()).toEqual(before);
    expect(
      (
        await admin.query(
          "SELECT state FROM hns_root_health_renewal_jobs WHERE renewal_job_id=$1",
          [first.observation_job_id],
        )
      ).rows[0]?.state,
    ).toBe("leased");
    await admin.query(
      "DROP TRIGGER reject_inventory_sale_fixture ON community_handle_sale_namespace_activation_revisions",
    );
    expect((await finalizeImportedInventoryRenewal(contender, first)).outcome).toBe("ready");
    await verifyHandle();
    const promoted = await pointers();
    expect(promoted).toEqual([
      { dns: "2", app: "2", sale: "2", inventories: before[0].inventories + 1 },
    ]);
    expect((await finalizeImportedInventoryRenewal(contender, first)).outcome).toBe("replayed");
    expect(await pointers()).toEqual(promoted);
    const second = await claim();
    expect(second.observation_job_id).not.toBe(first.observation_job_id);
    expect((await finalizeImportedInventoryRenewal(contender, second)).outcome).toBe("ready");
    expect(await pointers()).toEqual([
      { dns: "3", app: "3", sale: "3", inventories: before[0].inventories + 2 },
    ]);
    expect((await finalizeImportedInventoryRenewal(contender, first)).outcome).toBe("replayed");
    // A COMMIT can succeed even when its acknowledgement is lost.
    const third = await claim();
    const ambiguous = new Proxy(contender, {
      get(target, property) {
        if (property === "query")
          return async (...args: Parameters<Client["query"]>) => {
            const result = await Reflect.apply(target.query, target, args);
            if (args[0] === "COMMIT") throw new Error("fixture lost commit acknowledgement");
            return result;
          };
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(finalizeImportedInventoryRenewal(ambiguous, third)).rejects.toBeInstanceOf(
      HnsInventoryRenewalCommitUnknown,
    );
    expect((await finalizeImportedInventoryRenewal(contender, third)).outcome).toBe("replayed");
    const committed = await pointers();
    expect(committed[0]).toMatchObject({ dns: "4", app: "4", sale: "4" });
    const late = await claim();
    await admin.query(
      "UPDATE hns_root_health_renewal_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE renewal_job_id=$1",
      [late.observation_job_id],
    );
    expect((await finalizeImportedInventoryRenewal(contender, late)).outcome).toBe("lost");
    expect(await pointers()).toEqual(committed);
    await admin.query(
      "UPDATE hns_root_health_renewal_jobs SET lease_expires_at=clock_timestamp()+interval '60 seconds', expected_sale_generation=expected_sale_generation-1 WHERE renewal_job_id=$1",
      [late.observation_job_id],
    );
    expect((await finalizeImportedInventoryRenewal(contender, late)).outcome).toBe("retry");
    expect(await pointers()).toEqual(committed);
    await admin.query(
      "UPDATE hns_root_health_renewal_jobs SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE state='delayed'",
    );
    const recovered = await claim();
    expect(recovered.observation_job_id).toBe(late.observation_job_id);
    expect(recovered.lease_fence).toBeGreaterThan(late.lease_fence);
    expect((await finalizeImportedInventoryRenewal(contender, late)).outcome).toBe("lost");
    expect((await finalizeImportedInventoryRenewal(contender, recovered)).outcome).toBe("ready");
    await verifyHandle();
    const serving = (
      await admin.query(
        "SELECT * FROM resolve_hns_community_app_host_authority_v1('app.newroot',clock_timestamp())",
      )
    ).rows[0];
    expect(serving?.stable_chain_delegation_matches).toBe(true);
  } finally {
    await contender.end();
  }
}

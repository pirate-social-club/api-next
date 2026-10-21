import { expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  decodeHnsRootImportReadinessResultV1,
  encodeHnsRootImportReadinessResultV1,
} from "@pirate/application/namespace-ownership";
import { Client } from "pg";
import { finalizeImportedInventoryRenewal } from "./hns-imported-inventory-renewal.ts";
import { adoptHnsRootZone, readHnsRootZoneAdoptionState } from "./hns-zone-adoption.ts";
import {
  hnsZoneAdoptionFixtureZone,
  redateHnsZoneAdoptionFixture,
} from "./hns-zone-adoption-fixture.ts";

type Artifact = Readonly<{ result_bytes: Uint8Array; result_sha256: string }>;
/** Exercise actual successor promotion, rollback and renewal on a staging import. */
export async function verifyHnsStagingRelocation(
  admin: Client,
  connection: string,
  artifact: (zone: Uint8Array, serial: number) => Promise<Artifact>,
) {
  const operator = new Client({ connectionString: connection });
  await operator.connect();
  try {
    const before = await readHnsRootZoneAdoptionState(operator, "newroot");
    const manifest_json = JSON.stringify({
      schema: "pirate-hns-community-app-handle-gateway-staging-public-v1",
      mode: "staging-public-tls",
      public_tls_listener: "94.103.168.209:443",
      profile_sha256: "cd".repeat(32),
      handle_profile_sha256: "ef".repeat(32),
      gateway_certificate_spki_sha256: before.gateway_certificate_spki_sha256,
    });
    const gateway = `hns-community-app-handle-gateway-sha256:${createHash("sha256").update(manifest_json).digest("hex")}`;
    const make = async (serial: number, observedAt?: string) => {
      const zone = JSON.parse(
        new TextDecoder().decode(hnsZoneAdoptionFixtureZone("newroot", serial, false)),
      );
      zone.records = zone.records.map((record: [string, number, number, number, string]) =>
        record[1] === 1 ? [record[0], 1, record[2], record[3], "5e67a8d1"] : record,
      );
      const base = await artifact(new TextEncoder().encode(JSON.stringify(zone)), serial);
      const decoded = await decodeHnsRootImportReadinessResultV1(base.result_bytes);
      const moved = await encodeHnsRootImportReadinessResultV1({
        ...decoded.result,
        gateway_deployment_reference: gateway,
      });
      return observedAt === undefined
        ? moved
        : redateHnsZoneAdoptionFixture(moved.result_bytes, observedAt);
    };
    const observed = await make(8);
    const decoded = await decodeHnsRootImportReadinessResultV1(observed.result_bytes);
    const review = {
      version: "hns-reviewed-staging-gateway-relocation-v1",
      root_label: "newroot",
      previous_generation: before.current_generation,
      previous_health_generation: before.current_health_generation,
      previous_gateway_ipv4: "192.0.2.10",
      gateway_ipv4: "94.103.168.209",
      previous_chain_records: [],
      chain_records: [],
      gateway_rotation: {
        version: "hns-reviewed-gateway-rotation-v1",
        previous_gateway_reference: before.gateway_deployment_reference,
        gateway_reference: gateway,
        profile_sha256: "cd".repeat(32),
        handle_profile_sha256: "ef".repeat(32),
        manifest_json,
        observed_at: decoded.result.observed_at,
        readiness: "operator_attested_shadow_ready",
      },
    };
    let liveSerial = 8;
    const request = (mode: "dry-run" | "rehearse" | "commit", reviewed: unknown = review) => ({
      ...observed,
      expected_result_sha256: observed.result_sha256,
      expected_delta: "staging_gateway_relocated" as const,
      mode,
      reviewed_relocation: reviewed,
      observe_current: async (state: { database_time: string }) =>
        (await make(liveSerial, state.database_time)).result_bytes,
    });
    await expect(adoptHnsRootZone(operator, request("commit", null))).rejects.toThrow("malformed");
    for (const patch of [
      { previous_generation: before.current_generation + 1 },
      { previous_health_generation: before.current_health_generation + 1 },
      { chain_records: [{ type: "TXT", txt: ["unreviewed"] }] },
    ])
      await expect(
        adoptHnsRootZone(operator, request("commit", { ...review, ...patch })),
      ).rejects.toThrow();
    expect((await adoptHnsRootZone(operator, request("dry-run"))).committed).toBe(false);
    expect((await adoptHnsRootZone(operator, request("rehearse"))).committed).toBe(false);
    expect((await readHnsRootZoneAdoptionState(operator, "newroot")).current_generation).toBe(
      before.current_generation,
    );
    liveSerial = 9;
    await expect(adoptHnsRootZone(operator, request("commit"))).rejects.toThrow("no longer serve");
    liveSerial = 8;
    expect((await adoptHnsRootZone(operator, request("commit"))).committed).toBe(true);
    const after = await readHnsRootZoneAdoptionState(operator, "newroot");
    expect(after.current_generation).toBe(before.current_generation + 1);
    expect(after.gateway_deployment_reference).toBe(gateway);
    expect(after.gateway_certificate_spki_sha256).toBe(before.gateway_certificate_spki_sha256);
    expect(after.dnssec_keyset_version).toBe(before.dnssec_keyset_version);
    await expect(adoptHnsRootZone(operator, request("commit"))).rejects.toThrow(
      "predecessor fence",
    );
    await admin.query("SELECT * FROM schedule_hns_root_health_renewals_v1(25,259200,7200)");
    const job = (
      await admin.query(
        "SELECT * FROM claim_hns_root_health_renewal_job_v1('relocation-renewal',60)",
      )
    ).rows[0];
    expect(job).toBeDefined();
    expect(
      (
        await finalizeImportedInventoryRenewal(operator, {
          ...(await make(8)),
          observation_job_id: job.observation_job_id,
          executor_id: "relocation-renewal",
          lease_fence: Number(job.lease_fence),
          request_sha256: job.request_sha256,
        })
      ).outcome,
    ).toBe("ready");
    expect((await readHnsRootZoneAdoptionState(operator, "newroot")).current_generation).toBe(
      before.current_generation + 2,
    );
  } finally {
    await operator.end();
  }
}

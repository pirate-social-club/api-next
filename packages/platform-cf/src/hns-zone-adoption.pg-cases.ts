import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "pg";
import { finalizeImportedInventoryRenewal } from "./hns-imported-inventory-renewal.ts";
import {
  adoptHnsRootZone,
  hnsRootZoneAdoptionObservationRequestBytes,
  readHnsRootZoneAdoptionState,
  withHnsRootZoneAdoptionFence,
} from "./hns-zone-adoption.ts";

type Artifact = Readonly<{ result_bytes: Uint8Array; result_sha256: string }>;

/**
 * Adoption against an activated, already renewed root. The fixture's zones
 * are opaque bytes, not canonical authority zones, so the database behaviour
 * is exercised with a stand-in for the difference check and the real check is
 * shown to be the default by refusing those bytes. The real check has its own
 * unit tests.
 */
export async function verifyHnsZoneAdoption(
  admin: Client,
  connection: string,
  artifact: (zone?: Uint8Array) => Promise<Artifact>,
) {
  const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const pointers = async () =>
    (
      await admin.query<{ dns: string; app: string; sale: string; inventories: number }>(
        `SELECT dns.current_generation AS dns, app.current_generation AS app, sale.current_generation AS sale,
          (SELECT count(*)::int FROM hns_authority_inventories) AS inventories
          FROM hns_dns_zone_activation_current dns, hns_community_app_host_activation_current app,
               community_handle_sale_namespace_activation_current sale`,
      )
    ).rows;
  const retainedDigest = async () =>
    (
      await admin.query<{ digest: string }>(
        `SELECT revision.zone_bytes_digest AS digest
           FROM hns_dns_zone_activation_current dns
           JOIN hns_dns_zone_activation_revisions revision
             ON revision.dns_zone_activation_id = dns.dns_zone_activation_id
            AND revision.dns_zone_activation_generation = dns.current_generation`,
      )
    ).rows[0]?.digest;
  const before = await pointers();
  const generation = Number(before[0]?.dns);
  const priorDigest = await retainedDigest();
  const adoptedZone = new TextEncoder().encode(
    JSON.stringify({ root_label: "newroot", serial: 8, managed: true, adopted: true }),
  );
  const observation = await artifact(adoptedZone);
  const added = () => "wildcard_family_added" as const;
  const request = (mode: "dry-run" | "rehearse" | "commit", observed: Artifact = observation) => ({
    result_bytes: observed.result_bytes,
    expected_result_sha256: observed.result_sha256,
    expected_delta: "wildcard_family_added" as const,
    mode,
  });
  const operator = new Client({ connectionString: connection });
  await operator.connect();
  const bystander = new Client({ connectionString: connection });
  await bystander.connect();
  const shareRoot = () =>
    bystander.query(
      "SELECT 1 FROM hns_dns_zone_activation_current WHERE canonical_root = 'newroot' FOR SHARE NOWAIT",
    );
  try {
    // The state an operator is shown, and the request an observation is given:
    // the same bytes the database encodes for a renewal of this session.
    const state = await readHnsRootZoneAdoptionState(operator, "newroot");
    expect(state).toMatchObject({
      session_status: "activated",
      current_generation: generation,
      retained_zone_bytes_sha256: priorDigest,
      open_renewal_jobs: 0,
    });
    expect(state.serving_valid_for_seconds).toBeGreaterThan(0);
    expect(
      Buffer.from(hnsRootZoneAdoptionObservationRequestBytes(state)).equals(
        (
          await admin.query<{ request_bytes: Buffer }>(
            "SELECT request_bytes FROM encode_hns_root_readiness_observation_request_v1($1)",
            [state.root_import_session_id],
          )
        ).rows[0]?.request_bytes ?? Buffer.alloc(0),
      ),
    ).toBe(true);
    await expect(readHnsRootZoneAdoptionState(operator, "otherroot")).rejects.toThrow(
      "no single activated session",
    );

    // The fence for the change at the authorities refuses a root too close to
    // expiry for the change and its adoption to finish before a renewal is
    // scheduled, as the fixture's root is at this point.
    await expect(
      withHnsRootZoneAdoptionFence(
        operator,
        { root_label: "newroot", minimum_serving_validity_seconds: 3_600 },
        async () => "changed",
      ),
    ).rejects.toThrow("too close to expiry");
    expect(await pointers()).toEqual(before);

    // The observation must be the bytes that were reviewed.
    await expect(
      adoptHnsRootZone(
        operator,
        { ...request("dry-run"), expected_result_sha256: "0".repeat(64) },
        added,
      ),
    ).rejects.toThrow("not the one that was reviewed");

    // Without a stand-in the real difference check runs, and it refuses zones
    // that are not canonical authority zones before anything is promoted.
    await expect(adoptHnsRootZone(operator, request("rehearse"))).rejects.toThrow(
      "not a canonical authority zone",
    );
    expect(await pointers()).toEqual(before);

    // The difference found must be the one the operator named.
    await expect(
      adoptHnsRootZone(operator, { ...request("rehearse"), expected_delta: "serial_only" }, added),
    ).rejects.toThrow("not the one intended");

    // Every other binding of the renewal preparation still applies: an
    // observation carrying a gateway reference that is not the current
    // revision's is refused.
    const foreign = JSON.parse(new TextDecoder().decode(observation.result_bytes));
    foreign.gateway_deployment_reference = `${foreign.gateway_deployment_reference}-superseded`;
    const foreignBytes = new TextEncoder().encode(JSON.stringify(foreign));
    await expect(
      adoptHnsRootZone(
        operator,
        request("rehearse", { result_bytes: foreignBytes, result_sha256: sha256(foreignBytes) }),
        added,
      ),
    ).rejects.toThrow("not the current revision's");
    expect(await pointers()).toEqual(before);

    // A dry run reads; a rehearsal promotes and rolls back. Neither moves anything.
    expect(await adoptHnsRootZone(operator, request("dry-run"), added)).toMatchObject({
      committed: false,
      delta: "wildcard_family_added",
      previous_generation: generation,
      next_generation: generation + 1,
      previous_zone_bytes_sha256: priorDigest,
      next_zone_bytes_sha256: sha256(adoptedZone),
    });
    expect((await adoptHnsRootZone(operator, request("rehearse"), added)).committed).toBe(false);
    expect(await pointers()).toEqual(before);
    expect(await retainedDigest()).toBe(priorDigest);

    // Commit: DNS, app host and sale advance together, a new inventory exists,
    // the retained zone is the observed one, and the app host still resolves.
    expect((await adoptHnsRootZone(operator, request("commit"), added)).committed).toBe(true);
    const adopted = await pointers();
    expect(adopted).toEqual([
      {
        dns: String(generation + 1),
        app: String(generation + 1),
        sale: String(generation + 1),
        inventories: (before[0]?.inventories ?? 0) + 1,
      },
    ]);
    expect(await retainedDigest()).toBe(sha256(adoptedZone));
    expect(
      (
        await admin.query(
          "SELECT * FROM resolve_hns_community_app_host_authority_v1('app.newroot',clock_timestamp())",
        )
      ).rows[0]?.stable_chain_delegation_matches,
    ).toBe(true);

    // The adopted root is valid for two days. The fence now admits a change,
    // and while that change runs nothing else can take the root's pointer
    // row, which a renewal claim shares. It writes nothing itself.
    expect(
      await withHnsRootZoneAdoptionFence(
        operator,
        { root_label: "newroot", minimum_serving_validity_seconds: 3_600 },
        async (fenced) => {
          await expect(shareRoot()).rejects.toMatchObject({ code: "55P03" });
          return fenced.current_generation;
        },
      ),
    ).toBe(generation + 1);
    await shareRoot();
    await expect(
      withHnsRootZoneAdoptionFence(
        operator,
        { root_label: "newroot", minimum_serving_validity_seconds: 604_800 },
        async () => "changed",
      ),
    ).rejects.toThrow("too close to expiry");
    expect(await pointers()).toEqual(adopted);

    // Ordinary renewal afterwards. The preparation now holds a renewal to the
    // adopted zone: an observation of the earlier zone ends the job, and one
    // of the adopted zone renews.
    const claim = async () => {
      await admin.query("SELECT * FROM schedule_hns_root_health_renewals_v1(25,259200,7200)");
      const row = (
        await admin.query(
          "SELECT * FROM claim_hns_root_health_renewal_job_v1('adoption-executor',60)",
        )
      ).rows[0];
      if (row === undefined) throw new Error("Expected a renewal claim after adoption");
      return {
        observation_job_id: String(row.observation_job_id),
        executor_id: "adoption-executor",
        lease_fence: Number(row.lease_fence),
        request_sha256: String(row.request_sha256),
      };
    };
    const lease = await claim();
    const earlier = await artifact();
    await admin.query("BEGIN");
    try {
      expect(
        (
          await admin.query(
            "SELECT outcome FROM prepare_hns_root_inventory_renewal_v1($1,$2,$3,$4,'ready',$5,encode(sha256($5),'hex'),NULL)",
            [
              lease.observation_job_id,
              lease.executor_id,
              lease.lease_fence,
              lease.request_sha256,
              Buffer.from(earlier.result_bytes),
            ],
          )
        ).rows[0]?.outcome,
      ).toBe("failed");
    } finally {
      await admin.query("ROLLBACK");
    }
    expect(
      (
        await finalizeImportedInventoryRenewal(operator, {
          ...lease,
          ...(await artifact(adoptedZone)),
        })
      ).outcome,
    ).toBe("ready");
    expect((await pointers())[0]).toMatchObject({ dns: String(generation + 2) });
    expect(await retainedDigest()).toBe(sha256(adoptedZone));

    // An open renewal job for the current generation fences adoption.
    await admin.query("SELECT * FROM schedule_hns_root_health_renewals_v1(25,259200,7200)");
    await expect(
      adoptHnsRootZone(
        operator,
        request("rehearse", await artifact(new TextEncoder().encode("later"))),
        added,
      ),
    ).rejects.toThrow("renewal job for the root's current generation is open");
    await expect(
      withHnsRootZoneAdoptionFence(
        operator,
        { root_label: "newroot", minimum_serving_validity_seconds: 3_600 },
        async () => "changed",
      ),
    ).rejects.toThrow("renewal job for the root's current generation is open");
  } finally {
    await operator.end();
    await bystander.end();
  }
}

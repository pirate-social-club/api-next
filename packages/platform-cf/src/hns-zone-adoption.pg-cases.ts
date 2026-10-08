import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "pg";
import { finalizeImportedInventoryRenewal } from "./hns-imported-inventory-renewal.ts";
import {
  adoptHnsRootZone,
  type HnsZoneAdoptionMode,
  hnsRootZoneAdoptionObservationRequestBytes,
  readHnsRootZoneAdoptionState,
  withHnsRootZoneAdoptionFence,
} from "./hns-zone-adoption.ts";
import type { HnsZoneAdoptionDeltaKind } from "./hns-zone-adoption-delta.ts";
import { hnsZoneAdoptionFixtureZone } from "./hns-zone-adoption-fixture.ts";

type Artifact = Readonly<{ result_bytes: Uint8Array; result_sha256: string }>;
type Observed = Readonly<{ zone?: Uint8Array; serial?: number; observed_seconds_ago?: number }>;

/**
 * Adoption against an activated, already renewed root whose retained zone is
 * the fixture's canonical zone at serial 7 without the wildcard address
 * records. Every case runs the real difference rule. The observations are the
 * fixture's readiness results carrying a later zone; the primary's serial,
 * which adoption reads through a port, is a variable here.
 */
export async function verifyHnsZoneAdoption(
  admin: Client,
  connection: string,
  artifact: (observed?: Observed) => Promise<Artifact>,
) {
  const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const zone = (serial: number, family: boolean) =>
    hnsZoneAdoptionFixtureZone("newroot", serial, family);
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
  expect(priorDigest).toBe(sha256(zone(7, false)));

  // What the primary authority reports as its serial when adoption asks.
  let served = 8;
  const added = await artifact({ zone: zone(8, true), serial: 8 });
  const request = (
    mode: HnsZoneAdoptionMode,
    observed: Artifact = added,
    delta: HnsZoneAdoptionDeltaKind = "wildcard_family_added",
  ) => ({
    result_bytes: observed.result_bytes,
    expected_result_sha256: observed.result_sha256,
    expected_delta: delta,
    mode,
    served_zone_serial: async () => served,
  });
  const fence = (departs: boolean, minimum = 3_600) => ({
    root_label: "newroot",
    minimum_serving_validity_seconds: minimum,
    departs: () => departs,
  });
  const operator = new Client({ connectionString: connection });
  await operator.connect();
  const bystander = new Client({ connectionString: connection });
  await bystander.connect();
  const probe = (table: string, column: string, lock: string) =>
    bystander.query(`SELECT 1 FROM ${table} WHERE ${column} = 'newroot' FOR ${lock} NOWAIT`);
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

    // The fixture's root is within an hour of expiry. A change that takes its
    // zone away from the retained one is refused; one that brings it back is
    // not, because that is how a change is withdrawn.
    await expect(
      withHnsRootZoneAdoptionFence(operator, fence(true), async () => "changed"),
    ).rejects.toThrow("too close to expiry");
    expect(
      await withHnsRootZoneAdoptionFence(operator, fence(false), async () => "withdrawn"),
    ).toBe("withdrawn");
    expect(await pointers()).toEqual(before);

    // The observation must be the bytes that were reviewed, and the
    // difference found must be the one the operator named.
    await expect(
      adoptHnsRootZone(operator, { ...request("dry-run"), expected_result_sha256: "0".repeat(64) }),
    ).rejects.toThrow("not the one that was reviewed");
    await expect(
      adoptHnsRootZone(operator, request("rehearse", added, "serial_only")),
    ).rejects.toThrow("the zone difference is wildcard_family_added, not the one intended");

    // A zone that changed anywhere else, here in the app host's address, and
    // a zone that is not a canonical one at all.
    const elsewhere = new TextEncoder().encode(
      new TextDecoder()
        .decode(zone(8, true))
        .replace('["app.newroot",1,1,300,"c000020a"]', '["app.newroot",1,1,300,"c0000263"]'),
    );
    expect(sha256(elsewhere)).not.toBe(sha256(zone(8, true)));
    await expect(
      adoptHnsRootZone(
        operator,
        request("rehearse", await artifact({ zone: elsewhere, serial: 8 })),
      ),
    ).rejects.toThrow("the zone changed outside the wildcard address records");
    await expect(
      adoptHnsRootZone(
        operator,
        request(
          "rehearse",
          await artifact({ zone: new TextEncoder().encode('{"serial":8}'), serial: 8 }),
        ),
      ),
    ).rejects.toThrow("not a canonical authority zone");

    // Every other binding of the renewal preparation still applies. Each of
    // these observations differs from the good one in a single field.
    const altered = (field: string, value: unknown): Artifact => {
      const result = JSON.parse(new TextDecoder().decode(added.result_bytes));
      result[field] = value;
      const bytes = new TextEncoder().encode(JSON.stringify(result));
      return { result_bytes: bytes, result_sha256: sha256(bytes) };
    };
    const good = JSON.parse(new TextDecoder().decode(added.result_bytes));
    for (const [field, value, refusal] of [
      [
        "gateway_deployment_reference",
        `${good.gateway_deployment_reference}-superseded`,
        "not the current revision's",
      ],
      ["gateway_certificate_spki_sha256", "f".repeat(64), "not the current revision's"],
      ["dnssec_keyset_version", "f".repeat(64), "not the current revision's"],
      ["chain_resource_sha256", "f".repeat(64), "not the current revision's"],
      ["ownership_result_sha256", "f".repeat(64), "not bound to the root's session"],
      ["provision_result_sha256", "f".repeat(64), "not bound to the root's session"],
    ] as const) {
      await expect(
        adoptHnsRootZone(operator, request("rehearse", altered(field, value))),
        field,
      ).rejects.toThrow(refusal);
    }

    // An observation older than adoption admits, in a dry run as in a commit,
    // and a zone whose serial at the primary moved after it was observed.
    await expect(
      adoptHnsRootZone(
        operator,
        request(
          "dry-run",
          await artifact({ zone: zone(8, true), serial: 8, observed_seconds_ago: 1_000 }),
        ),
      ),
    ).rejects.toThrow("the observation is stale");
    served = 9;
    for (const mode of ["dry-run", "rehearse", "commit"] as const) {
      await expect(adoptHnsRootZone(operator, request(mode))).rejects.toThrow(
        "no longer serve the zone that was observed",
      );
    }
    served = 8;
    expect(await pointers()).toEqual(before);

    // A dry run reads; a rehearsal promotes and rolls back. Neither moves anything.
    expect(await adoptHnsRootZone(operator, request("dry-run"))).toMatchObject({
      committed: false,
      delta: "wildcard_family_added",
      previous_generation: generation,
      next_generation: generation + 1,
      previous_zone_bytes_sha256: priorDigest,
      next_zone_bytes_sha256: sha256(zone(8, true)),
      open_renewal_jobs: 0,
    });
    expect((await adoptHnsRootZone(operator, request("rehearse"))).committed).toBe(false);
    expect(await pointers()).toEqual(before);
    expect(await retainedDigest()).toBe(priorDigest);

    // Commit: DNS, app host and sale advance together, a new inventory exists,
    // the retained zone is the observed one, the app host still resolves, and
    // the successor's operations carry adoption's own identifiers.
    expect((await adoptHnsRootZone(operator, request("commit"))).committed).toBe(true);
    const adopted = await pointers();
    expect(adopted).toEqual([
      {
        dns: String(generation + 1),
        app: String(generation + 1),
        sale: String(generation + 1),
        inventories: (before[0]?.inventories ?? 0) + 1,
      },
    ]);
    expect(await retainedDigest()).toBe(sha256(zone(8, true)));
    expect(
      (
        await admin.query(
          "SELECT * FROM resolve_hns_community_app_host_authority_v1('app.newroot',clock_timestamp())",
        )
      ).rows[0]?.stable_chain_delegation_matches,
    ).toBe(true);
    expect(
      (
        await admin.query<{ adoption: number; renewal: number }>(
          `SELECT count(*) FILTER (WHERE operation_id LIKE 'hns-zone-adoption:%')::int AS adoption,
                  count(*) FILTER (WHERE operation_id LIKE $1)::int AS renewal
             FROM hns_dns_zone_health_operations`,
          [`hns-inventory-renewal:%${added.result_sha256}`],
        )
      ).rows[0],
    ).toEqual({ adoption: 1, renewal: 0 });
    // The same observation cannot be adopted twice: its zone is now retained.
    await expect(adoptHnsRootZone(operator, request("rehearse"))).rejects.toThrow(
      "the SOA serial did not increase",
    );

    // The adopted root is valid for two days. The fence now admits a
    // departing change, and while that change runs nothing else can take the
    // session row or the pointer row, which a renewal claim shares and a
    // renewal preparation takes; a row that only refers to the session can
    // still be inserted. It writes nothing itself.
    expect(
      await withHnsRootZoneAdoptionFence(operator, fence(true), async (fenced) => {
        for (const [table, column] of [
          ["hns_dns_zone_activation_current", "canonical_root"],
          ["hns_root_import_sessions", "root_label"],
        ] as const) {
          await expect(probe(table, column, "SHARE"), table).rejects.toMatchObject({
            code: "55P03",
          });
          await expect(probe(table, column, "UPDATE"), table).rejects.toMatchObject({
            code: "55P03",
          });
        }
        await probe("hns_root_import_sessions", "root_label", "KEY SHARE");
        return fenced.current_generation;
      }),
    ).toBe(generation + 1);
    await probe("hns_dns_zone_activation_current", "canonical_root", "SHARE");
    await expect(
      withHnsRootZoneAdoptionFence(operator, fence(true, 604_800), async () => "changed"),
    ).rejects.toThrow("too close to expiry");
    expect(await pointers()).toEqual(adopted);

    // A fence whose database connection is lost while the change runs fails,
    // and tells the change so through its signal.
    const dropped = new Client({ connectionString: connection });
    await dropped.connect();
    dropped.on("error", () => undefined);
    const backend = (await dropped.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
      ?.pid;
    let aborted = false;
    await expect(
      withHnsRootZoneAdoptionFence(dropped, fence(true), async (_state, signal) => {
        await admin.query("SELECT pg_terminate_backend($1)", [backend]);
        for (let waited = 0; waited < 50 && !signal.aborted; waited += 1) await Bun.sleep(100);
        aborted = signal.aborted;
        return "changed";
      }),
    ).rejects.toThrow();
    expect(aborted).toBe(true);
    await dropped.end().catch(() => undefined);

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
          ...(await artifact({ zone: zone(8, true), serial: 8 })),
        })
      ).outcome,
    ).toBe("ready");
    expect((await pointers())[0]).toMatchObject({ dns: String(generation + 2) });
    expect(await retainedDigest()).toBe(sha256(zone(8, true)));

    // The addition is withdrawn after it was committed: the exact reverse is
    // adopted, and the retained zone is again one without the records.
    served = 9;
    const removed = await artifact({ zone: zone(9, false), serial: 9 });
    await expect(
      adoptHnsRootZone(operator, request("rehearse", removed, "wildcard_family_added")),
    ).rejects.toThrow("the zone difference is wildcard_family_removed, not the one intended");
    expect(
      await adoptHnsRootZone(operator, request("commit", removed, "wildcard_family_removed")),
    ).toMatchObject({ committed: true, next_generation: generation + 3 });
    expect(await retainedDigest()).toBe(sha256(zone(9, false)));

    // A change made and undone before it was adopted leaves a later serial
    // and nothing else, which is adopted as that.
    served = 11;
    const undone = await artifact({ zone: zone(11, false), serial: 11 });
    expect(
      await adoptHnsRootZone(operator, request("commit", undone, "serial_only")),
    ).toMatchObject({ committed: true, delta: "serial_only", next_generation: generation + 4 });
    expect(await retainedDigest()).toBe(sha256(zone(11, false)));

    // A renewal job open for the current generation refuses a departing
    // change at the fence, and not a returning one.
    await admin.query("SELECT * FROM schedule_hns_root_health_renewals_v1(25,259200,7200)");
    await expect(
      withHnsRootZoneAdoptionFence(operator, fence(true), async () => "changed"),
    ).rejects.toThrow("a renewal job for the root's current generation is open");
    expect(
      await withHnsRootZoneAdoptionFence(operator, fence(false), async () => "withdrawn"),
    ).toBe("withdrawn");

    // It does not stop an adoption. The receipt counts it, and the job ends
    // as superseded when it is next claimed, without being handed out.
    served = 12;
    const again = await artifact({ zone: zone(12, true), serial: 12 });
    expect(await adoptHnsRootZone(operator, request("commit", again))).toMatchObject({
      committed: true,
      open_renewal_jobs: 1,
      next_generation: generation + 5,
    });
    expect(
      (
        await admin.query(
          "SELECT * FROM claim_hns_root_health_renewal_job_v1('adoption-executor',60)",
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await admin.query<{ state: string; failure_code: string }>(
          `SELECT state, failure_code FROM hns_root_health_renewal_jobs
            WHERE activation_generation = $1`,
          [generation + 4],
        )
      ).rows,
    ).toEqual([{ state: "terminal", failure_code: "generation_superseded" }]);
  } finally {
    await operator.end();
    await bystander.end();
  }
}

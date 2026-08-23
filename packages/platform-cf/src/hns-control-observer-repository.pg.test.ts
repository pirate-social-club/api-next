import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  decodeHnsControlObservationRequestBytes,
  decodeHnsControlObservationResultBytes,
  decodeHnsControlObserverConfigurationBytes,
  encodeHnsControlObservationRequest,
  encodeHnsControlObserverConfiguration,
  HNS_CONTROL_OBSERVER_SNAPSHOT_MAX_BYTES,
  type HnsControlObserverConfigurationV1,
  type HnsControlObserverReservationInput,
  type HnsControlObserverReservationOutcome,
  type HnsControlObserverSnapshotFinalizeInput,
} from "@pirate/application";
import type { Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";
import { Effect } from "effect";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import {
  makeControlPlaneHnsControlObserverConfigurationResolver,
  makeControlPlaneHnsControlObserverSnapshotStore,
} from "./namespace-ownership/hns-control-observer-postgres.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { applyPostgresMigrations } from "./postgres-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_HNS_OBSERVER_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-hns-observer-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-hns-observer-suite-complete\n";

if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}

const suite = connectionString === undefined ? describe.skip : describe;
const encoder = new TextEncoder();
const testCount = 8;
let completedTestCount = 0;
let admin: Client | undefined;
let schema = "";
let scoped = "";

const configurationValue = {
  version: "pirate-hns-control-observer-configuration-v1",
  provider_id: "hns.owner.v1",
  provider_configuration_reference: "hns-observer-pg-regtest",
  provider_configuration_version: "hns-observer-config-v1",
  environment: "test",
  ownership_sources: ["hns_parent_chain_txt"],
  chain: {
    driver_reference: "hsd-json-rpc:regtest-primary",
    network: "regtest",
    genesis_block_hash: "2".repeat(64),
    minimum_verification_progress_millionths: 999_000,
    maximum_tip_age_seconds: 3_600,
    maximum_future_tip_seconds: 7_200,
    expected_block_interval_seconds: 600,
    minimum_safe_remaining_blocks: 144,
    expiry_safety_blocks: 144,
    response_max_bytes: 1_048_576,
  },
  authoritative_dns: null,
  evidence_lease_seconds: 2_592_000,
  observer_deadline_ms: 1_000,
  observer_reservation_lease_seconds: 4,
  snapshot_store_reference: "postgres:hns-control-observer-v1",
} as const;

const dnsConfigurationValue = {
  ...configurationValue,
  provider_configuration_reference: "hns-observer-pg-dns-regtest",
  ownership_sources: ["owner_authoritative_dns_txt"],
  authoritative_dns: {
    driver_reference: "authoritative-dns:regtest",
    required_view_ids: ["getblockchaininfo"],
    require_dnssec: true,
    require_all_views: true,
    response_max_bytes: 65_535,
  },
} as const satisfies HnsControlObserverConfigurationV1;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function scopedConnection(raw: string, schemaName: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schemaName}`)}`;
}

function runtime() {
  return makeDirectPostgresControlPlaneLayer(scoped);
}

function runOptions(signal = new AbortController().signal) {
  return { deadline_ms: 1_000, signal } as const;
}

async function rawSha256(bytes: Uint8Array): Promise<Sha256HexValue> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  ) as Sha256HexValue;
}

async function seedConfiguration(
  configuration: HnsControlObserverConfigurationV1 = configurationValue,
) {
  if (admin === undefined) throw new Error("Postgres test schema is unavailable");
  const configurationBytes = await encodeHnsControlObserverConfiguration(configuration);
  const decoded = await decodeHnsControlObserverConfigurationBytes(configurationBytes);
  await admin.query({
    text: `INSERT INTO hns_control_observer_configurations (
             provider_configuration_reference,
             provider_configuration_version,
             provider_configuration_digest,
             configuration_bytes
           ) VALUES ($1, $2, $3, $4)`,
    values: [
      configuration.provider_configuration_reference,
      configuration.provider_configuration_version,
      decoded.configuration_digest,
      configurationBytes,
    ],
  });
  return { configurationBytes, configurationDigest: decoded.configuration_digest };
}

async function reservationInput(
  observationId: string,
  expectedTxtValue = "pirate-verification=pg-observer-01",
  configuration: HnsControlObserverConfigurationV1 = configurationValue,
  ownershipSource: "hns_parent_chain_txt" | "owner_authoritative_dns_txt" = "hns_parent_chain_txt",
): Promise<HnsControlObserverReservationInput> {
  const { configurationBytes, configurationDigest } = await seedConfiguration(configuration);
  const requestBytes = await encodeHnsControlObservationRequest({
    version: "pirate-hns-control-observation-request-v1",
    observation_id: observationId,
    provider_id: "hns.owner.v1",
    provider_configuration_reference: configuration.provider_configuration_reference,
    provider_configuration_version: configuration.provider_configuration_version,
    provider_configuration_digest: configurationDigest,
    environment: "test",
    ownership_source: ownershipSource,
    root_label: "pgobserver",
    txt_name: ownershipSource === "hns_parent_chain_txt" ? "pgobserver" : "_pirate.pgobserver",
    expected_txt_value: expectedTxtValue,
  });
  const request = await decodeHnsControlObservationRequestBytes(requestBytes);
  return {
    observation_id: observationId,
    request_bytes: requestBytes,
    request_sha256: request.request_sha256,
    configuration_bytes: configurationBytes,
    provider_configuration_digest: configurationDigest,
    reservation_lease_seconds: configuration.observer_reservation_lease_seconds,
  };
}

function acquired(
  value: HnsControlObserverReservationOutcome,
): Extract<HnsControlObserverReservationOutcome, { readonly kind: "acquired" }> {
  if (value.kind !== "acquired") throw new Error("expected acquired reservation");
  return value;
}

async function finalizeInput(
  reservation: HnsControlObserverReservationInput,
  authority: Extract<HnsControlObserverReservationOutcome, { readonly kind: "acquired" }>,
): Promise<HnsControlObserverSnapshotFinalizeInput> {
  const resultBytes = encoder.encode(
    JSON.stringify({
      version: "pirate-hns-control-observation-result-v1",
      observation_id: reservation.observation_id,
      request_sha256: reservation.request_sha256,
      status: "unavailable",
      reason_code: "chain_transport_unavailable",
      retry_after_seconds: 5,
      diagnostic_ref: authority.snapshot_reference,
    }),
  );
  const decoded = await decodeHnsControlObservationResultBytes(resultBytes);
  const transcriptRequest = encoder.encode('{"method":"getblockchaininfo","params":[]}');
  return {
    observation_id: reservation.observation_id,
    observer_fence: authority.observer_fence,
    request_sha256: reservation.request_sha256,
    provider_configuration_digest: reservation.provider_configuration_digest,
    snapshot_reference: authority.snapshot_reference,
    transcript: [
      {
        driver_reference: configurationValue.chain.driver_reference,
        ownership_source: "hns_parent_chain_txt",
        method_or_view_id: "getblockchaininfo",
        request_bytes: transcriptRequest,
        request_sha256: await rawSha256(transcriptRequest),
        transport_outcome: "transport_error",
        transport_status: null,
        response_bytes: null,
        response_sha256: null,
      },
    ],
    semantic_facts_bytes: encoder.encode('{"status":"unavailable"}'),
    result_bytes: resultBytes,
    result_sha256: decoded.result_sha256,
  };
}

async function expireReservation(observationId: string): Promise<void> {
  if (admin === undefined) throw new Error("Postgres test schema is unavailable");
  await admin.query(
    "ALTER TABLE hns_control_observer_reservations DISABLE TRIGGER hns_control_observer_reservation_guard",
  );
  try {
    await admin.query({
      text: `WITH expired AS (
               SELECT date_trunc('milliseconds', clock_timestamp() - INTERVAL '10 seconds')
                 AS database_time
             )
             UPDATE hns_control_observer_reservations AS reservation
                SET reservation_database_time = expired.database_time,
                    lease_expires_at = expired.database_time
                      + reservation.reservation_lease_seconds * INTERVAL '1 second',
                    created_at = expired.database_time,
                    updated_at = expired.database_time
               FROM expired
              WHERE observation_id = $1`,
      values: [observationId],
    });
  } finally {
    await admin.query(
      "ALTER TABLE hns_control_observer_reservations ENABLE TRIGGER hns_control_observer_reservation_guard",
    );
  }
}

async function rowCount(table: string): Promise<number> {
  if (admin === undefined) throw new Error("Postgres test schema is unavailable");
  const result = await admin.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table}`,
  );
  return Number(result.rows[0]?.count);
}

suite("Postgres 17 HNS control observer persistence", () => {
  beforeAll(async () => {
    if (connectionString === undefined) return;
    schema = `api_next_hns_observer_${crypto.randomUUID().replaceAll("-", "")}`;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    scoped = scopedConnection(connectionString, schema);
    await Effect.runPromise(
      Effect.scoped(
        applyPostgresMigrations(await loadPostgresMigrations()).pipe(Effect.provide(runtime())),
      ),
    );
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  }, 30_000);

  beforeEach(async () => {
    if (admin === undefined) return;
    await admin.query(`TRUNCATE
      hns_control_observer_snapshot_transcript_entries,
      hns_control_observer_snapshots,
      hns_control_observer_reservations,
      hns_control_observer_operations,
      hns_control_observer_configurations
      CASCADE`);
  });

  test("resolves exact immutable configuration bytes", async () => {
    if (admin === undefined) throw new Error("Postgres test schema is unavailable");
    const { configurationBytes } = await seedConfiguration();
    const resolver = makeControlPlaneHnsControlObserverConfigurationResolver(runtime());
    const first = await resolver.resolve(
      {
        reference: configurationValue.provider_configuration_reference,
        version: configurationValue.provider_configuration_version,
      },
      runOptions(),
    );
    expect(first).toEqual(configurationBytes);
    first?.fill(0);
    await expect(
      resolver.resolve(
        {
          reference: configurationValue.provider_configuration_reference,
          version: configurationValue.provider_configuration_version,
        },
        runOptions(),
      ),
    ).resolves.toEqual(configurationBytes);
    await expect(
      admin.query(
        "UPDATE hns_control_observer_configurations SET configuration_bytes = configuration_bytes",
      ),
    ).rejects.toThrow("append-only");
    await expect(admin.query("DELETE FROM hns_control_observer_configurations")).rejects.toThrow(
      "append-only",
    );
    completedTestCount += 1;
  });

  test("serializes first reservation, exact busy replay, and changed-byte mismatch", async () => {
    const input = await reservationInput("observer-pg-reserve-01");
    const left = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const right = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const [first, second] = await Promise.all([
      left.reserve(input, runOptions()),
      right.reserve(input, runOptions()),
    ]);
    expect([first.kind, second.kind].sort()).toEqual(["acquired", "busy"]);
    const authority = acquired(first.kind === "acquired" ? first : second);
    expect(authority.snapshot_reference).toMatch(/^hns-observer:postgres:/u);
    const changedRequest = await encodeHnsControlObservationRequest({
      ...(await decodeHnsControlObservationRequestBytes(input.request_bytes)).request,
      expected_txt_value: "pirate-verification=changed",
    });
    const changedDecoded = await decodeHnsControlObservationRequestBytes(changedRequest);
    const changed = {
      ...input,
      request_bytes: changedRequest,
      request_sha256: changedDecoded.request_sha256,
    };
    await expect(left.reserve(changed, runOptions())).resolves.toEqual({ kind: "mismatch" });
    const wrongDigestRequest = await encodeHnsControlObservationRequest({
      ...(await decodeHnsControlObservationRequestBytes(input.request_bytes)).request,
      provider_configuration_digest: "3".repeat(64) as Sha256HexValue,
    });
    const wrongDigestDecoded = await decodeHnsControlObservationRequestBytes(wrongDigestRequest);
    await expect(
      left.reserve(
        {
          ...input,
          request_bytes: wrongDigestRequest,
          request_sha256: wrongDigestDecoded.request_sha256,
        },
        runOptions(),
      ),
    ).rejects.toThrow("authority does not match");
    await expect(
      left.reserve(
        { ...input, observation_id: "observer-pg-reserve-outer-substitution" },
        runOptions(),
      ),
    ).rejects.toThrow("authority does not match");
    expect(await rowCount("hns_control_observer_operations")).toBe(1);
    expect(await rowCount("hns_control_observer_reservations")).toBe(1);
    completedTestCount += 1;
  });

  test("serializes expired reacquisition to one new fence and rejects the stale finalizer", async () => {
    const input = await reservationInput("observer-pg-reacquire-01");
    const left = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const right = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const first = acquired(await left.reserve(input, runOptions()));
    const staleFinalize = await finalizeInput(input, first);
    await expireReservation(input.observation_id);
    const reacquisitions = await Promise.all([
      left.reserve(input, runOptions()),
      right.reserve(input, runOptions()),
    ]);
    expect(reacquisitions.map((outcome) => outcome.kind).sort()).toEqual(["acquired", "busy"]);
    const second = acquired(
      reacquisitions[0].kind === "acquired" ? reacquisitions[0] : reacquisitions[1],
    );
    expect(second).toMatchObject({
      observer_fence: first.observer_fence + 1,
      snapshot_reference: first.snapshot_reference,
    });
    await expect(left.finalize(staleFinalize, runOptions())).resolves.toEqual({ kind: "lost" });
    expect(await rowCount("hns_control_observer_snapshots")).toBe(0);
    await expect(
      left.finalize(await finalizeInput(input, second), runOptions()),
    ).resolves.toMatchObject({ kind: "retained" });
    completedTestCount += 1;
  });

  test("finalize after database-time lease expiry writes no snapshot", async () => {
    if (admin === undefined) throw new Error("Postgres test schema is unavailable");
    const input = await reservationInput("observer-pg-expired-finalize-01");
    const store = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const authority = acquired(await store.reserve(input, runOptions()));
    const terminal = await finalizeInput(input, authority);
    await expireReservation(input.observation_id);
    await expect(store.finalize(terminal, runOptions())).resolves.toEqual({ kind: "lost" });
    expect(await rowCount("hns_control_observer_snapshots")).toBe(0);
    expect(await rowCount("hns_control_observer_snapshot_transcript_entries")).toBe(0);
    await expect(
      admin.query({
        text: `UPDATE hns_control_observer_reservations AS reservation
                  SET state = 'terminal',
                      terminal_snapshot_reference = operation.snapshot_reference,
                      terminal_status = 'unavailable',
                      terminal_at = reservation.reservation_database_time + INTERVAL '1 second',
                      updated_at = reservation.reservation_database_time + INTERVAL '1 second'
                 FROM hns_control_observer_operations AS operation
                WHERE operation.observation_id = reservation.observation_id
                  AND reservation.observation_id = $1`,
        values: [input.observation_id],
      }),
    ).rejects.toThrow("lost its lease or fence");
    completedTestCount += 1;
  });

  test("commits one append-only snapshot and exact concurrent replay", async () => {
    if (admin === undefined) throw new Error("Postgres test schema is unavailable");
    const input = await reservationInput("observer-pg-finalize-01");
    const left = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const right = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const authority = acquired(await left.reserve(input, runOptions()));
    const terminal = await finalizeInput(input, authority);
    const outcomes = await Promise.all([
      left.finalize(terminal, runOptions()),
      right.finalize(terminal, runOptions()),
    ]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["replay", "retained"]);
    expect(await rowCount("hns_control_observer_snapshots")).toBe(1);
    expect(await rowCount("hns_control_observer_snapshot_transcript_entries")).toBe(1);
    await expect(
      admin.query("UPDATE hns_control_observer_snapshots SET result_bytes = result_bytes"),
    ).rejects.toThrow("append-only");
    await expect(
      admin.query("DELETE FROM hns_control_observer_snapshot_transcript_entries"),
    ).rejects.toThrow("append-only");
    await expect(
      admin.query(`INSERT INTO hns_control_observer_snapshot_transcript_entries (
                     snapshot_reference,
                     entry_ordinal,
                     driver_reference,
                     ownership_source,
                     method_or_view_id,
                     request_bytes,
                     request_sha256,
                     transport_outcome,
                     transport_status,
                     response_bytes,
                     response_sha256
                   )
                   SELECT snapshot_reference,
                          1,
                          driver_reference,
                          ownership_source,
                          method_or_view_id,
                          request_bytes,
                          request_sha256,
                          transport_outcome,
                          transport_status,
                          response_bytes,
                          response_sha256
                     FROM hns_control_observer_snapshot_transcript_entries
                    WHERE entry_ordinal = 0`),
    ).rejects.toThrow("not open for insertion");
    completedTestCount += 1;
  });

  test("rejects a logical snapshot above the complete accounting cap", async () => {
    const input = await reservationInput("observer-pg-capacity-01");
    const store = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const authority = acquired(await store.reserve(input, runOptions()));
    const terminal = await finalizeInput(input, authority);
    await expect(
      store.finalize(
        {
          ...terminal,
          semantic_facts_bytes: new Uint8Array(HNS_CONTROL_OBSERVER_SNAPSHOT_MAX_BYTES),
        },
        runOptions(),
      ),
    ).rejects.toThrow("snapshot bound");
    expect(await rowCount("hns_control_observer_snapshots")).toBe(0);
    completedTestCount += 1;
  });

  test("uses configured driver authority when a DNS view id matches an HSD method", async () => {
    const input = await reservationInput(
      "observer-pg-dns-method-collision-01",
      "pirate-verification=pg-observer-dns-01",
      dnsConfigurationValue,
      "owner_authoritative_dns_txt",
    );
    const store = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const authority = acquired(await store.reserve(input, runOptions()));
    const terminal = await finalizeInput(input, authority);
    const dnsRequest = encoder.encode("dns-wire-request");
    const dnsResponse = encoder.encode("dns-wire-response");
    await expect(
      store.finalize(
        {
          ...terminal,
          transcript: [
            {
              driver_reference: dnsConfigurationValue.authoritative_dns.driver_reference,
              ownership_source: "owner_authoritative_dns_txt",
              method_or_view_id: "getblockchaininfo",
              request_bytes: dnsRequest,
              request_sha256: await rawSha256(dnsRequest),
              transport_outcome: "response",
              transport_status: null,
              response_bytes: dnsResponse,
              response_sha256: await rawSha256(dnsResponse),
            },
          ],
        },
        runOptions(),
      ),
    ).resolves.toMatchObject({ kind: "retained" });
    expect(await rowCount("hns_control_observer_snapshot_transcript_entries")).toBe(1);
    completedTestCount += 1;
  });

  test("aborting lock-blocked reserve and finalize transactions leaves no late write", async () => {
    if (admin === undefined) throw new Error("Postgres test schema is unavailable");
    const input = await reservationInput("observer-pg-abort-01");
    const store = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const authority = acquired(await store.reserve(input, runOptions()));
    const terminal = await finalizeInput(input, authority);
    await admin.query("BEGIN");
    await admin.query({
      text: "SELECT observation_id FROM hns_control_observer_operations WHERE observation_id = $1 FOR UPDATE",
      values: [input.observation_id],
    });
    const reserveController = new AbortController();
    const blockedReserve = store.reserve(input, runOptions(reserveController.signal));
    await new Promise((resolve) => setTimeout(resolve, 100));
    reserveController.abort();
    await expect(blockedReserve).rejects.toThrow();
    await admin.query("COMMIT");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterReserve = await admin.query<{ state: string; observer_fence: string }>({
      text: `SELECT state, observer_fence::text
               FROM hns_control_observer_reservations
              WHERE observation_id = $1`,
      values: [input.observation_id],
    });
    expect(afterReserve.rows).toEqual([{ state: "reserved", observer_fence: "1" }]);

    await admin.query("BEGIN");
    await admin.query({
      text: "SELECT observation_id FROM hns_control_observer_operations WHERE observation_id = $1 FOR UPDATE",
      values: [input.observation_id],
    });
    const finalizeController = new AbortController();
    const blockedFinalize = store.finalize(terminal, runOptions(finalizeController.signal));
    await new Promise((resolve) => setTimeout(resolve, 100));
    finalizeController.abort();
    await expect(blockedFinalize).rejects.toThrow();
    await admin.query("COMMIT");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await rowCount("hns_control_observer_snapshots")).toBe(0);
    const afterFinalize = await admin.query<{ state: string; observer_fence: string }>({
      text: `SELECT state, observer_fence::text
               FROM hns_control_observer_reservations
              WHERE observation_id = $1`,
      values: [input.observation_id],
    });
    expect(afterFinalize.rows).toEqual([{ state: "reserved", observer_fence: "1" }]);
    completedTestCount += 1;
  }, 15_000);

  afterAll(async () => {
    if (admin !== undefined) {
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
    if (connectionString !== undefined && completedTestCount === testCount) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});

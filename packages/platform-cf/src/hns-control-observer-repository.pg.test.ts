import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  buildHnsAuthoritativeDnsQueryV1,
  decodeHnsControlObservationRequestBytes,
  decodeHnsControlObservationResultBytes,
  decodeHnsControlObserverConfigurationBytes,
  encodeHnsAuthoritativeDnsSemanticFactsV1,
  encodeHnsControlObservationRequest,
  encodeHnsControlObserverConfiguration,
  HNS_CONTROL_OBSERVER_SNAPSHOT_MAX_BYTES,
  type HnsControlObserverConfigurationV1,
  type HnsControlObserverReservationInput,
  type HnsControlObserverReservationOutcome,
  type HnsControlObserverSnapshotFinalizeInput,
  hnsObservedTxtValuesDigest,
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
const testCount = 11;
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

function uint16(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function dnsRecord(type: number, rdata: Uint8Array): Uint8Array {
  return concatBytes([
    new Uint8Array([0xc0, 0x0c]),
    uint16(type),
    uint16(1),
    new Uint8Array([0, 0, 1, 44]),
    uint16(rdata.byteLength),
    rdata,
  ]);
}

function signedDnsResponse(
  request: Uint8Array,
  recordType: 16 | 48,
  recordData: Uint8Array,
): Uint8Array {
  const signatureData = new Uint8Array(18);
  signatureData.set(uint16(recordType));
  const answers = [dnsRecord(recordType, recordData), dnsRecord(46, signatureData)];
  const header = new Uint8Array(12);
  header[0] = request[0] ?? 0;
  header[1] = request[1] ?? 0;
  header.set(uint16(0x8400), 2);
  header.set(uint16(1), 4);
  header.set(uint16(answers.length), 6);
  header.set(uint16(1), 10);
  return concatBytes([
    header,
    request.subarray(12, request.byteLength - 11),
    ...answers,
    request.subarray(request.byteLength - 11),
  ]);
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
    const dnskeyRequest = buildHnsAuthoritativeDnsQueryV1({
      message_id: 1,
      query_kind: "dnskey",
      root_label: "pgobserver",
    });
    const resultBytes = encoder.encode(
      JSON.stringify({
        version: "pirate-hns-control-observation-result-v1",
        observation_id: input.observation_id,
        request_sha256: input.request_sha256,
        status: "unavailable",
        reason_code: "authoritative_dns_timeout",
        retry_after_seconds: null,
        diagnostic_ref: authority.snapshot_reference,
      }),
    );
    const decodedResult = await decodeHnsControlObservationResultBytes(resultBytes);
    await expect(
      store.finalize(
        {
          observation_id: input.observation_id,
          observer_fence: authority.observer_fence,
          request_sha256: input.request_sha256,
          provider_configuration_digest: input.provider_configuration_digest,
          snapshot_reference: authority.snapshot_reference,
          semantic_facts_bytes: encodeHnsAuthoritativeDnsSemanticFactsV1([]),
          transcript: [
            {
              driver_reference: dnsConfigurationValue.authoritative_dns.driver_reference,
              ownership_source: "owner_authoritative_dns_txt",
              method_or_view_id: "getblockchaininfo",
              request_bytes: dnskeyRequest,
              request_sha256: await rawSha256(dnskeyRequest),
              transport_outcome: "timeout",
              transport_status: null,
              response_bytes: null,
              response_sha256: null,
            },
          ],
          result_bytes: resultBytes,
          result_sha256: decodedResult.result_sha256,
        },
        runOptions(),
      ),
    ).resolves.toMatchObject({ kind: "retained" });
    expect(await rowCount("hns_control_observer_snapshot_transcript_entries")).toBe(1);
    completedTestCount += 1;
  });

  test("retains a no-DS insecure result before any DNS exchange", async () => {
    const input = await reservationInput(
      "observer-pg-dns-no-ds-01",
      "pirate-verification=pg-observer-no-ds-01",
      dnsConfigurationValue,
      "owner_authoritative_dns_txt",
    );
    const store = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const authority = acquired(await store.reserve(input, runOptions()));
    const resultBytes = encoder.encode(
      JSON.stringify({
        version: "pirate-hns-control-observation-result-v1",
        observation_id: input.observation_id,
        request_sha256: input.request_sha256,
        status: "unavailable",
        reason_code: "authoritative_dns_insecure",
        retry_after_seconds: null,
        diagnostic_ref: authority.snapshot_reference,
      }),
    );
    const decodedResult = await decodeHnsControlObservationResultBytes(resultBytes);
    await expect(
      store.finalize(
        {
          observation_id: input.observation_id,
          observer_fence: authority.observer_fence,
          request_sha256: input.request_sha256,
          provider_configuration_digest: input.provider_configuration_digest,
          snapshot_reference: authority.snapshot_reference,
          transcript: [],
          semantic_facts_bytes: encodeHnsAuthoritativeDnsSemanticFactsV1([]),
          result_bytes: resultBytes,
          result_sha256: decodedResult.result_sha256,
        },
        runOptions(),
      ),
    ).resolves.toMatchObject({ kind: "retained" });
    expect(await rowCount("hns_control_observer_snapshot_transcript_entries")).toBe(0);
    completedTestCount += 1;
  });

  test("does not invent semantic facts from a classifiable DNS capacity prefix", async () => {
    const dnskeyRequest = buildHnsAuthoritativeDnsQueryV1({
      message_id: 11,
      query_kind: "dnskey",
      root_label: "pgobserver",
    });
    const controlRequest = buildHnsAuthoritativeDnsQueryV1({
      message_id: 12,
      query_kind: "control_txt",
      root_label: "pgobserver",
    });
    const dnskeyResponse = signedDnsResponse(dnskeyRequest, 48, new Uint8Array([1]));
    const controlTxtBytes = encoder.encode("pirate-verification=capacity-prefix");
    const controlResponse = signedDnsResponse(
      controlRequest,
      16,
      concatBytes([new Uint8Array([controlTxtBytes.byteLength]), controlTxtBytes]),
    );
    const capacityConfiguration = {
      ...dnsConfigurationValue,
      provider_configuration_reference: "hns-observer-pg-dns-capacity",
      authoritative_dns: {
        ...dnsConfigurationValue.authoritative_dns,
        response_max_bytes: controlResponse.byteLength,
      },
    } as const satisfies HnsControlObserverConfigurationV1;
    const input = await reservationInput(
      "observer-pg-dns-capacity-01",
      "pirate-verification=pg-observer-capacity-01",
      capacityConfiguration,
      "owner_authoritative_dns_txt",
    );
    const store = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const authority = acquired(await store.reserve(input, runOptions()));
    const resultBytes = encoder.encode(
      JSON.stringify({
        version: "pirate-hns-control-observation-result-v1",
        observation_id: input.observation_id,
        request_sha256: input.request_sha256,
        status: "unavailable",
        reason_code: "observer_capacity",
        retry_after_seconds: null,
        diagnostic_ref: authority.snapshot_reference,
      }),
    );
    const decodedResult = await decodeHnsControlObservationResultBytes(resultBytes);
    await expect(
      store.finalize(
        {
          observation_id: input.observation_id,
          observer_fence: authority.observer_fence,
          request_sha256: input.request_sha256,
          provider_configuration_digest: input.provider_configuration_digest,
          snapshot_reference: authority.snapshot_reference,
          transcript: [
            {
              driver_reference: capacityConfiguration.authoritative_dns.driver_reference,
              ownership_source: "owner_authoritative_dns_txt",
              method_or_view_id: "getblockchaininfo",
              request_bytes: dnskeyRequest,
              request_sha256: await rawSha256(dnskeyRequest),
              transport_outcome: "response",
              transport_status: null,
              response_bytes: dnskeyResponse,
              response_sha256: await rawSha256(dnskeyResponse),
            },
            {
              driver_reference: capacityConfiguration.authoritative_dns.driver_reference,
              ownership_source: "owner_authoritative_dns_txt",
              method_or_view_id: "getblockchaininfo",
              request_bytes: controlRequest,
              request_sha256: await rawSha256(controlRequest),
              transport_outcome: "response",
              transport_status: null,
              response_bytes: controlResponse,
              response_sha256: await rawSha256(controlResponse),
            },
          ],
          semantic_facts_bytes: encodeHnsAuthoritativeDnsSemanticFactsV1([]),
          result_bytes: resultBytes,
          result_sha256: decodedResult.result_sha256,
        },
        runOptions(),
      ),
    ).resolves.toMatchObject({ kind: "retained" });
    expect(await rowCount("hns_control_observer_snapshots")).toBe(1);
    completedTestCount += 1;
  });

  test("rejects owner-DNS semantic facts that contradict the terminal result", async () => {
    const expectedTxtValue = "pirate-verification=pg-observer-dns-digest-01";
    const input = await reservationInput(
      "observer-pg-dns-digest-drift-01",
      expectedTxtValue,
      dnsConfigurationValue,
      "owner_authoritative_dns_txt",
    );
    const store = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const authority = acquired(await store.reserve(input, runOptions()));
    const decodedRequest = await decodeHnsControlObservationRequestBytes(input.request_bytes);
    const dnskeyRequest = buildHnsAuthoritativeDnsQueryV1({
      message_id: 3,
      query_kind: "dnskey",
      root_label: decodedRequest.request.root_label,
    });
    const controlRequest = buildHnsAuthoritativeDnsQueryV1({
      message_id: 4,
      query_kind: "control_txt",
      root_label: decodedRequest.request.root_label,
    });
    const dnskeyResponse = signedDnsResponse(dnskeyRequest, 48, new Uint8Array([1]));
    const controlTxtBytes = encoder.encode("pirate-verification=other");
    const controlResponse = signedDnsResponse(
      controlRequest,
      16,
      concatBytes([new Uint8Array([controlTxtBytes.byteLength]), controlTxtBytes]),
    );
    const resultChainDigest = "5".repeat(64) as Sha256HexValue;
    const forgedFactsChainDigest = "6".repeat(64) as Sha256HexValue;
    const observedTxtValuesDigest = await hnsObservedTxtValuesDigest([
      { chunks: ["pirate-verification=other"] },
    ]);
    if (observedTxtValuesDigest === null) {
      throw new Error("expected an observed TXT digest");
    }
    const resultBytes = encoder.encode(
      JSON.stringify({
        version: "pirate-hns-control-observation-result-v1",
        observation_id: input.observation_id,
        request_sha256: input.request_sha256,
        status: "rejected",
        reason_code: "txt_value_mismatch",
        provider_id: decodedRequest.request.provider_id,
        provider_configuration_reference: decodedRequest.request.provider_configuration_reference,
        provider_configuration_version: decodedRequest.request.provider_configuration_version,
        provider_configuration_digest: decodedRequest.request.provider_configuration_digest,
        environment: decodedRequest.request.environment,
        ownership_source: decodedRequest.request.ownership_source,
        root_label: decodedRequest.request.root_label,
        txt_name: decodedRequest.request.txt_name,
        expected_txt_value_sha256: await rawSha256(encoder.encode(expectedTxtValue)),
        observed_txt_values_digest: observedTxtValuesDigest,
        chain_authority_digest: resultChainDigest,
        chain_network: dnsConfigurationValue.chain.network,
        chain_genesis_block_hash: dnsConfigurationValue.chain.genesis_block_hash,
        chain_anchor_height: 10,
        chain_anchor_block_hash: "8".repeat(64),
        chain_anchor_median_time: 1_700_000_000,
        expiry_height: 1_000,
        provider_evidence_ref: authority.snapshot_reference,
      }),
    );
    const decodedResult = await decodeHnsControlObservationResultBytes(
      resultBytes,
      decodedRequest.request,
    );
    const transcript = [
      {
        driver_reference: dnsConfigurationValue.authoritative_dns.driver_reference,
        ownership_source: "owner_authoritative_dns_txt" as const,
        method_or_view_id: "getblockchaininfo",
        request_bytes: dnskeyRequest,
        request_sha256: await rawSha256(dnskeyRequest),
        transport_outcome: "response" as const,
        transport_status: null,
        response_bytes: dnskeyResponse,
        response_sha256: await rawSha256(dnskeyResponse),
      },
      {
        driver_reference: dnsConfigurationValue.authoritative_dns.driver_reference,
        ownership_source: "owner_authoritative_dns_txt" as const,
        method_or_view_id: "getblockchaininfo",
        request_bytes: controlRequest,
        request_sha256: await rawSha256(controlRequest),
        transport_outcome: "response" as const,
        transport_status: null,
        response_bytes: controlResponse,
        response_sha256: await rawSha256(controlResponse),
      },
    ];
    const dnskeyTranscript = transcript[0];
    const controlTranscript = transcript[1];
    if (dnskeyTranscript === undefined || controlTranscript === undefined) {
      throw new Error("expected complete DNS transcript pair");
    }
    const semanticFacts = encodeHnsAuthoritativeDnsSemanticFactsV1([
      {
        view_id: "getblockchaininfo",
        authority_nameserver: "ns1.pgobserver",
        authority_address_family: "GLUE4",
        authority_address: "192.0.2.53",
        dnskey_request_sha256: dnskeyTranscript.request_sha256,
        dnskey_response_sha256: dnskeyTranscript.response_sha256,
        control_request_sha256: controlTranscript.request_sha256,
        control_response_sha256: controlTranscript.response_sha256,
        chain_authority_digest: forgedFactsChainDigest,
        validation_database_time: authority.reservation_database_time,
        dnssec_validation: "secure",
        semantic_class: "txt_values",
        observed_txt_values_digest: observedTxtValuesDigest,
      },
    ]);
    await expect(
      store.finalize(
        {
          observation_id: input.observation_id,
          observer_fence: authority.observer_fence,
          request_sha256: input.request_sha256,
          provider_configuration_digest: input.provider_configuration_digest,
          snapshot_reference: authority.snapshot_reference,
          transcript,
          semantic_facts_bytes: semanticFacts,
          result_bytes: resultBytes,
          result_sha256: decodedResult.result_sha256,
        },
        runOptions(),
      ),
    ).rejects.toThrow("semantic facts");
    const contradictoryNegativeFacts = encodeHnsAuthoritativeDnsSemanticFactsV1([
      {
        view_id: "getblockchaininfo",
        authority_nameserver: "ns1.pgobserver",
        authority_address_family: "GLUE4",
        authority_address: "192.0.2.53",
        dnskey_request_sha256: dnskeyTranscript.request_sha256,
        dnskey_response_sha256: dnskeyTranscript.response_sha256,
        control_request_sha256: controlTranscript.request_sha256,
        control_response_sha256: controlTranscript.response_sha256,
        chain_authority_digest: resultChainDigest,
        validation_database_time: authority.reservation_database_time,
        dnssec_validation: "secure",
        semantic_class: "nxdomain",
        observed_txt_values_digest: null,
      },
    ]);
    await expect(
      store.finalize(
        {
          observation_id: input.observation_id,
          observer_fence: authority.observer_fence,
          request_sha256: input.request_sha256,
          provider_configuration_digest: input.provider_configuration_digest,
          snapshot_reference: authority.snapshot_reference,
          transcript,
          semantic_facts_bytes: contradictoryNegativeFacts,
          result_bytes: resultBytes,
          result_sha256: decodedResult.result_sha256,
        },
        runOptions(),
      ),
    ).rejects.toThrow("semantic facts");
    const contradictoryTxtDigestFacts = encodeHnsAuthoritativeDnsSemanticFactsV1([
      {
        view_id: "getblockchaininfo",
        authority_nameserver: "ns1.pgobserver",
        authority_address_family: "GLUE4",
        authority_address: "192.0.2.53",
        dnskey_request_sha256: dnskeyTranscript.request_sha256,
        dnskey_response_sha256: dnskeyTranscript.response_sha256,
        control_request_sha256: controlTranscript.request_sha256,
        control_response_sha256: controlTranscript.response_sha256,
        chain_authority_digest: resultChainDigest,
        validation_database_time: authority.reservation_database_time,
        dnssec_validation: "secure",
        semantic_class: "txt_values",
        observed_txt_values_digest: "9".repeat(64) as Sha256HexValue,
      },
    ]);
    await expect(
      store.finalize(
        {
          observation_id: input.observation_id,
          observer_fence: authority.observer_fence,
          request_sha256: input.request_sha256,
          provider_configuration_digest: input.provider_configuration_digest,
          snapshot_reference: authority.snapshot_reference,
          transcript,
          semantic_facts_bytes: contradictoryTxtDigestFacts,
          result_bytes: resultBytes,
          result_sha256: decodedResult.result_sha256,
        },
        runOptions(),
      ),
    ).rejects.toThrow("semantic facts");
    const inconclusiveResultBytes = encoder.encode(
      JSON.stringify({
        version: "pirate-hns-control-observation-result-v1",
        observation_id: input.observation_id,
        request_sha256: input.request_sha256,
        status: "unavailable",
        reason_code: "authoritative_dns_inconclusive",
        retry_after_seconds: null,
        diagnostic_ref: authority.snapshot_reference,
      }),
    );
    const decodedInconclusiveResult =
      await decodeHnsControlObservationResultBytes(inconclusiveResultBytes);
    for (const incompleteOrAgreeingFacts of [
      encodeHnsAuthoritativeDnsSemanticFactsV1([]),
      encodeHnsAuthoritativeDnsSemanticFactsV1([
        {
          view_id: "getblockchaininfo",
          authority_nameserver: "ns1.pgobserver",
          authority_address_family: "GLUE4",
          authority_address: "192.0.2.53",
          dnskey_request_sha256: dnskeyTranscript.request_sha256,
          dnskey_response_sha256: dnskeyTranscript.response_sha256,
          control_request_sha256: controlTranscript.request_sha256,
          control_response_sha256: controlTranscript.response_sha256,
          chain_authority_digest: resultChainDigest,
          validation_database_time: authority.reservation_database_time,
          dnssec_validation: "secure",
          semantic_class: "txt_values",
          observed_txt_values_digest: observedTxtValuesDigest,
        },
      ]),
    ]) {
      await expect(
        store.finalize(
          {
            observation_id: input.observation_id,
            observer_fence: authority.observer_fence,
            request_sha256: input.request_sha256,
            provider_configuration_digest: input.provider_configuration_digest,
            snapshot_reference: authority.snapshot_reference,
            transcript,
            semantic_facts_bytes: incompleteOrAgreeingFacts,
            result_bytes: inconclusiveResultBytes,
            result_sha256: decodedInconclusiveResult.result_sha256,
          },
          runOptions(),
        ),
      ).rejects.toThrow("semantic facts");
    }
    expect(await rowCount("hns_control_observer_snapshots")).toBe(0);
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

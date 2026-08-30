import { expect, test } from "bun:test";
import {
  decodeHnsAuthorityDetachedObserverEvidenceV1,
  encodeHnsAuthorityDetachedObserverEvidenceV1,
  HNS_AUTHORITY_SUCCESSOR_CANDIDATE_VERSION,
  type prepareHnsAuthoritySuccessorCandidateV1,
} from "@pirate/application/hns-host-persistence";
import {
  encodeHnsAuthorityInventory,
  hnsAuthorityCapabilitySetDigest,
  hnsChainAuthorityDigest,
} from "@pirate/application/namespace-ownership";
import { runHnsAuthoritySuccessorEmitterV1 } from "./authority-successor-emitter.ts";
import {
  decodeHnsAuthoritySuccessorObservationDocumentV1,
  HNS_AUTHORITY_SUCCESSOR_OBSERVATION_MAX_BYTES,
  type HnsAuthoritySuccessorDetachedTranscriptEntryV1,
  type HnsAuthoritySuccessorObservationHarnessIoV1,
  type HnsAuthoritySuccessorObservationSourceV1,
  type HnsAuthoritySuccessorSourceObservationV1,
  makeHnsAuthoritySuccessorObservationSourceV1,
  runHnsAuthoritySuccessorObservationHarnessV1,
} from "./authority-successor-observation-harness.ts";

const encoder = new TextEncoder();
const candidateBytes = encoder.encode('{"candidate":"review-exact"}');
const evidenceReference = "hns-detached-observation:main:jazleeuw-verified-01";
const jazleeuwUpdate3ResourceHex =
  "0001036e7331067069726174650001036e7332c0060601387069726174652d766572696669636174696f6e3d6e76735f3963633937306561653631393432313461643938613736626661356166336163002a7b0d0220ba5d84ad6e3e7ec452a569ee2e6c447ba2b9b533de65c58e59f2f0b7f0773045002a7b0d0430fde2c7af467092476b5572f9ac43fbbbbe82f63f7c785af984dc5884a2dae0384519dea6982fdbd19c375756b4ebaf70";
const detachedTranscript = [
  {
    exchange_kind: "hns_rpc",
    vantage_reference: "observer-vantage:primary-hsd",
    subject_reference: "jazleeuw",
    query_reference: "getnameresource:jazleeuw",
    request_bytes: encoder.encode('{"method":"getnameresource","params":["jazleeuw"]}'),
    response_bytes: encoder.encode(
      JSON.stringify({ height: 344_448, resource: jazleeuwUpdate3ResourceHex }),
    ),
  },
  {
    exchange_kind: "child_authority_dns",
    vantage_reference: "deployment-vantage:primary-external",
    subject_reference: "94.103.168.161",
    query_reference: "axfr:jazleeuw",
    request_bytes: encoder.encode("dns-query:jazleeuw:axfr:primary"),
    response_bytes: encoder.encode("dns-response:jazleeuw:axfr:primary"),
  },
  {
    exchange_kind: "child_authority_dns",
    vantage_reference: "deployment-vantage:secondary-independent",
    subject_reference: "81.15.150.159",
    query_reference: "axfr:jazleeuw",
    request_bytes: encoder.encode("dns-query:jazleeuw:axfr:secondary"),
    response_bytes: encoder.encode("dns-response:jazleeuw:axfr:secondary"),
  },
  {
    exchange_kind: "parent_authority_dns",
    vantage_reference: "deployment-vantage:primary-external",
    subject_reference: "pirate",
    query_reference: "dnssec-addresses:pirate",
    request_bytes: encoder.encode("dns-query:pirate:dnssec-addresses:primary"),
    response_bytes: encoder.encode("dns-response:pirate:dnssec-addresses:primary"),
  },
  {
    exchange_kind: "parent_authority_dns",
    vantage_reference: "deployment-vantage:secondary-independent",
    subject_reference: "pirate",
    query_reference: "dnssec-addresses:pirate",
    request_bytes: encoder.encode("dns-query:pirate:dnssec-addresses:secondary"),
    response_bytes: encoder.encode("dns-response:pirate:dnssec-addresses:secondary"),
  },
] as const satisfies ReadonlyArray<HnsAuthoritySuccessorDetachedTranscriptEntryV1>;

function bytesHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digest(bytes: Uint8Array): Promise<string> {
  return bytesHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function transcriptDigest(
  transcript: ReadonlyArray<HnsAuthoritySuccessorDetachedTranscriptEntryV1>,
): Promise<string> {
  const encoded = await Promise.all(
    transcript.map(async (entry) => ({
      exchange_kind: entry.exchange_kind,
      vantage_reference: entry.vantage_reference,
      subject_reference: entry.subject_reference,
      query_reference: entry.query_reference,
      request_sha256: await digest(entry.request_bytes),
      response_sha256: await digest(entry.response_bytes),
      request_hex: bytesHex(entry.request_bytes),
      response_hex: bytesHex(entry.response_bytes),
    })),
  );
  return digest(
    encoder.encode(JSON.stringify(["pirate-hns-authority-detached-transcript-v1", encoded])),
  );
}

const detachedTranscriptSha256 = await transcriptDigest(detachedTranscript);
const chainDs = [
  [10875, 13, 2, "ba5d84ad6e3e7ec452a569ee2e6c447ba2b9b533de65c58e59f2f0b7f0773045"],
  [
    10875,
    13,
    4,
    "fde2c7af467092476b5572f9ac43fbbbbe82f63f7c785af984dc5884a2dae0384519dea6982fdbd19c375756b4ebaf70",
  ],
] as const;
const chainAuthorityRecords = [
  ["NS", "ns1.pirate"],
  ["NS", "ns2.pirate"],
  ["DS", ...chainDs[0]],
  ["DS", ...chainDs[1]],
] as const;
const parentChainDs = [
  [34383, 13, 2, "2c16acbc6081a8eeca4582ff967ebba29f30e2df5abd845dd2d1992449ebeecd"],
  [
    34383,
    13,
    4,
    "3c48cc64c1ed89b267850e3d97de40672c4be4ef4f0538c775c68412faa81dc3c5c65418aa24db3bdd7b5ffec8e64005",
  ],
] as const;
const parentChainAuthorityRecords = [
  ["NS", "ns1.pirate"],
  ["NS", "ns2.pirate"],
  ["GLUE4", "ns1.pirate", "94.103.168.161"],
  ["GLUE4", "ns2.pirate", "81.15.150.159"],
  ["DS", ...parentChainDs[0]],
  ["DS", ...parentChainDs[1]],
] as const;
const parentChainAuthorityDigest = await hnsChainAuthorityDigest({
  chain_network: "main",
  chain_genesis_block_hash: "6".repeat(64),
  root_label: "pirate",
  ownership_source: "owner_authoritative_dns_txt",
  authority_records: parentChainAuthorityRecords,
});
const authorityAddressProvenance = {
  source_kind: "dnssec_parent_authoritative_dns_v1",
  parent_zone: "pirate",
  parent_chain_authority_digest: parentChainAuthorityDigest,
  parent_chain_authority_records: parentChainAuthorityRecords,
  views: [
    {
      view_id: "parent-primary-external",
      vantage_reference: "deployment-vantage:primary-external",
      outcome: "observed",
      dnssec_validation: "secure",
      dnskey_key_tag: 34383,
      derived_ds: parentChainDs,
      records: [
        ["A", "ns1.pirate", "94.103.168.161"],
        ["A", "ns2.pirate", "81.15.150.159"],
      ],
    },
    {
      view_id: "parent-secondary-independent",
      vantage_reference: "deployment-vantage:secondary-independent",
      outcome: "observed",
      dnssec_validation: "secure",
      dnskey_key_tag: 34383,
      derived_ds: parentChainDs,
      records: [
        ["A", "ns1.pirate", "94.103.168.161"],
        ["A", "ns2.pirate", "81.15.150.159"],
      ],
    },
  ],
} as const;

async function sourceObservation(): Promise<HnsAuthoritySuccessorSourceObservationV1> {
  const observerEvidence = await encodeHnsAuthorityDetachedObserverEvidenceV1({
    observation_id: "observer-jazleeuw-verified-01",
    request_sha256: "1".repeat(64),
    provider_id: "hns.owner.v1",
    provider_configuration_reference: "hns-observer-production-config-v1",
    provider_configuration_version: "production-v1",
    provider_configuration_digest: "2".repeat(64),
    environment: "production",
    ownership_source: "owner_authoritative_dns_txt",
    root_label: "jazleeuw",
    txt_name: "_pirate.jazleeuw",
    expected_txt_value_sha256: "3".repeat(64),
    control_identity_digest: "4".repeat(64),
    chain_authority_digest: "5".repeat(64),
    root_exists: true,
    root_control_verified: true,
    expiry_horizon_sufficient: true,
    chain_network: "main",
    chain_genesis_block_hash: "6".repeat(64),
    chain_anchor_height: 344_448,
    chain_anchor_block_hash: "7".repeat(64),
    chain_anchor_median_time: 1_777_689_600,
    expiry_height: 500_000,
    evidence_reference: evidenceReference,
    detached_transcript: detachedTranscript,
  });
  const view = (authorityAddress: string) => ({
    authority_address: authorityAddress,
    outcome: "observed" as const,
    zone_bytes_digest: "c".repeat(64),
    dnskey_key_tag: 10875,
    derived_ds: chainDs,
  });
  return {
    observer_evidence_reference: evidenceReference,
    detached_transcript: detachedTranscript,
    generation_snapshot_database_time: "2026-08-29T17:00:00.000Z",
    source_commit: "1".repeat(40),
    root_label: "jazleeuw",
    observed_at: "2026-08-29T17:00:00.000Z",
    chain_height: 344_448,
    expected_chain_network: "main",
    chain_authority_records: chainAuthorityRecords,
    authority_address_provenance: authorityAddressProvenance,
    generation_snapshot: {
      dns_zone_activation_id: "hns-rehearsal-dns-zone-v1",
      dns_current_generation: 5,
      app_host_activation_id: "hns-rehearsal-app-host-v1",
      app_host_current_generation: 9,
      successor_dns_latest_health_generation: 0,
    },
    expected_authority_addresses: ["94.103.168.161", "81.15.150.159"],
    authority_views: [view("94.103.168.161"), view("81.15.150.159")],
    artifacts: {
      authority_inventory: encoder.encode('{"artifact":"inventory"}'),
      dns_zone_activation: encoder.encode('{"artifact":"dns"}'),
      app_host_activation: encoder.encode('{"artifact":"app"}'),
      health_observation: encoder.encode('{"artifact":"health"}'),
      observer_evidence: observerEvidence,
    },
  };
}

type CandidatePreparer = typeof prepareHnsAuthoritySuccessorCandidateV1;

function fakePreparer(calls: Parameters<CandidatePreparer>[0][]): CandidatePreparer {
  return async (input) => {
    calls.push(input);
    const [firstView, secondView] = input.authority_views;
    if (firstView === undefined || secondView === undefined) throw new Error("missing views");
    return {
      candidate: {
        version: HNS_AUTHORITY_SUCCESSOR_CANDIDATE_VERSION,
        source_commit: input.source_commit,
        root_label: input.root_label,
        observed_at: input.observed_at,
        chain_height: input.chain_height,
        chain_network: input.expected_chain_network,
        chain_genesis_block_hash: "6".repeat(64),
        chain_authority_digest: "5".repeat(64),
        chain_authority_records: input.chain_authority_records,
        authority_address_provenance: input.authority_address_provenance,
        generations: {
          dns_activation_generation: 6,
          app_host_activation_generation: 10,
          health_generation: 1,
        },
        dnskey_key_tag: 10875,
        authority_views: [firstView, secondView],
        chain_ds: chainDs,
        artifacts: [],
      },
      candidate_bytes: candidateBytes,
      candidate_sha256: "d".repeat(64),
    };
  };
}

function source(value: HnsAuthoritySuccessorSourceObservationV1, calls: string[]) {
  return {
    observe: ({ signal }) => {
      expect(signal.aborted).toBe(false);
      calls.push("observe");
      return value;
    },
  } satisfies HnsAuthoritySuccessorObservationSourceV1;
}

test("derives the complete 6/10/1 package from live authority and row-identity ports", async () => {
  const observedAt = "2026-08-29T17:00:00.000Z";
  const zoneBytes = encoder.encode("$ORIGIN jazleeuw.\n; canonical live observation\n");
  const zoneDigest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", zoneBytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const authoritativeGlue = [
    {
      authority_nameserver: "ns1.pirate",
      authority_address_family: "GLUE4" as const,
      authority_address: "94.103.168.161",
      active: true,
    },
    {
      authority_nameserver: "ns2.pirate",
      authority_address_family: "GLUE4" as const,
      authority_address: "81.15.150.159",
      active: true,
    },
  ];
  const dnsWriteCapabilities = [
    {
      capability_reference: "dns-write:jazleeuw",
      scope_kind: "exact_root" as const,
      root_label: "jazleeuw",
      active: true,
    },
  ];
  const inventoryBytes = await encodeHnsAuthorityInventory({
    version: "pirate-hns-authority-inventory-v1",
    authority_inventory_reference: "authority-inventory:jazleeuw",
    authority_inventory_version: "v6",
    environment: "production",
    completeness: "complete",
    runtime_capability_set_digest: await hnsAuthorityCapabilitySetDigest({
      environment: "production",
      authoritative_nameserver_glue: authoritativeGlue,
      dns_write_capabilities: dnsWriteCapabilities,
    }),
    published_at: "2026-08-29T16:00:00.000Z",
    expires_at: "2026-08-29T18:00:00.000Z",
    authoritative_nameserver_glue: authoritativeGlue,
    dns_write_capabilities: dnsWriteCapabilities,
  });
  const chainAuthorityDigest = await hnsChainAuthorityDigest({
    chain_network: "main",
    chain_genesis_block_hash: "6".repeat(64),
    root_label: "jazleeuw",
    ownership_source: "owner_authoritative_dns_txt",
    authority_records: chainAuthorityRecords,
  });
  const view = (authorityAddress: string) => ({
    authority_address: authorityAddress,
    outcome: "observed" as const,
    zone_bytes_digest: zoneDigest,
    dnskey_key_tag: 10875,
    derived_ds: chainDs,
  });
  const generationReads: Array<readonly [string, string]> = [];
  const harnessSource = makeHnsAuthoritySuccessorObservationSourceV1({
    health_valid_for_seconds: 3_600,
    live_authority: {
      observe: () => ({
        source_commit: "1".repeat(40),
        observer_facts: {
          observation_id: "observer-jazleeuw-verified-01",
          request_sha256: "1".repeat(64),
          provider_id: "hns.owner.v1",
          provider_configuration_reference: "hns-observer-production-config-v1",
          provider_configuration_version: "production-v1",
          provider_configuration_digest: "2".repeat(64),
          environment: "production",
          ownership_source: "owner_authoritative_dns_txt",
          root_label: "jazleeuw",
          txt_name: "_pirate.jazleeuw",
          expected_txt_value_sha256: "3".repeat(64),
          control_identity_digest: "4".repeat(64),
          chain_authority_digest: chainAuthorityDigest,
          root_exists: true,
          root_control_verified: true,
          expiry_horizon_sufficient: true,
          chain_network: "main",
          chain_genesis_block_hash: "6".repeat(64),
          chain_anchor_height: 344_448,
          chain_anchor_block_hash: "7".repeat(64),
          chain_anchor_median_time: Date.parse(observedAt) / 1_000,
          expiry_height: 500_000,
          evidence_reference: evidenceReference,
        },
        chain_authority_records: chainAuthorityRecords,
        authority_address_provenance: authorityAddressProvenance,
        authority_views: [view("94.103.168.161"), view("81.15.150.159")],
        detached_transcript: detachedTranscript,
        authority_inventory_bytes: inventoryBytes,
        zone_bytes: zoneBytes,
        dns_authority_reference: "dns-authority:jazleeuw",
        dnssec_keyset_reference: "dnssec-keyset:jazleeuw",
        gateway_deployment_reference: "gateway:jazleeuw",
        gateway_certificate_spki_sha256: "2".repeat(64),
        gateway_healthy: true,
      }),
    },
    generation_reader: {
      read: (identity) => {
        generationReads.push([identity.canonical_root, identity.normalized_app_host]);
        return {
          database_time: observedAt,
          snapshot: {
            dns_zone_activation_id: "hns-rehearsal-dns-zone-v1",
            dns_current_generation: 5,
            app_host_activation_id: "hns-rehearsal-app-host-v1",
            app_host_current_generation: 9,
            successor_dns_latest_health_generation: 0,
          },
        };
      },
    },
  });
  const emissions: Uint8Array[] = [];
  const result = await runHnsAuthoritySuccessorObservationHarnessV1([], harnessSource, {
    emit: async (bytes) => {
      emissions.push(Uint8Array.from(bytes));
    },
  });

  expect(generationReads).toEqual([["jazleeuw", "app.jazleeuw"]]);
  expect(result.candidate.candidate.generations).toEqual({
    dns_activation_generation: 6,
    app_host_activation_generation: 10,
    health_generation: 1,
  });
  const observerArtifact = result.candidate.candidate.artifacts.find(
    (artifact) => artifact.name === "observer_evidence",
  );
  expect(observerArtifact?.bytes_hex).toContain(bytesHex(encoder.encode(detachedTranscriptSha256)));
  if (observerArtifact === undefined) throw new Error("missing observer evidence artifact");
  const detachedEvidence = await decodeHnsAuthorityDetachedObserverEvidenceV1(
    Uint8Array.from(observerArtifact.bytes_hex.match(/.{2}/gu) ?? [], (byte) =>
      Number.parseInt(byte, 16),
    ),
  );
  const hnsTranscript = detachedEvidence.detached_transcript.find(
    (entry) => entry.exchange_kind === "hns_rpc",
  );
  expect(hnsTranscript?.response_hex).toContain(
    bytesHex(encoder.encode(jazleeuwUpdate3ResourceHex)),
  );
  expect(emissions).toEqual([result.observation_document_bytes]);
});

test("acquires every live fact from one source and emits one canonical observation document", async () => {
  const observed = await sourceObservation();
  const sourceCalls: string[] = [];
  const preparationCalls: Parameters<CandidatePreparer>[0][] = [];
  const emissions: Uint8Array[] = [];
  const io: HnsAuthoritySuccessorObservationHarnessIoV1 = {
    emit: async (bytes) => {
      emissions.push(Uint8Array.from(bytes));
    },
  };

  const result = await runHnsAuthoritySuccessorObservationHarnessV1(
    [],
    source(observed, sourceCalls),
    io,
    {},
    fakePreparer(preparationCalls),
  );

  expect(sourceCalls).toEqual(["observe"]);
  expect(preparationCalls).toHaveLength(1);
  expect(emissions).toEqual([result.observation_document_bytes]);
  const decoded = await decodeHnsAuthoritySuccessorObservationDocumentV1(
    result.observation_document_bytes,
  );
  expect(decoded.source_observation.generation_snapshot).toEqual(observed.generation_snapshot);
  expect(decoded.source_observation.authority_address_provenance).toEqual(
    authorityAddressProvenance,
  );
  expect(decoded.source_observation.artifacts).toEqual(observed.artifacts);
  expect(decoded.document.source_provenance).toMatchObject({
    source_kind: "detached-read-only-observation-v1",
    observer_evidence_reference: evidenceReference,
    detached_transcript_sha256: detachedTranscriptSha256,
  });
});

test("emitter accepts only the single bounded observation document and revalidates it", async () => {
  const harnessEmissions: Uint8Array[] = [];
  await runHnsAuthoritySuccessorObservationHarnessV1(
    [],
    source(await sourceObservation(), []),
    {
      emit: async (bytes) => {
        harnessEmissions.push(Uint8Array.from(bytes));
      },
    },
    {},
    fakePreparer([]),
  );
  const observationBytes = harnessEmissions[0];
  if (observationBytes === undefined) throw new Error("missing observation bytes");
  const reads: Array<readonly [string, number]> = [];
  const candidateEmissions: Uint8Array[] = [];
  const result = await runHnsAuthoritySuccessorEmitterV1(
    ["--input", "/evidence/observation.json"],
    {
      read: async (path, maximumBytes) => {
        reads.push([path, maximumBytes]);
        return observationBytes;
      },
      emit: async (bytes) => {
        candidateEmissions.push(Uint8Array.from(bytes));
      },
    },
    fakePreparer([]),
  );

  expect(reads).toEqual([
    ["/evidence/observation.json", HNS_AUTHORITY_SUCCESSOR_OBSERVATION_MAX_BYTES],
  ]);
  expect(candidateEmissions).toEqual([candidateBytes]);
  expect(result.candidate_bytes).toEqual(candidateBytes);
});

test("rejects operator arguments and source failure without partial output", async () => {
  const emissions: Uint8Array[] = [];
  const io = {
    emit: async (bytes: Uint8Array) => {
      emissions.push(bytes);
    },
  };
  const observed = await sourceObservation();
  await expect(
    runHnsAuthoritySuccessorObservationHarnessV1(
      ["--root", "jazleeuw"],
      source(observed, []),
      io,
      {},
      fakePreparer([]),
    ),
  ).rejects.toMatchObject({ reason: "invalid_arguments" });
  await expect(
    runHnsAuthoritySuccessorObservationHarnessV1(
      [],
      { observe: () => Promise.reject(new Error("unavailable")) },
      io,
      {},
      fakePreparer([]),
    ),
  ).rejects.toMatchObject({ reason: "source_unavailable" });
  expect(emissions).toHaveLength(0);
});

test("cross-pins detached observer provenance, transcripts, and the generation snapshot", async () => {
  const observed = await sourceObservation();
  const mismatched = {
    ...observed,
    observer_evidence_reference: "hns-detached-observation:main:different-evidence",
  };
  await expect(
    runHnsAuthoritySuccessorObservationHarnessV1(
      [],
      source(mismatched, []),
      { emit: async () => undefined },
      {},
      fakePreparer([]),
    ),
  ).rejects.toMatchObject({ reason: "observer_provenance_mismatch" });

  const emitted: Uint8Array[] = [];
  await runHnsAuthoritySuccessorObservationHarnessV1(
    [],
    source(observed, []),
    {
      emit: async (bytes) => {
        emitted.push(Uint8Array.from(bytes));
      },
    },
    {},
    fakePreparer([]),
  );
  const original = emitted[0];
  if (original === undefined) throw new Error("missing observation bytes");
  const altered = JSON.parse(new TextDecoder().decode(original)) as {
    generation_snapshot: { dns_current_generation: number };
  };
  altered.generation_snapshot.dns_current_generation += 1;
  await expect(
    decodeHnsAuthoritySuccessorObservationDocumentV1(encoder.encode(JSON.stringify(altered))),
  ).rejects.toMatchObject({ reason: "observer_provenance_mismatch" });
});

test("refuses altered detached transcript bytes even with coherently updated transcript hashes", async () => {
  const emitted: Uint8Array[] = [];
  await runHnsAuthoritySuccessorObservationHarnessV1(
    [],
    source(await sourceObservation(), []),
    {
      emit: async (bytes) => {
        emitted.push(Uint8Array.from(bytes));
      },
    },
    {},
    fakePreparer([]),
  );
  const original = emitted[0];
  if (original === undefined) throw new Error("missing observation bytes");
  const altered = JSON.parse(new TextDecoder().decode(original)) as {
    source_provenance: { detached_transcript_sha256: string };
    detached_transcript: Array<{
      response_hex: string;
      response_sha256: string;
    }>;
  };
  const responseBytes = encoder.encode("different but internally coherent HSD response");
  const first = altered.detached_transcript[0];
  if (first === undefined) throw new Error("missing HSD transcript");
  first.response_hex = bytesHex(responseBytes);
  first.response_sha256 = await digest(responseBytes);
  altered.source_provenance.detached_transcript_sha256 = await digest(
    encoder.encode(
      JSON.stringify(["pirate-hns-authority-detached-transcript-v1", altered.detached_transcript]),
    ),
  );

  await expect(
    decodeHnsAuthoritySuccessorObservationDocumentV1(encoder.encode(JSON.stringify(altered))),
  ).rejects.toMatchObject({ reason: "observer_provenance_mismatch" });
});

test("rejects noncanonical observation bytes and never emits a candidate", async () => {
  const emitted: Uint8Array[] = [];
  await runHnsAuthoritySuccessorObservationHarnessV1(
    [],
    source(await sourceObservation(), []),
    {
      emit: async (bytes) => {
        emitted.push(Uint8Array.from(bytes));
      },
    },
    {},
    fakePreparer([]),
  );
  const canonical = emitted[0];
  if (canonical === undefined) throw new Error("missing observation bytes");
  const noncanonical = encoder.encode(`${new TextDecoder().decode(canonical)}\n`);
  const candidates: Uint8Array[] = [];
  await expect(
    runHnsAuthoritySuccessorEmitterV1(
      ["--input", "/evidence/observation.json"],
      {
        read: async () => noncanonical,
        emit: async (bytes) => {
          candidates.push(bytes);
        },
      },
      fakePreparer([]),
    ),
  ).rejects.toMatchObject({ reason: "invalid_observation_document" });
  expect(candidates).toHaveLength(0);
});

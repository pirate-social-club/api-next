import { describe, expect, test } from "vitest";
import {
  decodeHnsAppHostTransitionDocumentV1,
  decodeHnsAuthorityDetachedObserverEvidenceV1,
  decodeHnsDnsHealthDocumentV1,
  decodeHnsDnsZonePersistenceDocumentV1,
  deriveHnsAuthoritySuccessorGenerationsV1,
  encodeHnsAppHostTransitionDocumentV1,
  encodeHnsAuthorityDetachedObserverEvidenceV1,
  encodeHnsDnsHealthDocumentV1,
  encodeHnsDnsZonePersistenceDocumentV1,
  HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
  prepareHnsAuthoritySuccessorCandidateV1,
  prepareHnsDnsZoneActivationDocumentV1,
  requireHnsAuthorityEmitObservationV1,
  requireReviewedHnsAuthorityCandidateV1,
} from "./hns-host-persistence.ts";
import {
  decodeHnsAuthorityInventoryBytes,
  encodeHnsAuthorityInventory,
  hnsAuthorityCapabilitySetDigest,
} from "./namespace-ownership/hns-authority-inventory.ts";
import { hnsChainAuthorityDigest } from "./namespace-ownership/hns-control-observer.ts";

const encoder = new TextEncoder();
const detachedTranscript = [
  ["hns_rpc", "observer-vantage:primary-hsd", "jazleeuw", "getnameresource"],
  ["child_authority_dns", "deployment-vantage:primary", "94.103.168.161", "axfr"],
  ["child_authority_dns", "deployment-vantage:secondary", "81.15.150.159", "axfr"],
  ["parent_authority_dns", "deployment-vantage:primary-external", "pirate", "addresses"],
  ["parent_authority_dns", "deployment-vantage:secondary-independent", "pirate", "addresses"],
].map(([exchange_kind, vantage_reference, subject_reference, query_reference], index) => ({
  exchange_kind: exchange_kind as "hns_rpc" | "child_authority_dns" | "parent_authority_dns",
  vantage_reference: vantage_reference as string,
  subject_reference: subject_reference as string,
  query_reference: query_reference as string,
  request_bytes: encoder.encode(`request-${index}`),
  response_bytes: encoder.encode(`response-${index}`),
}));

describe("HNS authority successor generation preparation", () => {
  test("predicts the fenced jazleeuw successor generations without a reservation", () => {
    expect(
      deriveHnsAuthoritySuccessorGenerationsV1({
        dns_zone_activation_id: "hns-rehearsal-dns-zone-v1",
        dns_current_generation: 5,
        app_host_activation_id: "hns-rehearsal-app-host-v1",
        app_host_current_generation: 9,
        successor_dns_latest_health_generation: 0,
      }),
    ).toEqual({
      dns_activation_generation: 6,
      app_host_activation_generation: 10,
      health_generation: 1,
    });
  });

  test.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["non-finite", Number.POSITIVE_INFINITY],
    ["non-incrementable", Number.MAX_SAFE_INTEGER],
  ])("rejects a %s generation snapshot", (_label, value) => {
    expect(() =>
      deriveHnsAuthoritySuccessorGenerationsV1({
        dns_zone_activation_id: "hns-rehearsal-dns-zone-v1",
        dns_current_generation: value,
        app_host_activation_id: "hns-rehearsal-app-host-v1",
        app_host_current_generation: 9,
        successor_dns_latest_health_generation: 0,
      }),
    ).toThrow("DNS current generation must be a nonnegative incrementable safe integer");
  });
});

test("emit and persistence preparation share the exact activation bytes", async () => {
  const zoneBytes = new TextEncoder().encode("$ORIGIN jazleeuw.\n; canonical observation\n");
  const input = {
    payload: {
      version: HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
      dns_zone_activation_id: "hns-rehearsal-dns-zone-v1",
      canonical_root: "jazleeuw",
      dns_authority: ["pirate_managed_dns_v1", "dns-authority:jazleeuw", 6] as const,
      pirate_dns_authority_inventory: [
        "authority-inventory:jazleeuw",
        "v6",
        "1".repeat(64),
      ] as const,
      zone_revision: 6,
      dnssec_keyset: ["dnssec-keyset:jazleeuw", "key-tag-10875"] as const,
      gateway: ["gateway:jazleeuw", "2".repeat(64)] as const,
      stable_chain_delegation_snapshot: ["delegation:jazleeuw", "3".repeat(64)] as const,
    },
    zone_bytes: zoneBytes,
  } as const;

  const emitted = await prepareHnsDnsZoneActivationDocumentV1(input);
  const persistencePrepared = await prepareHnsDnsZoneActivationDocumentV1(input);

  expect(emitted).toEqual(persistencePrepared);
  expect(emitted.activation_document_bytes).toEqual(persistencePrepared.activation_document_bytes);
  expect(emitted.dnssec_keyset_version).toBe("key-tag-10875");
  expect(emitted.zone_bytes).not.toBe(zoneBytes);
});

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
const jazleeuwUpdate3ResourceHex =
  "0001036e7331067069726174650001036e7332c0060601387069726174652d766572696669636174696f6e3d6e76735f3963633937306561653631393432313461643938613736626661356166336163002a7b0d0220ba5d84ad6e3e7ec452a569ee2e6c447ba2b9b533de65c58e59f2f0b7f0773045002a7b0d0430fde2c7af467092476b5572f9ac43fbbbbe82f63f7c785af984dc5884a2dae0384519dea6982fdbd19c375756b4ebaf70";
const canonicalZoneBytes = new TextEncoder().encode("$ORIGIN jazleeuw.\n; canonical observation\n");
const canonicalZoneDigest = "907702901595a5d159cf4d855a8a3c907cfda15cb96f2fa8888cde954d324bb6";
const observedView = (authorityAddress: string) => ({
  authority_address: authorityAddress,
  outcome: "observed" as const,
  zone_bytes_digest: canonicalZoneDigest,
  dnskey_key_tag: 10875,
  derived_ds: chainDs,
});
const authorityAddressRecords = [
  ["A", "ns1.pirate", "94.103.168.161"],
  ["A", "ns2.pirate", "81.15.150.159"],
] as const;
const pirateChainDs = [
  [34383, 13, 2, "2c16acbc6081a8eeca4582ff967ebba29f30e2df5abd845dd2d1992449ebeecd"],
  [
    34383,
    13,
    4,
    "3c48cc64c1ed89b267850e3d97de40672c4be4ef4f0538c775c68412faa81dc3c5c65418aa24db3bdd7b5ffec8e64005",
  ],
] as const;
const pirateChainAuthorityRecords = [
  ["NS", "ns1.pirate"],
  ["NS", "ns2.pirate"],
  ["GLUE4", "ns1.pirate", "94.103.168.161"],
  ["GLUE4", "ns2.pirate", "81.15.150.159"],
  ["DS", ...pirateChainDs[0]],
  ["DS", ...pirateChainDs[1]],
] as const;
const pirateChainAuthorityDigest = await hnsChainAuthorityDigest({
  chain_network: "main",
  chain_genesis_block_hash: "6".repeat(64),
  root_label: "pirate",
  ownership_source: "owner_authoritative_dns_txt",
  authority_records: pirateChainAuthorityRecords,
});
const authorityAddressProvenance = {
  source_kind: "dnssec_parent_authoritative_dns_v1",
  parent_zone: "pirate",
  parent_chain_authority_digest: pirateChainAuthorityDigest,
  parent_chain_authority_records: pirateChainAuthorityRecords,
  views: [
    {
      view_id: "parent-primary-external",
      vantage_reference: "deployment-vantage:primary-external",
      outcome: "observed",
      dnssec_validation: "secure",
      dnskey_key_tag: 34383,
      derived_ds: pirateChainDs,
      records: authorityAddressRecords,
    },
    {
      view_id: "parent-secondary-independent",
      vantage_reference: "deployment-vantage:secondary-independent",
      outcome: "observed",
      dnssec_validation: "secure",
      dnskey_key_tag: 34383,
      derived_ds: pirateChainDs,
      records: authorityAddressRecords,
    },
  ],
} as const;

test("admits only two complete agreeing authority views with chain-matching DS", () => {
  expect(
    requireHnsAuthorityEmitObservationV1({
      expected_authority_addresses: ["94.103.168.161", "81.15.150.159"],
      views: [observedView("94.103.168.161"), observedView("81.15.150.159")],
      chain_ds: chainDs,
    }),
  ).toHaveLength(2);
});

test("refuses missing and unavailable authority views without partial emission", () => {
  const expected = ["94.103.168.161", "81.15.150.159"] as const;
  expect(() =>
    requireHnsAuthorityEmitObservationV1({
      expected_authority_addresses: expected,
      views: [observedView(expected[0])],
      chain_ds: chainDs,
    }),
  ).toThrow("incomplete_authority_views");
  expect(() =>
    requireHnsAuthorityEmitObservationV1({
      expected_authority_addresses: expected,
      views: [
        observedView(expected[0]),
        {
          authority_address: expected[1],
          outcome: "unavailable",
          zone_bytes_digest: null,
          dnskey_key_tag: null,
          derived_ds: null,
        },
      ],
      chain_ds: chainDs,
    }),
  ).toThrow("unavailable_authority_view");
});

test("refuses authority disagreement and DNSKEY-to-chain DS mismatch", () => {
  const expected = ["94.103.168.161", "81.15.150.159"] as const;
  expect(() =>
    requireHnsAuthorityEmitObservationV1({
      expected_authority_addresses: expected,
      views: [observedView(expected[0]), { ...observedView(expected[1]), dnskey_key_tag: 39280 }],
      chain_ds: chainDs,
    }),
  ).toThrow("authority_view_mismatch");
  expect(() =>
    requireHnsAuthorityEmitObservationV1({
      expected_authority_addresses: expected,
      views: [observedView(expected[0]), observedView(expected[1])],
      chain_ds: [[39280, 13, 2, "d".repeat(64)]],
    }),
  ).toThrow("dnskey_ds_mismatch");
  const wrongTagDs = [[39280, 13, 2, "d".repeat(64)]] as const;
  expect(() =>
    requireHnsAuthorityEmitObservationV1({
      expected_authority_addresses: expected,
      views: [
        { ...observedView(expected[0]), derived_ds: wrongTagDs },
        { ...observedView(expected[1]), derived_ds: wrongTagDs },
      ],
      chain_ds: wrongTagDs,
    }),
  ).toThrow("dnskey_ds_mismatch");
});

const emittedSnapshot = {
  dns_zone_activation_id: "hns-rehearsal-dns-zone-v1",
  dns_current_generation: 5,
  app_host_activation_id: "hns-rehearsal-app-host-v1",
  app_host_current_generation: 9,
  successor_dns_latest_health_generation: 0,
} as const;

async function canonicalCandidateArtifacts() {
  const chainAuthorityDigest = await hnsChainAuthorityDigest({
    chain_network: "main",
    chain_genesis_block_hash: "6".repeat(64),
    root_label: "jazleeuw",
    ownership_source: "owner_authoritative_dns_txt",
    authority_records: chainAuthorityRecords,
  });
  const authoritativeNameserverGlue = [
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
  const authorityInventory = await encodeHnsAuthorityInventory({
    version: "pirate-hns-authority-inventory-v1",
    authority_inventory_reference: "authority-inventory:jazleeuw",
    authority_inventory_version: "v6",
    environment: "production",
    completeness: "complete",
    runtime_capability_set_digest: await hnsAuthorityCapabilitySetDigest({
      environment: "production",
      authoritative_nameserver_glue: authoritativeNameserverGlue,
      dns_write_capabilities: dnsWriteCapabilities,
    }),
    published_at: "2026-08-29T17:00:00.000Z",
    expires_at: "2026-08-29T18:00:00.000Z",
    authoritative_nameserver_glue: authoritativeNameserverGlue,
    dns_write_capabilities: dnsWriteCapabilities,
  });
  const authorityInventoryDigest = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", authorityInventory)),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
    chain_authority_digest: chainAuthorityDigest,
    root_exists: true,
    root_control_verified: true,
    expiry_horizon_sufficient: true,
    chain_network: "main",
    chain_genesis_block_hash: "6".repeat(64),
    chain_anchor_height: 344_448,
    chain_anchor_block_hash: "7".repeat(64),
    chain_anchor_median_time: 1_777_689_600,
    expiry_height: 500_000,
    evidence_reference: "hns-detached-observation:main:jazleeuw-verified-01",
    detached_transcript: detachedTranscript,
  });
  const dnsZoneActivation = await prepareHnsDnsZoneActivationDocumentV1({
    payload: {
      version: HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
      dns_zone_activation_id: "hns-rehearsal-dns-zone-v1",
      canonical_root: "jazleeuw",
      dns_authority: ["pirate_managed_dns_v1", "dns-authority:jazleeuw", 6],
      pirate_dns_authority_inventory: [
        "authority-inventory:jazleeuw",
        "v6",
        authorityInventoryDigest,
      ],
      zone_revision: 6,
      dnssec_keyset: ["dnssec-keyset:jazleeuw", "key-tag-10875"],
      gateway: ["gateway:jazleeuw", "2".repeat(64)],
      stable_chain_delegation_snapshot: ["delegation:jazleeuw:344448", chainAuthorityDigest],
    },
    zone_bytes: canonicalZoneBytes,
  });
  const appHostActivation = encodeHnsAppHostTransitionDocumentV1({
    operation_id: "app-operation-10",
    idempotency_key: "app-key-10",
    request_hash: "a".repeat(64),
    app_host_activation_id: "hns-rehearsal-app-host-v1",
    expected_activation_generation: 9,
    target_status: "active",
    reason_code: "canonical-authority",
  });
  const healthObservation = encodeHnsDnsHealthDocumentV1({
    operation_id: "health-operation-1",
    idempotency_key: "health-key-1",
    request_hash: "b".repeat(64),
    dns_zone_activation_id: "hns-rehearsal-dns-zone-v1",
    activation_generation: 6,
    expected_health_generation: 0,
    stable_chain_delegation_snapshot_reference: "delegation:jazleeuw:344448",
    stable_chain_delegation_snapshot_digest: chainAuthorityDigest,
    observed_zone_bytes_digest: canonicalZoneDigest,
    observed_dnssec_keyset_reference: "dnssec-keyset:jazleeuw",
    observed_dnssec_keyset_version: "key-tag-10875",
    observed_gateway_deployment_reference: "gateway:jazleeuw",
    observed_gateway_certificate_spki_sha256: "2".repeat(64),
    delegation_matches: true,
    ds_authenticates_zone: true,
    retained_zone_digest_matches: true,
    gateway_healthy: true,
    valid_for_seconds: 3600,
  });
  return {
    authority_inventory: authorityInventory,
    dns_zone_activation: encodeHnsDnsZonePersistenceDocumentV1(dnsZoneActivation),
    app_host_activation: appHostActivation,
    health_observation: healthObservation,
    observer_evidence: observerEvidence,
  } as const;
}

type CandidatePreparationInput = Parameters<typeof prepareHnsAuthoritySuccessorCandidateV1>[0];
type DecodedDnsDocument = Awaited<ReturnType<typeof decodeHnsDnsZonePersistenceDocumentV1>>;

async function canonicalCandidateInput(): Promise<CandidatePreparationInput> {
  return {
    source_commit: "1".repeat(40),
    root_label: "jazleeuw",
    observed_at: "2026-08-29T17:00:00.000Z",
    chain_height: 344_448,
    expected_chain_network: "main",
    chain_authority_records: chainAuthorityRecords,
    authority_address_provenance: authorityAddressProvenance,
    generation_snapshot: emittedSnapshot,
    expected_authority_addresses: ["94.103.168.161", "81.15.150.159"],
    authority_views: [observedView("94.103.168.161"), observedView("81.15.150.159")],
    artifacts: await canonicalCandidateArtifacts(),
  };
}

async function rewriteDnsArtifact(
  bytes: Uint8Array,
  transform: (document: DecodedDnsDocument) => DecodedDnsDocument,
): Promise<Uint8Array> {
  const document = transform(await decodeHnsDnsZonePersistenceDocumentV1(bytes));
  const prepared = await prepareHnsDnsZoneActivationDocumentV1({
    payload: {
      version: HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
      dns_zone_activation_id: document.dns_zone_activation_id,
      canonical_root: document.canonical_root,
      dns_authority: [
        document.dns_authority_kind,
        document.dns_authority_reference,
        document.dns_authority_generation,
      ],
      pirate_dns_authority_inventory: [
        document.pirate_dns_authority_inventory_reference,
        document.pirate_dns_authority_inventory_version,
        document.pirate_dns_authority_inventory_digest,
      ],
      zone_revision: document.zone_revision,
      dnssec_keyset: [document.dnssec_keyset_reference, document.dnssec_keyset_version],
      gateway: [document.gateway_deployment_reference, document.gateway_certificate_spki_sha256],
      stable_chain_delegation_snapshot: [
        document.stable_chain_delegation_snapshot_reference,
        document.stable_chain_delegation_snapshot_digest,
      ],
    },
    zone_bytes: document.zone_bytes,
  });
  return encodeHnsDnsZonePersistenceDocumentV1(prepared);
}

function rewriteHealthArtifact(
  bytes: Uint8Array,
  patch: Partial<ReturnType<typeof decodeHnsDnsHealthDocumentV1>>,
): Uint8Array {
  return encodeHnsDnsHealthDocumentV1({ ...decodeHnsDnsHealthDocumentV1(bytes), ...patch });
}

function rewriteAppArtifact(
  bytes: Uint8Array,
  patch: Partial<ReturnType<typeof decodeHnsAppHostTransitionDocumentV1>>,
): Uint8Array {
  return encodeHnsAppHostTransitionDocumentV1({
    ...decodeHnsAppHostTransitionDocumentV1(bytes),
    ...patch,
  });
}

test("refuses every divergent semantic join between canonical review artifacts", async () => {
  const cases: ReadonlyArray<
    readonly [
      string,
      (
        input: CandidatePreparationInput,
      ) => CandidatePreparationInput | Promise<CandidatePreparationInput>,
    ]
  > = [
    [
      "inventory reference",
      async (input) => {
        const decoded = await decodeHnsAuthorityInventoryBytes(input.artifacts.authority_inventory);
        return {
          ...input,
          artifacts: {
            ...input.artifacts,
            authority_inventory: await encodeHnsAuthorityInventory({
              ...decoded.inventory,
              authority_inventory_reference: "authority-inventory:elsewhere",
            }),
          },
        };
      },
    ],
    [
      "inventory version",
      async (input) => ({
        ...input,
        artifacts: {
          ...input.artifacts,
          dns_zone_activation: await rewriteDnsArtifact(
            input.artifacts.dns_zone_activation,
            (document) => ({ ...document, pirate_dns_authority_inventory_version: "v7" }),
          ),
        },
      }),
    ],
    [
      "inventory digest",
      async (input) => ({
        ...input,
        artifacts: {
          ...input.artifacts,
          dns_zone_activation: await rewriteDnsArtifact(
            input.artifacts.dns_zone_activation,
            (document) => ({ ...document, pirate_dns_authority_inventory_digest: "f".repeat(64) }),
          ),
        },
      }),
    ],
    [
      "inventory freshness",
      async (input) => {
        const decoded = await decodeHnsAuthorityInventoryBytes(input.artifacts.authority_inventory);
        return {
          ...input,
          artifacts: {
            ...input.artifacts,
            authority_inventory: await encodeHnsAuthorityInventory({
              ...decoded.inventory,
              published_at: "2026-08-29T15:00:00.000Z",
              expires_at: "2026-08-29T16:00:00.000Z",
            }),
          },
        };
      },
    ],
    [
      "inventory environment",
      (input) => ({
        ...input,
        artifacts: {
          ...input.artifacts,
          observer_evidence: new TextEncoder().encode(
            new TextDecoder()
              .decode(input.artifacts.observer_evidence)
              .replace('"environment":"production"', '"environment":"staging"'),
          ),
        },
      }),
    ],
    [
      "authority address inventory",
      (input) => ({
        ...input,
        expected_authority_addresses: ["94.103.168.161", "203.0.113.53"],
        authority_views: [observedView("94.103.168.161"), observedView("203.0.113.53")],
      }),
    ],
    [
      "DNS root",
      async (input) => ({
        ...input,
        artifacts: {
          ...input.artifacts,
          dns_zone_activation: await rewriteDnsArtifact(
            input.artifacts.dns_zone_activation,
            (document) => ({ ...document, canonical_root: "elsewhere" }),
          ),
        },
      }),
    ],
    [
      "DNS generation",
      async (input) => ({
        ...input,
        artifacts: {
          ...input.artifacts,
          dns_zone_activation: await rewriteDnsArtifact(
            input.artifacts.dns_zone_activation,
            (document) => ({ ...document, dns_authority_generation: 7 }),
          ),
        },
      }),
    ],
    [
      "DNS row identity",
      (input) => ({
        ...input,
        generation_snapshot: {
          ...input.generation_snapshot,
          dns_zone_activation_id: "dns-zone:elsewhere",
        },
      }),
    ],
    [
      "DNS zone revision",
      async (input) => ({
        ...input,
        artifacts: {
          ...input.artifacts,
          dns_zone_activation: await rewriteDnsArtifact(
            input.artifacts.dns_zone_activation,
            (document) => ({ ...document, zone_revision: 7 }),
          ),
        },
      }),
    ],
    [
      "DNS key tag",
      async (input) => ({
        ...input,
        artifacts: {
          ...input.artifacts,
          dns_zone_activation: await rewriteDnsArtifact(
            input.artifacts.dns_zone_activation,
            (document) => ({ ...document, dnssec_keyset_version: "key-tag-39280" }),
          ),
        },
      }),
    ],
    [
      "authority zone digest",
      (input) => ({
        ...input,
        authority_views: [
          { ...observedView("94.103.168.161"), zone_bytes_digest: "f".repeat(64) },
          { ...observedView("81.15.150.159"), zone_bytes_digest: "f".repeat(64) },
        ],
      }),
    ],
    [
      "app current generation",
      (input) => ({
        ...input,
        artifacts: {
          ...input.artifacts,
          app_host_activation: rewriteAppArtifact(input.artifacts.app_host_activation, {
            expected_activation_generation: 8,
          }),
        },
      }),
    ],
    [
      "app target status",
      (input) => ({
        ...input,
        artifacts: {
          ...input.artifacts,
          app_host_activation: rewriteAppArtifact(input.artifacts.app_host_activation, {
            target_status: "suspended",
          }),
        },
      }),
    ],
    [
      "app row identity",
      (input) => ({
        ...input,
        generation_snapshot: {
          ...input.generation_snapshot,
          app_host_activation_id: "app-host:elsewhere",
        },
      }),
    ],
    [
      "chain delegation digest",
      async (input) => ({
        ...input,
        artifacts: {
          ...input.artifacts,
          dns_zone_activation: await rewriteDnsArtifact(
            input.artifacts.dns_zone_activation,
            (document) => ({
              ...document,
              stable_chain_delegation_snapshot_digest: "f".repeat(64),
            }),
          ),
          health_observation: rewriteHealthArtifact(input.artifacts.health_observation, {
            stable_chain_delegation_snapshot_digest: "f".repeat(64),
          }),
        },
      }),
    ],
    ...(
      [
        ["health activation id", { dns_zone_activation_id: "dns-zone:elsewhere" }],
        ["health DNS generation", { activation_generation: 7 }],
        ["health prior generation", { expected_health_generation: 1 }],
        [
          "health delegation reference",
          { stable_chain_delegation_snapshot_reference: "delegation:elsewhere" },
        ],
        ["health delegation digest", { stable_chain_delegation_snapshot_digest: "f".repeat(64) }],
        ["health zone digest", { observed_zone_bytes_digest: "f".repeat(64) }],
        [
          "health keyset reference",
          { observed_dnssec_keyset_reference: "dnssec-keyset:elsewhere" },
        ],
        ["health keyset version", { observed_dnssec_keyset_version: "key-tag-39280" }],
        [
          "health gateway reference",
          { observed_gateway_deployment_reference: "gateway:elsewhere" },
        ],
        ["health gateway SPKI", { observed_gateway_certificate_spki_sha256: "f".repeat(64) }],
        ["health delegation gate", { delegation_matches: false }],
        ["health DS gate", { ds_authenticates_zone: false }],
        ["health retained-zone gate", { retained_zone_digest_matches: false }],
        ["health gateway gate", { gateway_healthy: false }],
      ] as const
    ).map(
      ([label, patch]) =>
        [
          label,
          (input: CandidatePreparationInput) => ({
            ...input,
            artifacts: {
              ...input.artifacts,
              health_observation: rewriteHealthArtifact(input.artifacts.health_observation, patch),
            },
          }),
        ] as const,
    ),
  ];

  for (const [label, mutate] of cases) {
    const input = await canonicalCandidateInput();
    await expect(
      prepareHnsAuthoritySuccessorCandidateV1(await mutate(input)),
      label,
    ).rejects.toMatchObject({ reason: "artifact_semantics_mismatch" });
  }
});

test("accepts the actual 172-byte jazleeuw Update 3 out-of-bailiwick resource shape", async () => {
  const resourceBytes = Uint8Array.from(jazleeuwUpdate3ResourceHex.match(/.{2}/gu) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
  expect(resourceBytes).toHaveLength(172);
  expect(chainAuthorityRecords.map((record) => record[0])).toEqual(["NS", "NS", "DS", "DS"]);
  await expect(
    prepareHnsAuthoritySuccessorCandidateV1(await canonicalCandidateInput()),
  ).resolves.toMatchObject({
    candidate: {
      chain_authority_records: chainAuthorityRecords,
      chain_ds: chainDs,
      dnskey_key_tag: 10875,
    },
  });
});

test("binds out-of-bailiwick chain NS names without inventing chain glue", async () => {
  const mutations = [
    chainAuthorityRecords.map((record) =>
      record[0] === "NS" && record[1] === "ns1.pirate" ? (["NS", "ns3.pirate"] as const) : record,
    ),
    [
      ...chainAuthorityRecords,
      ["GLUE4", "ns1.pirate", "94.103.168.161"] as const,
      ["GLUE4", "ns2.pirate", "81.15.150.159"] as const,
    ],
  ] as const;

  for (const chain_authority_records of mutations) {
    const input = await canonicalCandidateInput();
    const chainAuthorityDigest = await hnsChainAuthorityDigest({
      chain_network: "main",
      chain_genesis_block_hash: "6".repeat(64),
      root_label: "jazleeuw",
      ownership_source: "owner_authoritative_dns_txt",
      authority_records: chain_authority_records,
    });
    const observer = await decodeHnsAuthorityDetachedObserverEvidenceV1(
      input.artifacts.observer_evidence,
    );
    const observerEvidence = encoder.encode(
      JSON.stringify({
        ...observer,
        chain_authority_digest: chainAuthorityDigest,
      }),
    );
    const dnsZone = await rewriteDnsArtifact(input.artifacts.dns_zone_activation, (document) => ({
      ...document,
      stable_chain_delegation_snapshot_digest: chainAuthorityDigest,
    }));
    const health = rewriteHealthArtifact(input.artifacts.health_observation, {
      stable_chain_delegation_snapshot_digest: chainAuthorityDigest,
    });

    await expect(
      prepareHnsAuthoritySuccessorCandidateV1({
        ...input,
        chain_authority_records,
        artifacts: {
          ...input.artifacts,
          dns_zone_activation: dnsZone,
          health_observation: health,
          observer_evidence: observerEvidence,
        },
      }),
    ).rejects.toMatchObject({ reason: "artifact_semantics_mismatch" });
  }

  expect(() =>
    hnsChainAuthorityDigest({
      chain_network: "main",
      chain_genesis_block_hash: "6".repeat(64),
      root_label: "jazleeuw",
      ownership_source: "owner_authoritative_dns_txt",
      authority_records: [
        ["NS", "ns1.pirate."],
        ["NS", "ns2.pirate"],
        ["DS", ...chainDs[0]],
        ["DS", ...chainDs[1]],
      ],
    }),
  ).toThrow("Authority record is not canonical");
});

test("binds out-of-bailiwick addresses to the pirate chain anchor and secure parent views", async () => {
  const changedParentRecords = pirateChainAuthorityRecords.map((record) =>
    record[0] === "GLUE4" && record[1] === "ns1.pirate"
      ? (["GLUE4", "ns1.pirate", "203.0.113.53"] as const)
      : record,
  );
  const changedParentDigest = await hnsChainAuthorityDigest({
    chain_network: "main",
    chain_genesis_block_hash: "6".repeat(64),
    root_label: "pirate",
    ownership_source: "owner_authoritative_dns_txt",
    authority_records: changedParentRecords,
  });
  const mutations = [
    { ...authorityAddressProvenance, parent_zone: "elsewhere" },
    { ...authorityAddressProvenance, parent_chain_authority_digest: "f".repeat(64) },
    {
      ...authorityAddressProvenance,
      parent_chain_authority_digest: changedParentDigest,
      parent_chain_authority_records: changedParentRecords,
    },
    {
      ...authorityAddressProvenance,
      views: [
        { ...authorityAddressProvenance.views[0], outcome: "unavailable", records: null },
        authorityAddressProvenance.views[1],
      ],
    },
    {
      ...authorityAddressProvenance,
      views: [
        {
          ...authorityAddressProvenance.views[0],
          records: [["A", "ns1.pirate", "203.0.113.53"], authorityAddressRecords[1]],
        },
        authorityAddressProvenance.views[1],
      ],
    },
    {
      ...authorityAddressProvenance,
      views: [
        { ...authorityAddressProvenance.views[0], dnssec_validation: "bogus" },
        authorityAddressProvenance.views[1],
      ],
    },
    {
      ...authorityAddressProvenance,
      views: [
        {
          ...authorityAddressProvenance.views[0],
          vantage_reference: authorityAddressProvenance.views[1].vantage_reference,
        },
        authorityAddressProvenance.views[1],
      ],
    },
    { source_kind: "chain_glue_v1" },
  ] as const;

  for (const authority_address_provenance of mutations) {
    await expect(
      prepareHnsAuthoritySuccessorCandidateV1({
        ...(await canonicalCandidateInput()),
        authority_address_provenance,
      }),
    ).rejects.toMatchObject({ reason: "artifact_semantics_mismatch" });
  }
});

test("refuses pointer drift independently of candidate byte identity", () => {
  const bytes = new TextEncoder().encode("reviewed-6-10-1");
  expect(() =>
    requireReviewedHnsAuthorityCandidateV1({
      emitted_snapshot: emittedSnapshot,
      current_snapshot: { ...emittedSnapshot, dns_current_generation: 6 },
      reviewed_candidate_bytes: bytes,
      recomputed_candidate_bytes: bytes,
    }),
  ).toThrow("generation_fence_changed");
});

test("refuses exact DNS and app-host row drift even when generations coincide", () => {
  const bytes = new TextEncoder().encode("reviewed-6-10-1");
  for (const current_snapshot of [
    { ...emittedSnapshot, dns_zone_activation_id: "dns-zone:replacement" },
    { ...emittedSnapshot, app_host_activation_id: "app-host:replacement" },
  ]) {
    expect(() =>
      requireReviewedHnsAuthorityCandidateV1({
        emitted_snapshot: emittedSnapshot,
        current_snapshot,
        reviewed_candidate_bytes: bytes,
        recomputed_candidate_bytes: bytes,
      }),
    ).toThrow("generation_fence_changed");
  }
});

test("refuses altered reviewed bytes while generation pointers remain unchanged", () => {
  expect(() =>
    requireReviewedHnsAuthorityCandidateV1({
      emitted_snapshot: emittedSnapshot,
      current_snapshot: emittedSnapshot,
      reviewed_candidate_bytes: new TextEncoder().encode("reviewed-6-10-1"),
      recomputed_candidate_bytes: new TextEncoder().encode("changed-6-10-1"),
    }),
  ).toThrow("candidate_bytes_mismatch");
});

test("admits only unchanged pointers and byte-identical recomputation", () => {
  const bytes = new TextEncoder().encode("reviewed-6-10-1");
  expect(() =>
    requireReviewedHnsAuthorityCandidateV1({
      emitted_snapshot: emittedSnapshot,
      current_snapshot: emittedSnapshot,
      reviewed_candidate_bytes: bytes,
      recomputed_candidate_bytes: new Uint8Array(bytes),
    }),
  ).not.toThrow();
});

test("emits one canonical all-or-nothing 6/10/1 review package", async () => {
  const result = await prepareHnsAuthoritySuccessorCandidateV1({
    source_commit: "1".repeat(40),
    root_label: "jazleeuw",
    observed_at: "2026-08-29T17:00:00.000Z",
    chain_height: 344_448,
    expected_chain_network: "main",
    chain_authority_records: chainAuthorityRecords,
    authority_address_provenance: authorityAddressProvenance,
    generation_snapshot: emittedSnapshot,
    expected_authority_addresses: ["94.103.168.161", "81.15.150.159"],
    authority_views: [observedView("94.103.168.161"), observedView("81.15.150.159")],
    artifacts: await canonicalCandidateArtifacts(),
  });
  expect(result.candidate.generations).toEqual({
    dns_activation_generation: 6,
    app_host_activation_generation: 10,
    health_generation: 1,
  });
  expect(result.candidate.dnskey_key_tag).toBe(10875);
  expect(result.candidate.authority_views.map((view) => view.authority_address)).toEqual([
    "94.103.168.161",
    "81.15.150.159",
  ]);
  expect(result.candidate.artifacts).toHaveLength(5);
  expect(result.candidate_sha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(JSON.parse(new TextDecoder().decode(result.candidate_bytes))).toEqual(result.candidate);
});

test("refuses the entire package when any required artifact is empty", async () => {
  const artifacts = await canonicalCandidateArtifacts();
  await expect(
    prepareHnsAuthoritySuccessorCandidateV1({
      source_commit: "1".repeat(40),
      root_label: "jazleeuw",
      observed_at: "2026-08-29T17:00:00.000Z",
      chain_height: 344_448,
      expected_chain_network: "main",
      chain_authority_records: chainAuthorityRecords,
      authority_address_provenance: authorityAddressProvenance,
      generation_snapshot: emittedSnapshot,
      expected_authority_addresses: ["94.103.168.161", "81.15.150.159"],
      authority_views: [observedView("94.103.168.161"), observedView("81.15.150.159")],
      artifacts: {
        ...artifacts,
        app_host_activation: new Uint8Array(),
      },
    }),
  ).rejects.toThrow("incomplete_candidate_artifacts");
});

test("refuses canonical observer evidence that is not verified or bound to this root", async () => {
  const base = {
    source_commit: "1".repeat(40),
    root_label: "jazleeuw",
    observed_at: "2026-08-29T17:00:00.000Z",
    chain_height: 344_448,
    expected_chain_network: "main",
    chain_authority_records: chainAuthorityRecords,
    authority_address_provenance: authorityAddressProvenance,
    generation_snapshot: emittedSnapshot,
    expected_authority_addresses: ["94.103.168.161", "81.15.150.159"] as const,
    authority_views: [observedView("94.103.168.161"), observedView("81.15.150.159")],
  };
  const artifacts = await canonicalCandidateArtifacts();
  const unavailable = new TextEncoder().encode(
    '{"version":"pirate-hns-control-observation-result-v2","observation_id":"observer-custody-unavailable-01","request_sha256":"dda73915eef72c40ba3b5d4d105814bb0cf8a69ceda29f1a94f15bf9345786a0","status":"unavailable","reason_code":"authority_inventory_unavailable","retry_after_seconds":null,"observer_snapshot_sha256":"8cdf5aade56695d4cbdcf0f98cdb381d49bed92be927894f09985ac919d239a7","diagnostic_ref":"hns-observer:regtest:custody-unavailable-01"}',
  );
  await expect(
    prepareHnsAuthoritySuccessorCandidateV1({
      ...base,
      artifacts: { ...artifacts, observer_evidence: unavailable },
    }),
  ).rejects.toThrow("observer_evidence_not_verified");

  const mismatched = new TextEncoder().encode(
    new TextDecoder()
      .decode(artifacts.observer_evidence)
      .replace('"root_label":"jazleeuw"', '"root_label":"elsewhere"')
      .replace('"txt_name":"_pirate.jazleeuw"', '"txt_name":"_pirate.elsewhere"'),
  );
  await expect(
    prepareHnsAuthoritySuccessorCandidateV1({
      ...base,
      artifacts: { ...artifacts, observer_evidence: mismatched },
    }),
  ).rejects.toThrow("observer_evidence_mismatch");

  await expect(
    prepareHnsAuthoritySuccessorCandidateV1({ ...base, chain_height: 344_449, artifacts }),
  ).rejects.toThrow("observer_evidence_mismatch");

  await expect(
    prepareHnsAuthoritySuccessorCandidateV1({
      ...base,
      expected_chain_network: "regtest",
      artifacts,
    }),
  ).rejects.toThrow("observer_evidence_mismatch");

  const parentSource = new TextEncoder().encode(
    new TextDecoder()
      .decode(artifacts.observer_evidence)
      .replace(
        '"ownership_source":"owner_authoritative_dns_txt"',
        '"ownership_source":"hns_parent_chain_txt"',
      )
      .replace('"txt_name":"_pirate.jazleeuw"', '"txt_name":"jazleeuw"'),
  );
  await expect(
    prepareHnsAuthoritySuccessorCandidateV1({
      ...base,
      artifacts: { ...artifacts, observer_evidence: parentSource },
    }),
  ).rejects.toThrow("observer_evidence_not_verified");

  const observer = await decodeHnsAuthorityDetachedObserverEvidenceV1(artifacts.observer_evidence);
  const detachedVantageDrift = await encodeHnsAuthorityDetachedObserverEvidenceV1({
    ...observer,
    detached_transcript: detachedTranscript.map((entry, index) =>
      index === 3 ? { ...entry, vantage_reference: "deployment-vantage:unbound" } : entry,
    ),
  });
  await expect(
    prepareHnsAuthoritySuccessorCandidateV1({
      ...base,
      artifacts: { ...artifacts, observer_evidence: detachedVantageDrift },
    }),
  ).rejects.toThrow("observer_evidence_mismatch");

  const futureAnchor = new TextEncoder().encode(
    new TextDecoder()
      .decode(artifacts.observer_evidence)
      .replace('"chain_anchor_median_time":1777689600', '"chain_anchor_median_time":1800000000'),
  );
  await expect(
    prepareHnsAuthoritySuccessorCandidateV1({
      ...base,
      artifacts: { ...artifacts, observer_evidence: futureAnchor },
    }),
  ).rejects.toThrow("artifact_semantics_mismatch");
});

test("binds chain DS through candidate preparation and ignores only record ordering", async () => {
  const input = await canonicalCandidateInput();
  await expect(
    prepareHnsAuthoritySuccessorCandidateV1({
      ...input,
      chain_authority_records: [...input.chain_authority_records].reverse(),
      authority_views: [
        { ...observedView("94.103.168.161"), derived_ds: [...chainDs].reverse() },
        { ...observedView("81.15.150.159"), derived_ds: [...chainDs].reverse() },
      ],
    }),
  ).resolves.toMatchObject({ candidate: { chain_ds: chainDs } });

  const mismatchedDs = [[39280, 13, 2, "d".repeat(64)]] as const;
  await expect(
    prepareHnsAuthoritySuccessorCandidateV1({
      ...input,
      authority_views: [
        { ...observedView("94.103.168.161"), derived_ds: mismatchedDs },
        { ...observedView("81.15.150.159"), derived_ds: mismatchedDs },
      ],
    }),
  ).rejects.toThrow("dnskey_ds_mismatch");

  await expect(
    prepareHnsAuthoritySuccessorCandidateV1({
      ...input,
      chain_authority_records: input.chain_authority_records.map((record) =>
        record[0] === "DS" && record[3] === 2
          ? (["DS", record[1], record[2], record[3], "f".repeat(64)] as const)
          : record,
      ),
    }),
  ).rejects.toThrow("observer_evidence_mismatch");
});

test("refuses a DNS persistence artifact whose reviewed zone bytes do not match its digest", async () => {
  const artifacts = await canonicalCandidateArtifacts();
  const document = new TextDecoder().decode(artifacts.dns_zone_activation);
  const tampered = new TextEncoder().encode(
    document.replace('"zone_bytes_hex":"24', '"zone_bytes_hex":"25'),
  );
  await expect(
    prepareHnsAuthoritySuccessorCandidateV1({
      source_commit: "1".repeat(40),
      root_label: "jazleeuw",
      observed_at: "2026-08-29T17:00:00.000Z",
      chain_height: 344_448,
      expected_chain_network: "main",
      chain_authority_records: chainAuthorityRecords,
      authority_address_provenance: authorityAddressProvenance,
      generation_snapshot: emittedSnapshot,
      expected_authority_addresses: ["94.103.168.161", "81.15.150.159"],
      authority_views: [observedView("94.103.168.161"), observedView("81.15.150.159")],
      artifacts: { ...artifacts, dns_zone_activation: tampered },
    }),
  ).rejects.toThrow("internally inconsistent");
});

test("round-trips every app-host and health commit parameter through reviewed bytes", () => {
  const app = {
    operation_id: "app-operation-10",
    idempotency_key: "app-key-10",
    request_hash: "a".repeat(64),
    app_host_activation_id: "hns-rehearsal-app-host-v1",
    expected_activation_generation: 9,
    target_status: "active",
    reason_code: "canonical-authority",
  } as const;
  const health = {
    operation_id: "health-operation-1",
    idempotency_key: "health-key-1",
    request_hash: "b".repeat(64),
    dns_zone_activation_id: "hns-rehearsal-dns-zone-v1",
    activation_generation: 6,
    expected_health_generation: 0,
    stable_chain_delegation_snapshot_reference: "delegation:jazleeuw:344448",
    stable_chain_delegation_snapshot_digest: "c".repeat(64),
    observed_zone_bytes_digest: "d".repeat(64),
    observed_dnssec_keyset_reference: "dnssec-keyset:jazleeuw",
    observed_dnssec_keyset_version: "key-tag-10875",
    observed_gateway_deployment_reference: "gateway:jazleeuw",
    observed_gateway_certificate_spki_sha256: "e".repeat(64),
    delegation_matches: true,
    ds_authenticates_zone: true,
    retained_zone_digest_matches: true,
    gateway_healthy: true,
    valid_for_seconds: 3600,
  } as const;
  expect(decodeHnsAppHostTransitionDocumentV1(encodeHnsAppHostTransitionDocumentV1(app))).toEqual(
    app,
  );
  expect(decodeHnsDnsHealthDocumentV1(encodeHnsDnsHealthDocumentV1(health))).toEqual(health);
});

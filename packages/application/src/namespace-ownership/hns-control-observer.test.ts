import { describe, expect, test } from "bun:test";
import {
  decodeHnsControlObservationRequestBytes,
  decodeHnsControlObservationResultBytes,
  deriveHnsEvidenceLease,
  hnsChainAuthorityDigest,
  hnsChainAuthorityPreimage,
  hnsControlIdentityDigest,
  hnsObservedTxtValuesDigest,
  mapHnsControlObservationToTargetV2,
} from "./hns-control-observer.ts";
import { sha256Utf8 } from "./hns-evidence.ts";

const encoder = new TextEncoder();
const configurationDigest = "1".repeat(64);
const chainGenesis = "2".repeat(64);
const chainAnchor = "3".repeat(64);

const requestValues = {
  parent: {
    version: "pirate-hns-control-observation-request-v1",
    observation_id: "observer-01",
    provider_id: "hns.owner.v1",
    provider_configuration_reference: "hns-observer-regtest",
    provider_configuration_version: "hns-observer-config-v1",
    provider_configuration_digest: configurationDigest,
    environment: "test",
    ownership_source: "hns_parent_chain_txt",
    root_label: "jazleeuw",
    txt_name: "jazleeuw",
    expected_txt_value: "pirate-verification=nvs_01",
  },
  owner: {
    version: "pirate-hns-control-observation-request-v1",
    observation_id: "observer-02",
    provider_id: "hns.owner.v1",
    provider_configuration_reference: "hns-observer-regtest",
    provider_configuration_version: "hns-observer-config-v1",
    provider_configuration_digest: configurationDigest,
    environment: "test",
    ownership_source: "owner_authoritative_dns_txt",
    root_label: "jazleeuw",
    txt_name: "_pirate.jazleeuw",
    expected_txt_value: "pirate-verification=nvs_01",
  },
  mismatch: {
    version: "pirate-hns-control-observation-request-v1",
    observation_id: "observer-03",
    provider_id: "hns.owner.v1",
    provider_configuration_reference: "hns-observer-regtest",
    provider_configuration_version: "hns-observer-config-v1",
    provider_configuration_digest: configurationDigest,
    environment: "test",
    ownership_source: "owner_authoritative_dns_txt",
    root_label: "jazleeuw",
    txt_name: "_pirate.jazleeuw",
    expected_txt_value: "pirate-verification=nvs_01",
  },
  stale: {
    version: "pirate-hns-control-observation-request-v1",
    observation_id: "observer-04",
    provider_id: "hns.owner.v1",
    provider_configuration_reference: "hns-observer-regtest",
    provider_configuration_version: "hns-observer-config-v1",
    provider_configuration_digest: configurationDigest,
    environment: "test",
    ownership_source: "hns_parent_chain_txt",
    root_label: "jazleeuw",
    txt_name: "jazleeuw",
    expected_txt_value: "pirate-verification=nvs_01",
  },
} as const;

const resultValues = {
  parent: {
    version: "pirate-hns-control-observation-result-v1",
    observation_id: "observer-01",
    request_sha256: "efe525e386d8409d9e21d378b655d840a78787fbe15bb06738b082ad748a8cfe",
    status: "verified",
    provider_id: "hns.owner.v1",
    provider_configuration_reference: "hns-observer-regtest",
    provider_configuration_version: "hns-observer-config-v1",
    provider_configuration_digest: configurationDigest,
    environment: "test",
    ownership_source: "hns_parent_chain_txt",
    root_label: "jazleeuw",
    txt_name: "jazleeuw",
    expected_txt_value_sha256: "262aeaa5c81725c9dc9b4e1238b08044a8d2bb92c1dc62069d6109bd20e8da73",
    control_identity_digest: "bad01043ba07ebaceef26497266b269d966c72f8f0b14bac44c9b7d44922f236",
    chain_authority_digest: "6c176a02ca14aedd62328e805389409a1f4b520b97bb90c2e7f90b47d43557d6",
    root_exists: true,
    root_control_verified: true,
    expiry_horizon_sufficient: true,
    chain_network: "regtest",
    chain_genesis_block_hash: chainGenesis,
    chain_anchor_height: 123456,
    chain_anchor_block_hash: chainAnchor,
    chain_anchor_median_time: 1769999900,
    expiry_height: 200000,
    provider_evidence_ref: "hns-observer:regtest:01",
  },
  owner: {
    version: "pirate-hns-control-observation-result-v1",
    observation_id: "observer-02",
    request_sha256: "46e8ae1bfafe0ce765ca2e47b3859deb5f52c9310afa8cafa3c9631a11910f8f",
    status: "verified",
    provider_id: "hns.owner.v1",
    provider_configuration_reference: "hns-observer-regtest",
    provider_configuration_version: "hns-observer-config-v1",
    provider_configuration_digest: configurationDigest,
    environment: "test",
    ownership_source: "owner_authoritative_dns_txt",
    root_label: "jazleeuw",
    txt_name: "_pirate.jazleeuw",
    expected_txt_value_sha256: "262aeaa5c81725c9dc9b4e1238b08044a8d2bb92c1dc62069d6109bd20e8da73",
    control_identity_digest: "75f7c61176c1d28d0d029d787b829991738633ce00d194a94db362e7e5894779",
    chain_authority_digest: "4c0edac62ed6d0c31eb92f873273846187b0c97ab2608e469cba4f8791619d72",
    root_exists: true,
    root_control_verified: true,
    expiry_horizon_sufficient: true,
    chain_network: "regtest",
    chain_genesis_block_hash: chainGenesis,
    chain_anchor_height: 123456,
    chain_anchor_block_hash: chainAnchor,
    chain_anchor_median_time: 1769999900,
    expiry_height: 200000,
    provider_evidence_ref: "hns-observer:regtest:02",
  },
  mismatch: {
    version: "pirate-hns-control-observation-result-v1",
    observation_id: "observer-03",
    request_sha256: "3cd6e1d0b9e25c4ac4422f4cc8f1bb63db1ab497a20c4dd3d787e2e896755376",
    status: "rejected",
    reason_code: "txt_value_mismatch",
    provider_id: "hns.owner.v1",
    provider_configuration_reference: "hns-observer-regtest",
    provider_configuration_version: "hns-observer-config-v1",
    provider_configuration_digest: configurationDigest,
    environment: "test",
    ownership_source: "owner_authoritative_dns_txt",
    root_label: "jazleeuw",
    txt_name: "_pirate.jazleeuw",
    expected_txt_value_sha256: "262aeaa5c81725c9dc9b4e1238b08044a8d2bb92c1dc62069d6109bd20e8da73",
    observed_txt_values_digest: "9fad611cfe57fd59c5e8625055cad714f1d2711a7894e8f14cf941050af2aad4",
    chain_authority_digest: "4c0edac62ed6d0c31eb92f873273846187b0c97ab2608e469cba4f8791619d72",
    chain_network: "regtest",
    chain_genesis_block_hash: chainGenesis,
    chain_anchor_height: 123456,
    chain_anchor_block_hash: chainAnchor,
    chain_anchor_median_time: 1769999900,
    expiry_height: 200000,
    provider_evidence_ref: "hns-observer:regtest:03",
  },
  stale: {
    version: "pirate-hns-control-observation-result-v1",
    observation_id: "observer-04",
    request_sha256: "4d90e2530eaa9f00b249ceae9b090f103e27deacd96b622b9ce3d504d98b04a5",
    status: "unavailable",
    reason_code: "chain_view_stale",
    retry_after_seconds: 60,
    diagnostic_ref: "hns-observer-diagnostic:regtest:04",
  },
} as const;

const expectedRequests = [489, 504, 504, 489];
const expectedRequestHashes = [
  "efe525e386d8409d9e21d378b655d840a78787fbe15bb06738b082ad748a8cfe",
  "46e8ae1bfafe0ce765ca2e47b3859deb5f52c9310afa8cafa3c9631a11910f8f",
  "3cd6e1d0b9e25c4ac4422f4cc8f1bb63db1ab497a20c4dd3d787e2e896755376",
  "4d90e2530eaa9f00b249ceae9b090f103e27deacd96b622b9ce3d504d98b04a5",
];
const expectedResults = [1256, 1271, 1228, 304];
const expectedResultHashes = [
  "7d531a8cbb5f778c7394dc734ba61790d34872373f8dcf3b98e46d1187cead5e",
  "d7072a5d9ef696a60995a522943f363c688fa3ee633f661330ea3c9d23b07c5b",
  "8f886c835cae6837f99209bb11f0623b4d15025c753e8f77d5feec1663c6ba4c",
  "4f7e317674b4b92c063e44f4b5ab4e2b01379fc00d7680441215c0f4eb01c6cc",
];

function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function expectedAt<T>(values: ReadonlyArray<T>, index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing expected vector value ${index}`);
  return value;
}

describe("HNS target control observer kernel", () => {
  test("reproduces all four strict request/result vectors", async () => {
    const names = ["parent", "owner", "mismatch", "stale"] as const;
    for (const [index, name] of names.entries()) {
      const requestBytes = bytes(requestValues[name]);
      const request = await decodeHnsControlObservationRequestBytes(requestBytes);
      expect(requestBytes.byteLength).toBe(expectedAt(expectedRequests, index));
      expect(request.request_sha256).toBe(expectedAt(expectedRequestHashes, index));
      expect(request.request).toEqual(requestValues[name]);

      const resultBytes = bytes(resultValues[name]);
      const result = await decodeHnsControlObservationResultBytes(resultBytes, request.request);
      expect(resultBytes.byteLength).toBe(expectedAt(expectedResults, index));
      expect(result.result_sha256).toBe(expectedAt(expectedResultHashes, index));
      expect(result.result).toEqual(resultValues[name]);
    }
  });

  test("reproduces authority, control identity, TXT mismatch, and chunk digests", async () => {
    const parentAuthority = {
      chain_network: "regtest",
      chain_genesis_block_hash: chainGenesis,
      root_label: "jazleeuw",
      ownership_source: "hns_parent_chain_txt" as const,
      authority_records: [],
    };
    const ownerAuthority = {
      chain_network: "regtest",
      chain_genesis_block_hash: chainGenesis,
      root_label: "jazleeuw",
      ownership_source: "owner_authoritative_dns_txt" as const,
      authority_records: [
        ["NS", "ns1.jazleeuw"],
        ["GLUE4", "ns1.jazleeuw", "192.0.2.53"],
        ["DS", 12345, 13, 2, "4".repeat(64)],
      ] as const,
    };
    expect(hnsChainAuthorityPreimage(parentAuthority)).toBe(
      '["pirate-hns-chain-authority-v1","regtest","2222222222222222222222222222222222222222222222222222222222222222","jazleeuw","hns_parent_chain_txt",[]]',
    );
    await expect(hnsChainAuthorityDigest(parentAuthority)).resolves.toBe(
      "6c176a02ca14aedd62328e805389409a1f4b520b97bb90c2e7f90b47d43557d6",
    );
    await expect(hnsChainAuthorityDigest(ownerAuthority)).resolves.toBe(
      "4c0edac62ed6d0c31eb92f873273846187b0c97ab2608e469cba4f8791619d72",
    );
    await expect(
      hnsControlIdentityDigest({
        ownership_source: "hns_parent_chain_txt",
        txt_name: "jazleeuw",
        expected_txt_value: "pirate-verification=nvs_01",
        root_label: "jazleeuw",
        chain_authority_digest: "6c176a02ca14aedd62328e805389409a1f4b520b97bb90c2e7f90b47d43557d6",
      }),
    ).resolves.toBe("bad01043ba07ebaceef26497266b269d966c72f8f0b14bac44c9b7d44922f236");
    await expect(
      hnsControlIdentityDigest({
        ownership_source: "owner_authoritative_dns_txt",
        txt_name: "_pirate.jazleeuw",
        expected_txt_value: "pirate-verification=nvs_01",
        root_label: "jazleeuw",
        chain_authority_digest: "4c0edac62ed6d0c31eb92f873273846187b0c97ab2608e469cba4f8791619d72",
      }),
    ).resolves.toBe("75f7c61176c1d28d0d029d787b829991738633ce00d194a94db362e7e5894779");
    await expect(
      hnsObservedTxtValuesDigest([{ chunks: ["pirate-verification=", "nvs_01"] }]),
    ).resolves.toBe("c95f975f2d990aae7433c40288c95f5fae2115990a57b2497f3fa8b9550f26bc");
    await expect(
      hnsObservedTxtValuesDigest([{ chunks: ["pirate-verification=wrong"] }]),
    ).resolves.toBe("9fad611cfe57fd59c5e8625055cad714f1d2711a7894e8f14cf941050af2aad4");
    await expect(hnsObservedTxtValuesDigest([])).resolves.toBeNull();
  });

  test("rejects BOM, duplicate/unknown/reordered members, and alternate numbers", async () => {
    const request = JSON.stringify(requestValues.parent);
    await expect(
      decodeHnsControlObservationRequestBytes(
        new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(request)]),
      ),
    ).rejects.toThrow();
    await expect(
      decodeHnsControlObservationRequestBytes(
        encoder.encode(
          request.replace(
            '"observation_id":"observer-01"',
            '"unknown":1,"observation_id":"observer-01"',
          ),
        ),
      ),
    ).rejects.toThrow();
    await expect(
      decodeHnsControlObservationRequestBytes(
        encoder.encode(
          request.replace(
            '"observation_id":"observer-01"',
            '"observation_id":"observer-01","observation_id":"again"',
          ),
        ),
      ),
    ).rejects.toThrow();
    await expect(
      decodeHnsControlObservationRequestBytes(
        encoder.encode(
          request.replace(
            '"version":"pirate-hns-control-observation-request-v1","observation_id"',
            '"observation_id":"observer-01","version"',
          ),
        ),
      ),
    ).rejects.toThrow();
    const result = JSON.stringify(resultValues.parent).replace("123456", "123456.0");
    await expect(decodeHnsControlObservationResultBytes(encoder.encode(result))).rejects.toThrow();
    await expect(
      decodeHnsControlObservationRequestBytes(
        encoder.encode(JSON.stringify({ ...requestValues.parent, txt_name: "_pirate.jazleeuw" })),
      ),
    ).rejects.toThrow();
  });

  test("cross-pins result bytes and rejects tampering and source crossover", async () => {
    const request = await decodeHnsControlObservationRequestBytes(bytes(requestValues.parent));
    const resultBytes = bytes(resultValues.parent);
    const result = await decodeHnsControlObservationResultBytes(resultBytes, request.request);
    expect(result.result_sha256).toBe(expectedAt(expectedResultHashes, 0));
    const tampered = JSON.parse(new TextDecoder().decode(resultBytes)) as Record<string, unknown>;
    tampered.chain_anchor_height = 123457;
    const tamperedResult = await decodeHnsControlObservationResultBytes(
      bytes(tampered),
      request.request,
    );
    expect(tamperedResult.result_sha256).not.toBe(result.result_sha256);
    const wrongRequest = { ...request.request, expected_txt_value: "pirate-verification=other" };
    await expect(
      decodeHnsControlObservationResultBytes(resultBytes, wrongRequest),
    ).rejects.toThrow();
    await expect(
      decodeHnsControlObservationResultBytes(
        bytes({ ...resultValues.parent, ownership_source: "owner_authoritative_dns_txt" }),
      ),
    ).rejects.toThrow();
    await expect(
      decodeHnsControlObservationResultBytes(
        bytes({ ...resultValues.parent, expected_txt_value_sha256: "0".repeat(64) }),
        request.request,
      ),
    ).rejects.toThrow("TXT value hash");
    await expect(
      decodeHnsControlObservationResultBytes(
        bytes({ ...resultValues.parent, control_identity_digest: "0".repeat(64) }),
        request.request,
      ),
    ).rejects.toThrow("control identity");
    await expect(
      decodeHnsControlObservationResultBytes(
        bytes({ ...resultValues.stale, retry_after_seconds: 3_601 }),
      ),
    ).rejects.toThrow();
  });

  test("enforces rejection reason fact invariants", async () => {
    const invalidResults = [
      {
        ...resultValues.mismatch,
        reason_code: "root_absent",
        expiry_height: null,
      },
      {
        ...resultValues.mismatch,
        reason_code: "root_inactive",
      },
      {
        ...resultValues.mismatch,
        reason_code: "txt_absent",
        observed_txt_values_digest: null,
        expiry_height: null,
      },
      {
        ...resultValues.mismatch,
        observed_txt_values_digest: null,
      },
      {
        ...resultValues.mismatch,
        reason_code: "expiry_horizon_insufficient",
        expiry_height: null,
      },
    ] as const;
    for (const result of invalidResults) {
      await expect(decodeHnsControlObservationResultBytes(bytes(result))).rejects.toThrow(
        "rejection facts",
      );
    }
  });

  test("rejects non-scalar TXT chunks before hashing", () => {
    expect(() => hnsObservedTxtValuesDigest([{ chunks: ["\ud800"] }])).toThrow("bounded UTF-8");
  });

  test("maps verified to the exact 1117-byte target-v2 vector", async () => {
    const request = await decodeHnsControlObservationRequestBytes(bytes(requestValues.parent));
    const result = await decodeHnsControlObservationResultBytes(
      bytes(resultValues.parent),
      request.request,
    );
    const mapped = await mapHnsControlObservationToTargetV2({
      request: request.request,
      result_bytes: result.result_bytes,
      upstream_session_ref: "nvs_01",
      policy: {
        expected_block_interval_seconds: 600,
        expiry_safety_blocks: 144,
        evidence_lease_seconds: 2_592_000,
      },
    });
    const mappedBytes = encoder.encode(JSON.stringify(mapped));
    expect(mappedBytes.byteLength).toBe(1117);
    await expect(sha256Utf8(new TextDecoder().decode(mappedBytes))).resolves.toBe(
      "a07b4220cca64e7496c353f9ce5c14eb3645ae8dc9fdf3546df7016c0042702f",
    );
    expect(new TextDecoder().decode(mappedBytes)).toContain(
      "hns-observer-v1:sha256:7d531a8cbb5f778c7394dc734ba61790d34872373f8dcf3b98e46d1187cead5e:hns-observer:regtest:01",
    );
  });

  test("keeps unavailable infrastructure uncertainty out of negative mapping", async () => {
    const request = await decodeHnsControlObservationRequestBytes(bytes(requestValues.stale));
    const result = await decodeHnsControlObservationResultBytes(
      bytes(resultValues.stale),
      request.request,
    );
    const mapped = await mapHnsControlObservationToTargetV2({
      request: request.request,
      result_bytes: result.result_bytes,
      upstream_session_ref: "nvs_01",
      policy: {
        expected_block_interval_seconds: 600,
        expiry_safety_blocks: 144,
        evidence_lease_seconds: 2_592_000,
      },
    });
    expect(mapped).toEqual({
      status: "unavailable",
      observation_contract_version: "pirate-hns-target-observation-v2",
      reason_code: "chain_view_stale",
      retry_after_seconds: 60,
      diagnostic_ref: "hns-observer-diagnostic:regtest:04",
    });
    expect(mapped.status).not.toBe("rejected");
  });

  test("maps authenticated TXT and root outcomes to the closed target union", async () => {
    const request = await decodeHnsControlObservationRequestBytes(bytes(requestValues.mismatch));
    const pendingResult = await decodeHnsControlObservationResultBytes(
      bytes(resultValues.mismatch),
      request.request,
    );
    const pending = await mapHnsControlObservationToTargetV2({
      request: request.request,
      result_bytes: pendingResult.result_bytes,
      upstream_session_ref: "nvs_01",
      policy: {
        expected_block_interval_seconds: 600,
        expiry_safety_blocks: 144,
        evidence_lease_seconds: 2_592_000,
      },
    });
    expect(pending.status).toBe("pending");
    expect(pending).toMatchObject({ reason_code: "txt_value_mismatch" });

    const rejectedBody = {
      ...resultValues.mismatch,
      reason_code: "root_absent",
      observed_txt_values_digest: null,
      expiry_height: null,
      provider_evidence_ref: "hns-observer:regtest:root-absent",
    } as const;
    const rejectedResult = await decodeHnsControlObservationResultBytes(
      bytes(rejectedBody),
      request.request,
    );
    const rejected = await mapHnsControlObservationToTargetV2({
      request: request.request,
      result_bytes: rejectedResult.result_bytes,
      upstream_session_ref: "nvs_01",
      policy: {
        expected_block_interval_seconds: 600,
        expiry_safety_blocks: 144,
        evidence_lease_seconds: 2_592_000,
      },
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected).toMatchObject({ reason_code: "root_absent" });
  });

  test("derives the evidence lease solely from chain median time", () => {
    const originalNow = Date.now;
    Date.now = () => {
      throw new Error("Worker clock must not be consulted");
    };
    try {
      expect(
        deriveHnsEvidenceLease(
          {
            chain_anchor_median_time: 1769999900,
            chain_anchor_height: 123456,
            expiry_height: 200000,
          },
          {
            expected_block_interval_seconds: 600,
            expiry_safety_blocks: 144,
            evidence_lease_seconds: 2_592_000,
          },
        ),
      ).toEqual({
        safe_remaining_blocks: 76400,
        observed_at: "2026-02-02T02:38:20.000Z",
        expires_at: "2026-03-04T02:38:20.000Z",
      });
      expect(
        deriveHnsEvidenceLease(
          {
            chain_anchor_median_time: 9_000_000_000,
            chain_anchor_height: 100,
            expiry_height: 1_000,
          },
          {
            expected_block_interval_seconds: 600,
            expiry_safety_blocks: 1,
            evidence_lease_seconds: 1_000,
          },
        ).observed_at,
      ).toStartWith("2255-");
      expect(() =>
        deriveHnsEvidenceLease(
          {
            chain_anchor_median_time: 8_640_000_000_001,
            chain_anchor_height: 100,
            expiry_height: 1_000,
          },
          {
            expected_block_interval_seconds: 1,
            expiry_safety_blocks: 1,
            evidence_lease_seconds: 100,
          },
        ),
      ).toThrow("not representable");
    } finally {
      Date.now = originalNow;
    }
  });
});

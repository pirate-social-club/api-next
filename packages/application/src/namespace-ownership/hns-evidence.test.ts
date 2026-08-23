import { describe, expect, test } from "bun:test";
import {
  buildHnsOwnershipEvidence,
  decodeHnsOwnerResponseBytes,
  HNS_OWNER_MAX_RESPONSE_BYTES,
  HNS_OWNER_PROVIDER_ID,
  type HnsNamespaceStartInput,
  HnsOwnerResponseDecodeError,
  type HnsOwnershipEvidenceInput,
  type HnsOwnershipEvidencePreimageInput,
  hnsNamespaceStartHash,
  hnsNamespaceStartPreimage,
  hnsOwnerChallengeValue,
  hnsOwnerChallengeValueSha256,
  hnsOwnershipEvidencePreimage,
  hnsProviderIdentityDigest,
  hnsProviderIdentityPreimage,
  sha256Utf8,
} from "./hns-evidence.ts";

const route = {
  family: "hns" as const,
  root_label: "xn--pokmon-dva",
  root_label_display: "pokémon",
  path_segment: "app.xn--pokmon-dva",
  href: "/c/app.xn--pokmon-dva",
  app_host: null,
};

const start: HnsNamespaceStartInput = {
  actor_id: "user-1",
  creation_intent_id: "cc_intent-1",
  ceremony_intent_id: "cc_ceremony-1",
  requirement_hash: "1".repeat(64),
  generation: 1,
  provider_id: HNS_OWNER_PROVIDER_ID,
  provider_binding_hash: "3".repeat(64),
  provider_configuration: {
    kind: "managed",
    reference: "hns-owner-staging",
    version: "hns-owner-config-v1",
  },
  protocol_version: "hns-txt-v1",
  environment: "staging",
  route,
};

const evidenceVector: HnsOwnershipEvidencePreimageInput = {
  ...start,
  request_hash: "fb286725356ad30357e50929744ec35fe66f655fe28f551a8f1ea7ad4959c0a0",
  upstream_session_ref: "nvs_01",
  ownership_source: "owner_authoritative_dns_txt",
  challenge_name: "_pirate.xn--pokmon-dva",
  root_exists: true,
  root_control_verified: true,
  expiry_horizon_sufficient: true,
  chain_network: "regtest",
  chain_anchor_height: 123456,
  chain_anchor_block_hash: "5".repeat(64),
  chain_anchor_median_time: 1769999900,
  expiry_height: 200000,
  observed_at: "2026-02-02T00:00:00.000Z",
  expires_at: "2026-03-04T00:00:00.000Z",
  evidence_ref: "hns_evidence_01",
  provider_evidence_ref: "legacy-obs-01",
  observation_sha256: "6".repeat(64),
  provider_identity_digest: "21d53c5e1d466e65cfa1a2997ddf307640592743472df15feb64d4084b5396ff",
  challenge_value_sha256: "262aeaa5c81725c9dc9b4e1238b08044a8d2bb92c1dc62069d6109bd20e8da73",
};

function verifiedResponseBytes(overrides: Readonly<Record<string, unknown>> = {}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      status: "verified",
      provider_evidence_ref: "legacy-obs-01",
      upstream_session_ref: "nvs_01",
      ownership_source: "owner_authoritative_dns_txt",
      challenge_name: "_pirate.xn--pokmon-dva",
      challenge_value: hnsOwnerChallengeValue("nvs_01"),
      root_exists: true,
      root_control_verified: true,
      expiry_horizon_sufficient: true,
      chain_network: "regtest",
      chain_anchor_height: 123456,
      chain_anchor_block_hash: "5".repeat(64),
      chain_anchor_median_time: 1769999900,
      expiry_height: 200000,
      observed_at: "2026-02-02T00:00:00.000Z",
      expires_at: "2026-03-04T00:00:00.000Z",
      ...overrides,
    }),
  );
}

function evidenceInput(
  overrides: Partial<HnsOwnershipEvidenceInput> = {},
): HnsOwnershipEvidenceInput {
  return {
    ...start,
    request_hash: "fb286725356ad30357e50929744ec35fe66f655fe28f551a8f1ea7ad4959c0a0",
    upstream_session_ref: "nvs_01",
    evidence_ref: "hns_evidence_01",
    raw_response_bytes: verifiedResponseBytes(),
    ...overrides,
  };
}

describe("HNS ownership evidence ABI", () => {
  test("reproduces the ratified provider identity, start, and evidence vectors", async () => {
    expect(
      hnsProviderIdentityPreimage({
        provider_id: HNS_OWNER_PROVIDER_ID,
        provider_configuration_kind: "managed",
        provider_configuration_reference: "hns-owner-staging",
        provider_configuration_version: "hns-owner-config-v1",
        protocol_version: "hns-txt-v1",
        root_label: "xn--pokmon-dva",
      }),
    ).toBe(
      '["pirate-hns-provider-identity-v1","hns.owner.v1","managed","hns-owner-staging","hns-owner-config-v1","hns-txt-v1","hns","xn--pokmon-dva"]',
    );
    await expect(
      hnsProviderIdentityDigest({
        provider_id: HNS_OWNER_PROVIDER_ID,
        provider_configuration_kind: "managed",
        provider_configuration_reference: "hns-owner-staging",
        provider_configuration_version: "hns-owner-config-v1",
        protocol_version: "hns-txt-v1",
        root_label: "xn--pokmon-dva",
      }),
    ).resolves.toBe("21d53c5e1d466e65cfa1a2997ddf307640592743472df15feb64d4084b5396ff");
    expect(hnsNamespaceStartPreimage(start)).toBe(
      '["pirate-namespace-start-v1","user-1","cc_intent-1","cc_ceremony-1","namespace_ownership","1111111111111111111111111111111111111111111111111111111111111111",1,"hns.owner.v1","3333333333333333333333333333333333333333333333333333333333333333","managed","hns-owner-staging","hns-owner-config-v1","hns-txt-v1","staging","hns","xn--pokmon-dva","pokémon","app.xn--pokmon-dva"]',
    );
    await expect(hnsNamespaceStartHash(start)).resolves.toBe(
      "fb286725356ad30357e50929744ec35fe66f655fe28f551a8f1ea7ad4959c0a0",
    );
    await expect(hnsOwnerChallengeValueSha256("nvs_01")).resolves.toBe(
      "262aeaa5c81725c9dc9b4e1238b08044a8d2bb92c1dc62069d6109bd20e8da73",
    );
    const evidencePreimage = hnsOwnershipEvidencePreimage(evidenceVector);
    expect(evidencePreimage).toContain('"hns_evidence_01","legacy-obs-01"');
    await expect(sha256Utf8(evidencePreimage)).resolves.toBe(
      "faa2d10678673c9550eac18a5551a127bb84aba093d80bb784754d9a9840cd5a",
    );
  });

  test("strict-decodes the same bytes and preserves them exactly", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        status: "verified",
        provider_evidence_ref: "obs-1",
        upstream_session_ref: "nvs_01",
        ownership_source: "owner_authoritative_dns_txt",
        challenge_name: "_pirate.xn--pokmon-dva",
        challenge_value: hnsOwnerChallengeValue("nvs_01"),
        root_exists: true,
        root_control_verified: true,
        expiry_horizon_sufficient: true,
        chain_network: "regtest",
        chain_anchor_height: 123456,
        chain_anchor_block_hash: "5".repeat(64),
        chain_anchor_median_time: 1769999900,
        expiry_height: 200000,
        observed_at: "2026-02-02T00:00:00.000Z",
        expires_at: "2026-03-04T00:00:00.000Z",
      }),
    );
    const decoded = decodeHnsOwnerResponseBytes(bytes);
    expect(decoded.response_bytes).toEqual(bytes);
    expect(decoded.response).toMatchObject({ provider_evidence_ref: "obs-1" });
    expect(() =>
      decodeHnsOwnerResponseBytes(
        new TextEncoder().encode(`${new TextDecoder().decode(bytes).slice(0, -1)},"extra":1}`),
      ),
    ).toThrow(HnsOwnerResponseDecodeError);
    expect(() => decodeHnsOwnerResponseBytes(new Uint8Array([0xc3, 0x28]))).toThrow(
      HnsOwnerResponseDecodeError,
    );
    expect(() =>
      decodeHnsOwnerResponseBytes(new Uint8Array(HNS_OWNER_MAX_RESPONSE_BYTES + 1)),
    ).toThrow(HnsOwnerResponseDecodeError);
    expect(() => decodeHnsOwnerResponseBytes(new Uint8Array())).toThrow(
      HnsOwnerResponseDecodeError,
    );

    const pending = '{"status":"pending"}';
    const exactMaximum = new TextEncoder().encode(
      `${pending}${" ".repeat(HNS_OWNER_MAX_RESPONSE_BYTES - pending.length)}`,
    );
    expect(exactMaximum.byteLength).toBe(HNS_OWNER_MAX_RESPONSE_BYTES);
    expect(() => decodeHnsOwnerResponseBytes(exactMaximum)).toThrow(HnsOwnerResponseDecodeError);
  });

  test("accepts strict target-v2 creation evidence and cross-pins its control authority", async () => {
    const observerResultSha256 = "a".repeat(64);
    const chainAuthorityDigest = "b".repeat(64);
    const challengeValue = hnsOwnerChallengeValue("nvs_01");
    const expectedTxtValueSha256 = await sha256Utf8(challengeValue);
    const controlIdentityDigest = await sha256Utf8(
      JSON.stringify([
        "pirate-hns-control-identity-v1",
        "owner_authoritative_dns_txt",
        "_pirate.xn--pokmon-dva",
        challengeValue,
        "xn--pokmon-dva",
        chainAuthorityDigest,
      ]),
    );
    const target = {
      status: "verified",
      observation_contract_version: "pirate-hns-target-observation-v2",
      provider_evidence_ref: `hns-observer-v1:sha256:${observerResultSha256}:hns-observer:regtest:target-01`,
      upstream_session_ref: "nvs_01",
      ownership_source: "owner_authoritative_dns_txt",
      challenge_name: "_pirate.xn--pokmon-dva",
      challenge_value: challengeValue,
      expected_txt_value_sha256: expectedTxtValueSha256,
      control_identity_digest: controlIdentityDigest,
      chain_authority_digest: chainAuthorityDigest,
      observer_result_sha256: observerResultSha256,
      root_exists: true,
      root_control_verified: true,
      expiry_horizon_sufficient: true,
      chain_network: "regtest",
      chain_anchor_height: 123456,
      chain_anchor_block_hash: "5".repeat(64),
      chain_anchor_median_time: 1769999900,
      expiry_height: 200000,
      observed_at: "2026-02-02T00:00:00.000Z",
      expires_at: "2026-03-04T00:00:00.000Z",
    } as const;
    const bytes = new TextEncoder().encode(JSON.stringify(target));
    expect(decodeHnsOwnerResponseBytes(bytes).response).toEqual(target);
    await expect(
      buildHnsOwnershipEvidence(evidenceInput({ raw_response_bytes: bytes })),
    ).resolves.toMatchObject({
      provider_evidence_ref: target.provider_evidence_ref,
      ownership_source: "owner_authoritative_dns_txt",
    });

    for (const changed of [
      { ...target, expected_txt_value_sha256: "c".repeat(64) },
      { ...target, control_identity_digest: "c".repeat(64) },
      { ...target, provider_evidence_ref: "hns-observer:regtest:uncrosspinned" },
    ]) {
      await expect(
        buildHnsOwnershipEvidence(
          evidenceInput({ raw_response_bytes: new TextEncoder().encode(JSON.stringify(changed)) }),
        ),
      ).rejects.toThrow();
    }
    const reordered = JSON.stringify(target).replace(
      '{"status":"verified","observation_contract_version":"pirate-hns-target-observation-v2"',
      '{"observation_contract_version":"pirate-hns-target-observation-v2","status":"verified"',
    );
    expect(() => decodeHnsOwnerResponseBytes(new TextEncoder().encode(reordered))).toThrow(
      HnsOwnerResponseDecodeError,
    );
  });

  test("rejects duplicate JSON object members including escaped aliases", () => {
    expect(() =>
      decodeHnsOwnerResponseBytes(
        new TextEncoder().encode('{"status":"pending","\\u0073tatus":"pending"}'),
      ),
    ).toThrow(HnsOwnerResponseDecodeError);
    for (const nonCanonical of [
      '{ "status":"pending"}',
      '{"status" : "pending"}',
      '{"status":"pending"}\n',
      '{"status":"pending","extra":1e0}',
    ]) {
      expect(() => decodeHnsOwnerResponseBytes(new TextEncoder().encode(nonCanonical))).toThrow(
        HnsOwnerResponseDecodeError,
      );
    }
  });

  test("binds the digest to the target evidence reservation and rejects tampering", async () => {
    const baselineInput = evidenceInput();
    const baseline = await buildHnsOwnershipEvidence(baselineInput);
    const changed = await buildHnsOwnershipEvidence({
      ...baselineInput,
      evidence_ref: "other-target-ref",
    });
    expect(changed.evidence_digest).not.toBe(baseline.evidence_digest);
    expect(baseline.provider_identity_digest).toBe(
      "21d53c5e1d466e65cfa1a2997ddf307640592743472df15feb64d4084b5396ff",
    );
    await expect(
      sha256Utf8(new TextDecoder().decode(baselineInput.raw_response_bytes)),
    ).resolves.toBe(baseline.observation_sha256);
    await expect(
      buildHnsOwnershipEvidence(
        evidenceInput({
          raw_response_bytes: verifiedResponseBytes({
            challenge_name: "_pirate.other-root",
          }),
        }),
      ),
    ).rejects.toThrow();
    await expect(
      buildHnsOwnershipEvidence(
        evidenceInput({ raw_response_bytes: verifiedResponseBytes({ expires_at: null }) }),
      ),
    ).rejects.toThrow();
    await expect(
      buildHnsOwnershipEvidence(evidenceInput({ request_hash: "0".repeat(64) })),
    ).rejects.toThrow();
    await expect(
      buildHnsOwnershipEvidence(evidenceInput({ upstream_session_ref: "nvs_other" })),
    ).rejects.toThrow();
    await expect(
      buildHnsOwnershipEvidence({
        ...evidenceInput(),
        provider_identity_digest: "f".repeat(64),
      } as HnsOwnershipEvidenceInput),
    ).rejects.toThrow();
    expect(() =>
      hnsProviderIdentityPreimage({
        provider_id: HNS_OWNER_PROVIDER_ID,
        provider_configuration_kind: "managed",
        provider_configuration_reference: "hns-owner-staging",
        provider_configuration_version: "hns-owner-config-v1",
        protocol_version: "hns-txt-v1",
        root_label: ` ${route.root_label}`,
      }),
    ).toThrow();
  });
});

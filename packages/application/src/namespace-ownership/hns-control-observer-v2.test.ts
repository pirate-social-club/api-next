import { expect, test } from "bun:test";
import type { Sha256Hex } from "@pirate/domain/verification";
import { decodeHnsControlObservationRequestBytes } from "./hns-control-observer.ts";
import { HNS_CONTROL_OBSERVER_CONFIGURATION_V2_VERSION } from "./hns-control-observer-configuration.ts";
import {
  decodeHnsActiveLeaseRenewalIneligibleResponseV2Bytes,
  decodeHnsControlObservationCompatibleResultBytes,
  decodeHnsControlObservationResultV2Bytes,
  decodeHnsOwnerTargetIneligibleObservationV3Bytes,
  encodeHnsActiveLeaseRenewalIneligibleResponseV2,
  encodeHnsOwnerRecoverySourceIneligiblePublicResponse,
  type HnsControlObserverTranscriptManifestEntryV2,
  hnsActiveLeaseRenewalSourceIneligibleResultV3Hash,
  hnsActiveLeaseRenewalSourceIneligibleResultV3Preimage,
  hnsControlObserverSnapshotAccountingEnvelopeV2Bytes,
  hnsControlObserverSnapshotDigestV2,
  hnsControlObserverSnapshotLogicalByteLengthV2,
  hnsControlObserverSnapshotPreimageV2,
  hnsControlObserverTranscriptManifestDigestV2,
  hnsControlObserverTranscriptManifestPreimageV2,
  hnsCreationSourceIneligibleResultV2Hash,
  hnsCreationSourceIneligibleResultV2Preimage,
  hnsOwnerRecoverySourceIneligibleResultV2Hash,
  hnsOwnerRecoverySourceIneligibleResultV2Preimage,
  mapHnsControlObservationIneligibleToTargetV3,
} from "./hns-control-observer-v2.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sha = (value: string) => value.repeat(64) as Sha256Hex;

const requestJson =
  '{"version":"pirate-hns-control-observation-request-v1","observation_id":"observer-custody-01","provider_id":"hns.owner.v1","provider_configuration_reference":"hns-observer-regtest-config-fixture-v2","provider_configuration_version":"hns-observer-config-v2","provider_configuration_digest":"9b57c1f4630267f270f1b93dced9805d058f692d0cee879a9a4ee54b6e3e6b8b","environment":"test","ownership_source":"owner_authoritative_dns_txt","root_label":"pirate","txt_name":"_pirate.pirate","expected_txt_value":"pirate-verification=nvs_custody_01"}';
const ineligibleResultJson =
  '{"version":"pirate-hns-control-observation-result-v2","observation_id":"observer-custody-01","request_sha256":"6cde68935faf0fa231d2e38b09f42e90592d4f69b8cb9a3fc05c47e326e93247","status":"ineligible","reason_code":"owner_authoritative_source_ineligible","provider_id":"hns.owner.v1","provider_configuration_reference":"hns-observer-regtest-config-fixture-v2","provider_configuration_version":"hns-observer-config-v2","provider_configuration_digest":"9b57c1f4630267f270f1b93dced9805d058f692d0cee879a9a4ee54b6e3e6b8b","environment":"test","ownership_source":"owner_authoritative_dns_txt","root_label":"pirate","txt_name":"_pirate.pirate","expected_txt_value_sha256":"f8c7e628a8ff881a53aa0ad1cf405c106708d89008c9400cdf49fb417d19d5c1","chain_authority_digest":"381aaf45baf0e0f417edcae27740b38396d3925f362cca3e8643d37c77fd0483","chain_network":"regtest","chain_genesis_block_hash":"2222222222222222222222222222222222222222222222222222222222222222","chain_anchor_height":123600,"chain_anchor_block_hash":"7777777777777777777777777777777777777777777777777777777777777777","chain_anchor_median_time":1770007200,"expiry_height":200000,"authority_inventory_reference":"authority-inventory:regtest-20260824-01","authority_inventory_version":"authority-inventory-v1-20260824-01","authority_inventory_digest":"0df75e870a0ec11e7a0a81439a09e30796c69d9110749383c57a475e4824b18c","observer_snapshot_sha256":"a929b15f5d304b0a73a97c23db9140b6c53612568907189d5b57e4b5186b7ef9","diagnostic_ref":"hns-observer:regtest:custody-01"}';
const targetJson =
  '{"status":"ineligible","observation_contract_version":"pirate-hns-target-observation-v3","reason_code":"owner_authoritative_source_ineligible","ownership_source":"owner_authoritative_dns_txt","root_label":"pirate","chain_authority_digest":"381aaf45baf0e0f417edcae27740b38396d3925f362cca3e8643d37c77fd0483","authority_inventory_reference":"authority-inventory:regtest-20260824-01","authority_inventory_version":"authority-inventory-v1-20260824-01","authority_inventory_digest":"0df75e870a0ec11e7a0a81439a09e30796c69d9110749383c57a475e4824b18c","observer_snapshot_sha256":"a929b15f5d304b0a73a97c23db9140b6c53612568907189d5b57e4b5186b7ef9","observer_result_sha256":"f7d87887a9a22c207ae4dad9a865411964ee8cf6fdf226e90743f8bbb10f3782","diagnostic_ref":"hns-observer:regtest:custody-01"}';
const unavailableResultJson =
  '{"version":"pirate-hns-control-observation-result-v2","observation_id":"observer-custody-unavailable-01","request_sha256":"dda73915eef72c40ba3b5d4d105814bb0cf8a69ceda29f1a94f15bf9345786a0","status":"unavailable","reason_code":"authority_inventory_unavailable","retry_after_seconds":null,"observer_snapshot_sha256":"8cdf5aade56695d4cbdcf0f98cdb381d49bed92be927894f09985ac919d239a7","diagnostic_ref":"hns-observer:regtest:custody-unavailable-01"}';

const transcriptEntries: ReadonlyArray<HnsControlObserverTranscriptManifestEntryV2> = [
  [
    "hsd-json-rpc:regtest-primary",
    "owner_authoritative_dns_txt",
    "getblockchaininfo",
    sha("a"),
    "response",
    200,
    sha("b"),
  ],
  [
    "hsd-json-rpc:regtest-primary",
    "owner_authoritative_dns_txt",
    "getblockheader",
    sha("c"),
    "response",
    200,
    sha("d"),
  ],
  [
    "hsd-json-rpc:regtest-primary",
    "owner_authoritative_dns_txt",
    "getnameinfo",
    sha("e"),
    "response",
    200,
    sha("f"),
  ],
  [
    "hsd-json-rpc:regtest-primary",
    "owner_authoritative_dns_txt",
    "getnameresource",
    sha("1"),
    "response",
    200,
    sha("2"),
  ],
  [
    "hsd-json-rpc:regtest-primary",
    "owner_authoritative_dns_txt",
    "getblockchaininfo",
    sha("3"),
    "response",
    200,
    sha("4"),
  ],
];

const snapshotInput = {
  observation_id: "observer-custody-01",
  request_sha256: "6cde68935faf0fa231d2e38b09f42e90592d4f69b8cb9a3fc05c47e326e93247",
  provider_configuration_digest: "9b57c1f4630267f270f1b93dced9805d058f692d0cee879a9a4ee54b6e3e6b8b",
  authority_inventory_reference_or_null: "authority-inventory:regtest-20260824-01",
  authority_inventory_version_or_null: "authority-inventory-v1-20260824-01",
  authority_inventory_digest_or_null:
    "0df75e870a0ec11e7a0a81439a09e30796c69d9110749383c57a475e4824b18c",
  reservation_database_time: "2026-02-02T04:00:00.000Z",
  snapshot_reference: "hns-observer:regtest:custody-01",
  transcript_manifest_sha256: "d3802708e3680281c021d96e76aa5c66c0c7df8c45b4e11ba77e6362d22aa43d",
  semantic_facts_sha256: sha("5"),
} as const;

test("reproduces the custody result, snapshot, and target vectors", async () => {
  const transcriptPreimage = hnsControlObserverTranscriptManifestPreimageV2(transcriptEntries);
  expect(encoder.encode(transcriptPreimage).byteLength).toBe(1_205);
  expect(await hnsControlObserverTranscriptManifestDigestV2(transcriptEntries)).toBe(
    snapshotInput.transcript_manifest_sha256,
  );
  const snapshotPreimage = hnsControlObserverSnapshotPreimageV2(snapshotInput);
  expect(encoder.encode(snapshotPreimage).byteLength).toBe(540);
  expect(await hnsControlObserverSnapshotDigestV2(snapshotInput)).toBe(
    "a929b15f5d304b0a73a97c23db9140b6c53612568907189d5b57e4b5186b7ef9",
  );

  const request = await decodeHnsControlObservationRequestBytes(encoder.encode(requestJson));
  const resultBytes = encoder.encode(ineligibleResultJson);
  expect(resultBytes.byteLength).toBe(1_507);
  const decoded = await decodeHnsControlObservationResultV2Bytes(resultBytes, request.request);
  expect(decoded.result_sha256).toBe(
    "f7d87887a9a22c207ae4dad9a865411964ee8cf6fdf226e90743f8bbb10f3782",
  );
  expect(
    await decodeHnsControlObservationCompatibleResultBytes(
      resultBytes,
      request.request,
      HNS_CONTROL_OBSERVER_CONFIGURATION_V2_VERSION,
    ),
  ).toEqual(decoded);

  const target = await mapHnsControlObservationIneligibleToTargetV3({
    request: request.request,
    result_bytes: resultBytes,
  });
  expect(JSON.stringify(target)).toBe(targetJson);
  const decodedTarget = await decodeHnsOwnerTargetIneligibleObservationV3Bytes(
    encoder.encode(targetJson),
  );
  expect(decodedTarget.response_sha256).toBe(
    "307e5faeb662f801f011adc0f74009cd2cdd6cee6cf9493c90272ce71ed7606a",
  );
});

test("keeps result versions closed and inventory uncertainty unavailable", async () => {
  const request = await decodeHnsControlObservationRequestBytes(encoder.encode(requestJson));
  await expect(
    decodeHnsControlObservationCompatibleResultBytes(
      encoder.encode(ineligibleResultJson),
      request.request,
      "pirate-hns-control-observer-configuration-v1",
    ),
  ).rejects.toThrow("cannot cross-decode");

  const unavailableRequest = {
    ...request.request,
    observation_id: "observer-custody-unavailable-01",
  };
  const unavailable = await decodeHnsControlObservationResultV2Bytes(
    encoder.encode(unavailableResultJson),
    unavailableRequest,
  );
  expect(unavailable.result).toMatchObject({
    status: "unavailable",
    reason_code: "authority_inventory_unavailable",
  });
  expect(unavailable.result_sha256).toBe(
    "ef586a0c50bdc16d3e15f0dd25325b3e1684bd94db15c144a8b24b3bc8a427c2",
  );
  const emptyTranscriptDigest = await hnsControlObserverTranscriptManifestDigestV2([]);
  expect(emptyTranscriptDigest).toBe(
    "69ec706b7ab9693d9801064366816de3580ddac649964fdf8d5b1c60531da7e3",
  );
  expect(
    await hnsControlObserverSnapshotDigestV2({
      observation_id: unavailableRequest.observation_id,
      request_sha256: unavailable.result.request_sha256,
      provider_configuration_digest: unavailableRequest.provider_configuration_digest,
      authority_inventory_reference_or_null: null,
      authority_inventory_version_or_null: null,
      authority_inventory_digest_or_null: null,
      reservation_database_time: "2026-02-02T04:00:00.000Z",
      snapshot_reference: "hns-observer:regtest:custody-unavailable-01",
      transcript_manifest_sha256: emptyTranscriptDigest,
      semantic_facts_sha256: sha("6"),
    }),
  ).toBe("8cdf5aade56695d4cbdcf0f98cdb381d49bed92be927894f09985ac919d239a7");

  const reordered = JSON.parse(ineligibleResultJson) as Record<string, unknown>;
  const reorderedBytes = encoder.encode(
    JSON.stringify({ status: reordered.status, ...reordered, status_again: undefined }),
  );
  await expect(decodeHnsControlObservationResultV2Bytes(reorderedBytes)).rejects.toThrow(
    "members are reordered",
  );
  await expect(
    decodeHnsControlObservationResultV2Bytes(
      encoder.encode(
        ineligibleResultJson.replace(
          '"ownership_source":"owner_authoritative_dns_txt"',
          '"ownership_source":"hns_parent_chain_txt"',
        ),
      ),
    ),
  ).rejects.toThrow();
});

test("charges exact inventory bytes in the successor snapshot accounting", () => {
  const transcript = [
    {
      driver_reference: "hsd-json-rpc:regtest-primary",
      ownership_source: "owner_authoritative_dns_txt" as const,
      method_or_view_id: "getblockchaininfo",
      request_bytes: encoder.encode("request"),
      request_sha256: sha("a"),
      transport_outcome: "response" as const,
      transport_status: 200,
      response_bytes: encoder.encode("response"),
      response_sha256: sha("b"),
    },
  ];
  const payload = {
    observation_id: snapshotInput.observation_id,
    observer_fence: 1,
    reservation_database_time: snapshotInput.reservation_database_time,
    lease_expires_at: "2026-02-02T04:00:15.000Z",
    request_bytes: encoder.encode(requestJson),
    request_sha256: snapshotInput.request_sha256,
    configuration_bytes: encoder.encode("configuration"),
    provider_configuration_digest: snapshotInput.provider_configuration_digest,
    authority_inventory_bytes: encoder.encode("inventory"),
    authority_inventory_reference_or_null: snapshotInput.authority_inventory_reference_or_null,
    authority_inventory_version_or_null: snapshotInput.authority_inventory_version_or_null,
    authority_inventory_digest_or_null: snapshotInput.authority_inventory_digest_or_null,
    snapshot_reference: snapshotInput.snapshot_reference,
    transcript,
    transcript_manifest_sha256: snapshotInput.transcript_manifest_sha256,
    semantic_facts_bytes: encoder.encode("facts"),
    semantic_facts_sha256: snapshotInput.semantic_facts_sha256,
    observer_snapshot_sha256:
      "a929b15f5d304b0a73a97c23db9140b6c53612568907189d5b57e4b5186b7ef9" as Sha256Hex,
    result_status: "ineligible" as const,
    result_reference_kind: "diagnostic_ref" as const,
    result_bytes: encoder.encode(ineligibleResultJson),
    result_sha256: "f7d87887a9a22c207ae4dad9a865411964ee8cf6fdf226e90743f8bbb10f3782" as Sha256Hex,
  };
  const envelope = hnsControlObserverSnapshotAccountingEnvelopeV2Bytes(payload);
  const transcriptEntry = transcript[0];
  if (transcriptEntry === undefined) throw new Error("snapshot transcript fixture is missing");
  const raw =
    payload.request_bytes.byteLength +
    payload.configuration_bytes.byteLength +
    (payload.authority_inventory_bytes?.byteLength ?? 0) +
    payload.semantic_facts_bytes.byteLength +
    payload.result_bytes.byteLength +
    transcriptEntry.request_bytes.byteLength +
    (transcriptEntry.response_bytes?.byteLength ?? 0);
  expect(hnsControlObserverSnapshotLogicalByteLengthV2(payload)).toBe(raw + envelope.byteLength);
  expect(decoder.decode(envelope)).toContain('"authority_inventory_bytes":9');
  expect(() =>
    hnsControlObserverSnapshotAccountingEnvelopeV2Bytes({
      ...payload,
      authority_inventory_bytes: null,
    }),
  ).toThrow("partial nullable tuple");
});

test("reproduces the exact creation, recovery, and renewal custody outcomes", async () => {
  const providerResponseHash =
    "307e5faeb662f801f011adc0f74009cd2cdd6cee6cf9493c90272ce71ed7606a" as Sha256Hex;
  const creation = {
    ceremony_intent_id: "cc_ceremony-custody-1",
    session_id: "ns_session-custody-1",
    expected_revision: 1,
    idempotency_key: "poll-custody-01",
    completion_request_hash: sha("8"),
    provider_response_sha256: providerResponseHash,
  } as const;
  expect(hnsCreationSourceIneligibleResultV2Preimage(creation)).toBe(
    '["pirate-hns-terminal-result-v2","cc_ceremony-custody-1","ns_session-custody-1",1,"poll-custody-01","8888888888888888888888888888888888888888888888888888888888888888","rejected","owner_authoritative_source_ineligible",null,null,null,"307e5faeb662f801f011adc0f74009cd2cdd6cee6cf9493c90272ce71ed7606a"]',
  );
  expect(await hnsCreationSourceIneligibleResultV2Hash(creation)).toBe(
    "5e476036eb6242cab524b25c7067e45574b2d391c7bafbbc1703867b843aee3e",
  );

  const recovery = {
    route_recovery_id: "hns_recovery_01",
    session_id: "hns_recovery_session_01",
    recovery_attempt_id: "hns_recovery_attempt_01",
    route_binding_id: "route-binding-1",
    expected_binding_generation: 13,
    idempotency_key: "recovery-poll-01",
    poll_hash: "cdb7c8239bc15c43986d749d72aea475c1662a4690d8119899ff1b746e192447" as Sha256Hex,
    provider_response_sha256: providerResponseHash,
  } as const;
  expect(
    encoder.encode(hnsOwnerRecoverySourceIneligibleResultV2Preimage(recovery)).byteLength,
  ).toBe(356);
  expect(await hnsOwnerRecoverySourceIneligibleResultV2Hash(recovery)).toBe(
    "af5b53a5b14120ac4ec297dad90a79561ed10b4183dbc40957e1d0eb9a8eb67c",
  );
  const recoveryPublicBytes = await encodeHnsOwnerRecoverySourceIneligiblePublicResponse({
    route_recovery_id: recovery.route_recovery_id,
    session_id: recovery.session_id,
    generation: 14,
    status: "rejected",
    reason_code: "source_ineligible",
    replayed: false,
    retry_after_seconds: null,
    result_hash: "af5b53a5b14120ac4ec297dad90a79561ed10b4183dbc40957e1d0eb9a8eb67c",
  });
  expect(recoveryPublicBytes.byteLength).toBe(273);

  const renewalResponse = {
    version: "pirate-hns-active-lease-renewal-response-v2",
    active_lease_renewal_id: "hns_renewal_01",
    active_lease_renewal_attempt_id: "hns_renewal_attempt_01",
    request_hash: "99a42636962fa1b8d8c18a9f278036bf710384fb66a74ec81a2a0eacd9b8acc1",
    status: "ineligible",
    reason_code: "owner_authoritative_source_ineligible",
    observer_snapshot_sha256: "a929b15f5d304b0a73a97c23db9140b6c53612568907189d5b57e4b5186b7ef9",
    observer_result_sha256: "f7d87887a9a22c207ae4dad9a865411964ee8cf6fdf226e90743f8bbb10f3782",
    diagnostic_ref: "hns-observer:regtest:custody-01",
  } as const;
  const renewalResponseBytes =
    await encodeHnsActiveLeaseRenewalIneligibleResponseV2(renewalResponse);
  expect(renewalResponseBytes.byteLength).toBe(554);
  expect(
    (await decodeHnsActiveLeaseRenewalIneligibleResponseV2Bytes(renewalResponseBytes))
      .response_sha256,
  ).toBe("4070cc9afdd935be048195d9075154ded3e9083f5e1a3db3e0363be9d6195825");

  const renewalResult = {
    active_lease_renewal_id: "hns_renewal_01",
    active_lease_renewal_attempt_id: "hns_renewal_attempt_01",
    route_binding_id: "route-binding-1",
    expected_binding_generation: 12,
    idempotency_key: "renewal-01",
    request_hash: renewalResponse.request_hash,
    provider_response_sha256:
      "4070cc9afdd935be048195d9075154ded3e9083f5e1a3db3e0363be9d6195825" as Sha256Hex,
  } as const;
  expect(
    encoder.encode(hnsActiveLeaseRenewalSourceIneligibleResultV3Preimage(renewalResult)).byteLength,
  ).toBe(328);
  expect(await hnsActiveLeaseRenewalSourceIneligibleResultV3Hash(renewalResult)).toBe(
    "a8c4ef4a1b1be74318fa54352474c8ba882fec86f61d40ec23cf9775df5adb8b",
  );
});

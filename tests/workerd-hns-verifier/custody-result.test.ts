/// <reference types="@cloudflare/vitest-pool-workers/types" />

import {
  decodeHnsControlObservationRequestBytes,
  decodeHnsControlObservationResultV2Bytes,
  type HnsControlObserverTranscriptManifestEntryV2,
  hnsControlObserverSnapshotDigestV2,
  hnsControlObserverTranscriptManifestDigestV2,
  hnsCreationSourceIneligibleResultV2Hash,
  mapHnsControlObservationIneligibleToTargetV3,
} from "@pirate/application/namespace-ownership";
import type { Sha256Hex } from "@pirate/domain/verification";
import { describe, expect, it } from "vitest";

const encoder = new TextEncoder();
const hex = (value: string) => value.repeat(64) as Sha256Hex;
const requestJson =
  '{"version":"pirate-hns-control-observation-request-v1","observation_id":"observer-custody-01","provider_id":"hns.owner.v1","provider_configuration_reference":"hns-observer-regtest-config-fixture-v2","provider_configuration_version":"hns-observer-config-v2","provider_configuration_digest":"9b57c1f4630267f270f1b93dced9805d058f692d0cee879a9a4ee54b6e3e6b8b","environment":"test","ownership_source":"owner_authoritative_dns_txt","root_label":"pirate","txt_name":"_pirate.pirate","expected_txt_value":"pirate-verification=nvs_custody_01"}';
const resultJson =
  '{"version":"pirate-hns-control-observation-result-v2","observation_id":"observer-custody-01","request_sha256":"6cde68935faf0fa231d2e38b09f42e90592d4f69b8cb9a3fc05c47e326e93247","status":"ineligible","reason_code":"owner_authoritative_source_ineligible","provider_id":"hns.owner.v1","provider_configuration_reference":"hns-observer-regtest-config-fixture-v2","provider_configuration_version":"hns-observer-config-v2","provider_configuration_digest":"9b57c1f4630267f270f1b93dced9805d058f692d0cee879a9a4ee54b6e3e6b8b","environment":"test","ownership_source":"owner_authoritative_dns_txt","root_label":"pirate","txt_name":"_pirate.pirate","expected_txt_value_sha256":"f8c7e628a8ff881a53aa0ad1cf405c106708d89008c9400cdf49fb417d19d5c1","chain_authority_digest":"381aaf45baf0e0f417edcae27740b38396d3925f362cca3e8643d37c77fd0483","chain_network":"regtest","chain_genesis_block_hash":"2222222222222222222222222222222222222222222222222222222222222222","chain_anchor_height":123600,"chain_anchor_block_hash":"7777777777777777777777777777777777777777777777777777777777777777","chain_anchor_median_time":1770007200,"expiry_height":200000,"authority_inventory_reference":"authority-inventory:regtest-20260824-01","authority_inventory_version":"authority-inventory-v1-20260824-01","authority_inventory_digest":"0df75e870a0ec11e7a0a81439a09e30796c69d9110749383c57a475e4824b18c","observer_snapshot_sha256":"a929b15f5d304b0a73a97c23db9140b6c53612568907189d5b57e4b5186b7ef9","diagnostic_ref":"hns-observer:regtest:custody-01"}';

describe("HNS custody result successors (workerd)", () => {
  it("reproduces the immutable result, snapshot, target, and creation hashes", async () => {
    const transcript: ReadonlyArray<HnsControlObserverTranscriptManifestEntryV2> = [
      [
        "hsd-json-rpc:regtest-primary",
        "owner_authoritative_dns_txt",
        "getblockchaininfo",
        hex("a"),
        "response",
        200,
        hex("b"),
      ],
      [
        "hsd-json-rpc:regtest-primary",
        "owner_authoritative_dns_txt",
        "getblockheader",
        hex("c"),
        "response",
        200,
        hex("d"),
      ],
      [
        "hsd-json-rpc:regtest-primary",
        "owner_authoritative_dns_txt",
        "getnameinfo",
        hex("e"),
        "response",
        200,
        hex("f"),
      ],
      [
        "hsd-json-rpc:regtest-primary",
        "owner_authoritative_dns_txt",
        "getnameresource",
        hex("1"),
        "response",
        200,
        hex("2"),
      ],
      [
        "hsd-json-rpc:regtest-primary",
        "owner_authoritative_dns_txt",
        "getblockchaininfo",
        hex("3"),
        "response",
        200,
        hex("4"),
      ],
    ];
    const transcriptDigest = await hnsControlObserverTranscriptManifestDigestV2(transcript);
    expect(transcriptDigest).toBe(
      "d3802708e3680281c021d96e76aa5c66c0c7df8c45b4e11ba77e6362d22aa43d",
    );
    expect(
      await hnsControlObserverSnapshotDigestV2({
        observation_id: "observer-custody-01",
        request_sha256: "6cde68935faf0fa231d2e38b09f42e90592d4f69b8cb9a3fc05c47e326e93247",
        provider_configuration_digest:
          "9b57c1f4630267f270f1b93dced9805d058f692d0cee879a9a4ee54b6e3e6b8b",
        authority_inventory_reference_or_null: "authority-inventory:regtest-20260824-01",
        authority_inventory_version_or_null: "authority-inventory-v1-20260824-01",
        authority_inventory_digest_or_null:
          "0df75e870a0ec11e7a0a81439a09e30796c69d9110749383c57a475e4824b18c",
        reservation_database_time: "2026-02-02T04:00:00.000Z",
        snapshot_reference: "hns-observer:regtest:custody-01",
        transcript_manifest_sha256: transcriptDigest,
        semantic_facts_sha256: hex("5"),
      }),
    ).toBe("a929b15f5d304b0a73a97c23db9140b6c53612568907189d5b57e4b5186b7ef9");

    const request = await decodeHnsControlObservationRequestBytes(encoder.encode(requestJson));
    const result = await decodeHnsControlObservationResultV2Bytes(
      encoder.encode(resultJson),
      request.request,
    );
    expect(result.result_sha256).toBe(
      "f7d87887a9a22c207ae4dad9a865411964ee8cf6fdf226e90743f8bbb10f3782",
    );
    const target = await mapHnsControlObservationIneligibleToTargetV3({
      request: request.request,
      result_bytes: result.result_bytes,
    });
    expect(target.observer_snapshot_sha256).toBe(result.result.observer_snapshot_sha256);
    expect(target.observer_result_sha256).toBe(result.result_sha256);
    expect(
      await hnsCreationSourceIneligibleResultV2Hash({
        ceremony_intent_id: "cc_ceremony-custody-1",
        session_id: "ns_session-custody-1",
        expected_revision: 1,
        idempotency_key: "poll-custody-01",
        completion_request_hash: hex("8"),
        provider_response_sha256:
          "307e5faeb662f801f011adc0f74009cd2cdd6cee6cf9493c90272ce71ed7606a",
      }),
    ).toBe("5e476036eb6242cab524b25c7067e45574b2d391c7bafbbc1703867b843aee3e");
  });
});

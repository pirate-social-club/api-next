import { expect, test } from "bun:test";
import {
  type HnsOwnerRouteRevalidationStartWireV1,
  type HnsRouteRevalidationAuthorityV1,
  type HnsRouteRevalidationCompletionHashInput,
  type HnsRouteRevalidationEvidenceEnvelopeV1,
  type HnsRouteRevalidationProviderIdentityInput,
  type HnsRouteRevalidationResultHashInput,
  hnsRouteRevalidationChallengeValueSha256,
  hnsRouteRevalidationCompletionHash,
  hnsRouteRevalidationCompletionPreimage,
  hnsRouteRevalidationEvidenceHash,
  hnsRouteRevalidationEvidencePreimage,
  hnsRouteRevalidationObservationSha256,
  hnsRouteRevalidationProviderIdentityDigest,
  hnsRouteRevalidationProviderIdentityPreimage,
  hnsRouteRevalidationRequirementHash,
  hnsRouteRevalidationRequirementPreimage,
  hnsRouteRevalidationResultHash,
  hnsRouteRevalidationResultPreimage,
  hnsRouteRevalidationStartHash,
  hnsRouteRevalidationStartPreimage,
} from "./hashes.ts";

type FrozenVector = {
  readonly route_revalidation_id: string;
  readonly revalidation_session_id: string;
  readonly route_revalidation_attempt_id: string;
  readonly community_id: string;
  readonly route_binding_id: string;
  readonly principal_kind: "system";
  readonly principal_id: string;
  readonly expected_binding_generation: number;
  readonly binding_generation: number;
  readonly expected_verified_evidence_ref: string | null;
  readonly attempt_number: number;
  readonly idempotency_key: string;
  readonly provider_id: string;
  readonly provider_binding_hash: string;
  readonly provider_configuration_kind: "managed" | "dynamic";
  readonly provider_configuration_reference: string;
  readonly provider_configuration_version: string;
  readonly protocol_version: "hns-txt-v1";
  readonly environment: string;
  readonly family: "hns";
  readonly root_label: string;
  readonly root_label_display: string;
  readonly path_segment: string;
  readonly upstream_session_ref: string;
  readonly ownership_source: "hns_parent_chain_txt" | "owner_authoritative_dns_txt";
  readonly challenge_name: string;
  readonly challenge_value: string;
  readonly challenge_value_sha256: string;
  readonly root_exists: true;
  readonly root_control_verified: true;
  readonly expiry_horizon_sufficient: true;
  readonly chain_network: string;
  readonly chain_anchor_height: number;
  readonly chain_anchor_block_hash: string;
  readonly chain_anchor_median_time: number;
  readonly expiry_height: number;
  readonly observed_at: string;
  readonly expires_at: string;
  readonly evidence_ref: string;
  readonly provider_evidence_ref: string;
  readonly observation_raw_response_utf8: string;
  readonly observation_sha256: string;
  readonly requirement_hash: string;
  readonly start_request_hash: string;
  readonly completion_request_hash: string;
  readonly provider_identity_digest: string;
  readonly evidence_digest: string;
  readonly result_hash: string;
};

const vector = (await Bun.file(
  new URL("../../../../tests/fixtures/hns-route-revalidation-v1.json", import.meta.url),
).json()) as FrozenVector;

const authority = (): HnsRouteRevalidationAuthorityV1 => ({
  version: "pirate-hns-route-revalidation-authority-v1",
  route_revalidation_id: vector.route_revalidation_id,
  community_id: vector.community_id,
  route_binding_id: vector.route_binding_id,
  principal_kind: vector.principal_kind,
  principal_id: vector.principal_id,
  expected_binding_generation: vector.expected_binding_generation,
  expected_verified_evidence_ref: vector.expected_verified_evidence_ref,
  requirement_hash: vector.requirement_hash,
  provider_id: vector.provider_id,
  provider_binding_hash: vector.provider_binding_hash,
  provider_configuration_kind: vector.provider_configuration_kind,
  provider_configuration_reference: vector.provider_configuration_reference,
  provider_configuration_version: vector.provider_configuration_version,
  protocol_version: vector.protocol_version,
  environment: vector.environment,
  family: vector.family,
  root_label: vector.root_label,
  root_label_display: vector.root_label_display,
  path_segment: vector.path_segment,
});

const start = (): HnsOwnerRouteRevalidationStartWireV1 => ({
  operation_kind: "route_revalidation",
  route_revalidation_id: vector.route_revalidation_id,
  revalidation_session_id: vector.revalidation_session_id,
  community_id: vector.community_id,
  route_binding_id: vector.route_binding_id,
  expected_binding_generation: vector.expected_binding_generation,
  expected_verified_evidence_ref: vector.expected_verified_evidence_ref,
  principal_kind: vector.principal_kind,
  principal_id: vector.principal_id,
  requirement_hash: vector.requirement_hash,
  start_request_hash: vector.start_request_hash,
  provider_binding_hash: vector.provider_binding_hash,
  provider_configuration: {
    kind: vector.provider_configuration_kind,
    reference: vector.provider_configuration_reference,
    version: vector.provider_configuration_version,
  },
  protocol_version: vector.protocol_version,
  environment: vector.environment,
  route: {
    family: vector.family,
    root_label: vector.root_label,
    root_label_display: vector.root_label_display,
    path_segment: vector.path_segment,
    href: "/c/app.jazleeuw",
    app_host: null,
  },
});

const completion = (): HnsRouteRevalidationCompletionHashInput => ({
  route_revalidation_id: vector.route_revalidation_id,
  revalidation_session_id: vector.revalidation_session_id,
  route_revalidation_attempt_id: vector.route_revalidation_attempt_id,
  route_binding_id: vector.route_binding_id,
  expected_binding_generation: vector.expected_binding_generation,
  expected_verified_evidence_ref: vector.expected_verified_evidence_ref,
  attempt_number: vector.attempt_number,
  idempotency_key: vector.idempotency_key,
  evidence_ref: vector.evidence_ref,
});

const providerIdentity = (): HnsRouteRevalidationProviderIdentityInput => ({
  provider_id: vector.provider_id,
  provider_configuration_kind: vector.provider_configuration_kind,
  provider_configuration_reference: vector.provider_configuration_reference,
  provider_configuration_version: vector.provider_configuration_version,
  protocol_version: vector.protocol_version,
  root_label: vector.root_label,
});

const evidence = (): HnsRouteRevalidationEvidenceEnvelopeV1 => ({
  version: "pirate-hns-route-revalidation-evidence-v1",
  route_revalidation_id: vector.route_revalidation_id,
  revalidation_session_id: vector.revalidation_session_id,
  route_revalidation_attempt_id: vector.route_revalidation_attempt_id,
  community_id: vector.community_id,
  route_binding_id: vector.route_binding_id,
  principal_kind: vector.principal_kind,
  principal_id: vector.principal_id,
  requirement_hash: vector.requirement_hash,
  expected_binding_generation: vector.expected_binding_generation,
  binding_generation: vector.binding_generation,
  expected_verified_evidence_ref: vector.expected_verified_evidence_ref,
  start_request_hash: vector.start_request_hash,
  provider_id: vector.provider_id,
  provider_binding_hash: vector.provider_binding_hash,
  provider_configuration_kind: vector.provider_configuration_kind,
  provider_configuration_reference: vector.provider_configuration_reference,
  provider_configuration_version: vector.provider_configuration_version,
  protocol_version: vector.protocol_version,
  environment: vector.environment,
  family: vector.family,
  root_label: vector.root_label,
  root_label_display: vector.root_label_display,
  path_segment: vector.path_segment,
  upstream_session_ref: vector.upstream_session_ref,
  ownership_source: vector.ownership_source,
  challenge_name: vector.challenge_name,
  challenge_value_sha256: vector.challenge_value_sha256,
  root_exists: vector.root_exists,
  root_control_verified: vector.root_control_verified,
  expiry_horizon_sufficient: vector.expiry_horizon_sufficient,
  chain_network: vector.chain_network,
  chain_anchor_height: vector.chain_anchor_height,
  chain_anchor_block_hash: vector.chain_anchor_block_hash,
  chain_anchor_median_time: vector.chain_anchor_median_time,
  expiry_height: vector.expiry_height,
  observed_at: vector.observed_at,
  expires_at: vector.expires_at,
  evidence_ref: vector.evidence_ref,
  provider_evidence_ref: vector.provider_evidence_ref,
  observation_sha256: vector.observation_sha256,
  provider_identity_digest: vector.provider_identity_digest,
  evidence_digest: vector.evidence_digest,
});

const result = (): HnsRouteRevalidationResultHashInput => ({
  route_revalidation_id: vector.route_revalidation_id,
  revalidation_session_id: vector.revalidation_session_id,
  route_revalidation_attempt_id: vector.route_revalidation_attempt_id,
  route_binding_id: vector.route_binding_id,
  expected_binding_generation: vector.expected_binding_generation,
  idempotency_key: vector.idempotency_key,
  completion_request_hash: vector.completion_request_hash,
  outcome_status: "verified",
  evidence_ref_or_null: vector.evidence_ref,
  evidence_digest_or_null: vector.evidence_digest,
  provider_identity_digest_or_null: vector.provider_identity_digest,
  ownership_status_or_null: "verified",
  route_lifecycle_status_or_null: "active",
});

test("recomputes every frozen route-revalidation vector", async () => {
  const raw = new TextEncoder().encode(vector.observation_raw_response_utf8);
  expect(raw.byteLength).toBe(586);
  expect(await hnsRouteRevalidationObservationSha256(raw)).toBe(vector.observation_sha256);
  expect(await hnsRouteRevalidationChallengeValueSha256(vector.challenge_value)).toBe(
    vector.challenge_value_sha256,
  );
  expect(await hnsRouteRevalidationRequirementHash(authority())).toBe(vector.requirement_hash);
  expect(await hnsRouteRevalidationStartHash(start())).toBe(vector.start_request_hash);
  expect(await hnsRouteRevalidationCompletionHash(completion())).toBe(
    vector.completion_request_hash,
  );
  expect(await hnsRouteRevalidationProviderIdentityDigest(providerIdentity())).toBe(
    vector.provider_identity_digest,
  );
  expect(await hnsRouteRevalidationEvidenceHash(evidence())).toBe(vector.evidence_digest);
  expect(await hnsRouteRevalidationResultHash(result())).toBe(vector.result_hash);
});

test("keeps all ordered-array preimages visible and exact", () => {
  expect(hnsRouteRevalidationRequirementPreimage(authority())).toBe(
    JSON.stringify([
      "pirate-hns-route-revalidation-requirement-v1",
      vector.community_id,
      vector.route_binding_id,
      1,
      vector.expected_verified_evidence_ref,
      "system",
      vector.principal_id,
      vector.provider_id,
      vector.provider_binding_hash,
      vector.provider_configuration_kind,
      vector.provider_configuration_reference,
      vector.provider_configuration_version,
      vector.protocol_version,
      vector.environment,
      "hns",
      vector.root_label,
      vector.root_label_display,
      vector.path_segment,
    ]),
  );
  expect(hnsRouteRevalidationStartPreimage(start())).toContain(
    '"pirate-hns-route-revalidation-request-v1"',
  );
  expect(hnsRouteRevalidationCompletionPreimage(completion())).toContain('"poll_result"');
  expect(hnsRouteRevalidationProviderIdentityPreimage(providerIdentity())).toContain(
    '"pirate-hns-provider-identity-v1"',
  );
  expect(hnsRouteRevalidationEvidencePreimage(evidence())).toContain(
    '"pirate-hns-route-revalidation-evidence-v1"',
  );
  expect(hnsRouteRevalidationResultPreimage(result())).toContain(
    '"pirate-hns-route-revalidation-result-v1"',
  );
});

test("keeps the execution fence out of completion identity", () => {
  expect(hnsRouteRevalidationCompletionPreimage(completion())).toBe(
    JSON.stringify([
      "pirate-hns-route-revalidation-completion-request-v1",
      vector.route_revalidation_id,
      vector.revalidation_session_id,
      vector.route_revalidation_attempt_id,
      vector.route_binding_id,
      vector.expected_binding_generation,
      vector.expected_verified_evidence_ref,
      vector.attempt_number,
      vector.idempotency_key,
      vector.evidence_ref,
      "poll_result",
    ]),
  );
});

test("mutation-drift changes every hash authority", async () => {
  const raw = new TextEncoder().encode(vector.observation_raw_response_utf8);
  const changedRaw = new Uint8Array(raw);
  changedRaw[changedRaw.length - 1] = 0x7d === changedRaw[changedRaw.length - 1] ? 0x7e : 0x7d;

  expect(await hnsRouteRevalidationObservationSha256(changedRaw)).not.toBe(
    vector.observation_sha256,
  );
  expect(await hnsRouteRevalidationChallengeValueSha256(`${vector.challenge_value}!`)).not.toBe(
    vector.challenge_value_sha256,
  );
  expect(
    await hnsRouteRevalidationRequirementHash({ ...authority(), community_id: "cmty_changed" }),
  ).not.toBe(vector.requirement_hash);
  expect(
    await hnsRouteRevalidationStartHash({
      ...start(),
      route: { ...start().route, path_segment: "app.changed" },
    }),
  ).not.toBe(vector.start_request_hash);
  expect(await hnsRouteRevalidationCompletionHash({ ...completion(), attempt_number: 2 })).not.toBe(
    vector.completion_request_hash,
  );
  expect(
    await hnsRouteRevalidationProviderIdentityDigest({
      ...providerIdentity(),
      root_label: "changed",
    }),
  ).not.toBe(vector.provider_identity_digest);
  expect(
    await hnsRouteRevalidationEvidenceHash({
      ...evidence(),
      expires_at: "2026-09-22T08:00:00.000Z",
    }),
  ).not.toBe(vector.evidence_digest);
  expect(
    await hnsRouteRevalidationResultHash({ ...result(), outcome_status: "session_expired" }),
  ).not.toBe(vector.result_hash);
});

test("rejects creation and ceremony authority identifiers", () => {
  expect(() =>
    hnsRouteRevalidationRequirementPreimage({
      ...authority(),
      creation_intent_id: "must-not-exist",
    } as never),
  ).toThrow(/creation_intent_id/);
  expect(() =>
    hnsRouteRevalidationStartPreimage({
      ...start(),
      ceremony_intent_id: "must-not-exist",
    } as never),
  ).toThrow(/ceremony_intent_id/);
  expect(() =>
    hnsRouteRevalidationEvidencePreimage({
      ...evidence(),
      creation_intent_id: "must-not-exist",
    } as never),
  ).toThrow(/creation_intent_id/);
  expect(() =>
    hnsRouteRevalidationResultPreimage({
      ...result(),
      ceremony_intent_id: "must-not-exist",
    } as never),
  ).toThrow(/ceremony_intent_id/);
});

test("rejects a provider-id drift before hashing the requirement", () => {
  expect(() =>
    hnsRouteRevalidationRequirementHash({
      ...authority(),
      provider_id: "unexpected.provider.v1",
    }),
  ).toThrow(/provider/);
});

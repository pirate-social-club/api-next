import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  buildHnsActiveLeaseRenewalEvidence,
  classifyHnsActiveLeaseRenewalResponse,
  decodeHnsActiveLeaseRenewalRequestBytes,
  decodeHnsActiveLeaseRenewalResponseBytes,
  encodeHnsActiveLeaseRenewalRequest,
  type HnsActiveLeaseRenewalAuthorityV1,
  type HnsActiveLeaseRenewalPersistedControlIdentityV1,
  type HnsActiveLeaseRenewalResolvedControlIdentityV1,
  type HnsOwnerActiveLeaseRenewalRequestV1,
  hnsActiveLeaseRenewalEvidenceHash,
  hnsActiveLeaseRenewalEvidencePreimage,
  hnsActiveLeaseRenewalRequestHash,
  hnsActiveLeaseRenewalRequestPreimage,
  hnsActiveLeaseRenewalRequirementHash,
  hnsActiveLeaseRenewalRequirementPreimage,
  hnsActiveLeaseRenewalResultHash,
  hnsActiveLeaseRenewalResultPreimage,
  hnsActiveLeaseRenewalResultV2Hash,
  hnsActiveLeaseRenewalResultV2Preimage,
  mapHnsActiveLeaseRenewalObservation,
  resolveHnsActiveLeaseRenewalControlIdentity,
} from "./hns-active-lease-renewal.ts";
import {
  HnsActiveLeaseRenewalProviderFailed,
  type HnsActiveLeaseRenewalReservation,
  type HnsActiveLeaseRenewalServices,
  type HnsActiveLeaseRenewalStore,
  type HnsActiveLeaseRenewalStoredOperation,
  hnsActiveLeaseRenewalTerminalResultHash,
  runHnsActiveLeaseRenewal,
} from "./hns-active-lease-renewal-operation.ts";
import {
  hnsControlIdentityDigest,
  hnsControlObservationRequestHash,
} from "./hns-control-observer.ts";
import { encodeHnsActiveLeaseRenewalIneligibleResponseV2 } from "./hns-control-observer-v2.ts";

const route = {
  family: "hns" as const,
  root_label: "jazleeuw",
  root_label_display: "jazleeuw",
  path_segment: "app.jazleeuw",
  href: "/c/app.jazleeuw",
  app_host: null,
};
const configuration = {
  kind: "managed" as const,
  reference: "hns-observer-regtest",
  version: "hns-observer-config-v1",
  digest: "1".repeat(64),
};
const authority: HnsActiveLeaseRenewalAuthorityV1 = {
  community_id: "community-1",
  route_binding_id: "route-binding-1",
  expected_binding_generation: 12,
  expected_verified_evidence_ref: "route_evidence_12",
  expected_evidence_digest: "a".repeat(64),
  expected_control_identity_digest:
    "bad01043ba07ebaceef26497266b269d966c72f8f0b14bac44c9b7d44922f236",
  expected_chain_authority_digest:
    "6c176a02ca14aedd62328e805389409a1f4b520b97bb90c2e7f90b47d43557d6",
  prior_provider_evidence_ref:
    "hns-observer-v1:sha256:7d531a8cbb5f778c7394dc734ba61790d34872373f8dcf3b98e46d1187cead5e:hns-observer:regtest:01",
  principal_id: "hns-route-renewal-scheduler",
  provider_id: "hns.owner.v1",
  provider_binding_hash: "4".repeat(64),
  provider_configuration: configuration,
  protocol_version: "hns-active-lease-renewal-v1",
  environment: "test",
  route,
};
const observerRequest = {
  version: "pirate-hns-control-observation-request-v1" as const,
  observation_id: "observer-renewal-01",
  provider_id: "hns.owner.v1",
  provider_configuration_reference: configuration.reference,
  provider_configuration_version: configuration.version,
  provider_configuration_digest: configuration.digest,
  environment: "test",
  ownership_source: "hns_parent_chain_txt" as const,
  root_label: "jazleeuw",
  txt_name: "jazleeuw",
  expected_txt_value: "pirate-verification=nvs_01",
};
const observerResult = {
  version: "pirate-hns-control-observation-result-v1" as const,
  observation_id: "observer-renewal-01",
  request_sha256: "0287bb2b7ca00f4798ae89a965c3c23eb2ce8eb8ba82848ecea2f22eee11e5a7",
  status: "verified" as const,
  provider_id: "hns.owner.v1",
  provider_configuration_reference: configuration.reference,
  provider_configuration_version: configuration.version,
  provider_configuration_digest: configuration.digest,
  environment: "test",
  ownership_source: "hns_parent_chain_txt" as const,
  root_label: "jazleeuw",
  txt_name: "jazleeuw",
  expected_txt_value_sha256: "262aeaa5c81725c9dc9b4e1238b08044a8d2bb92c1dc62069d6109bd20e8da73",
  control_identity_digest: "bad01043ba07ebaceef26497266b269d966c72f8f0b14bac44c9b7d44922f236",
  chain_authority_digest: "6c176a02ca14aedd62328e805389409a1f4b520b97bb90c2e7f90b47d43557d6",
  root_exists: true as const,
  root_control_verified: true as const,
  expiry_horizon_sufficient: true as const,
  chain_network: "regtest",
  chain_genesis_block_hash: "2".repeat(64),
  chain_anchor_height: 123500,
  chain_anchor_block_hash: "5".repeat(64),
  chain_anchor_median_time: 1770003500,
  expiry_height: 200000,
  provider_evidence_ref: "hns-observer:regtest:renewal-01",
};
const observerResultBytes = new TextEncoder().encode(JSON.stringify(observerResult));
const persistedIdentity: HnsActiveLeaseRenewalPersistedControlIdentityV1 = {
  ownership_source: "hns_parent_chain_txt",
  txt_name: "jazleeuw",
  expected_txt_value_sha256: "262aeaa5c81725c9dc9b4e1238b08044a8d2bb92c1dc62069d6109bd20e8da73",
  control_identity_digest: "bad01043ba07ebaceef26497266b269d966c72f8f0b14bac44c9b7d44922f236",
  chain_authority_digest: "6c176a02ca14aedd62328e805389409a1f4b520b97bb90c2e7f90b47d43557d6",
};
const resolvedIdentity: HnsActiveLeaseRenewalResolvedControlIdentityV1 = {
  ...persistedIdentity,
  expected_txt_value: "pirate-verification=nvs_01",
};

async function request(): Promise<HnsOwnerActiveLeaseRenewalRequestV1> {
  const requirement_hash = await hnsActiveLeaseRenewalRequirementHash(authority);
  const value = {
    version: "pirate-hns-active-lease-renewal-request-v1" as const,
    operation_kind: "active_lease_renewal" as const,
    active_lease_renewal_id: "hns_renewal_01",
    active_lease_renewal_attempt_id: "hns_renewal_attempt_01",
    community_id: authority.community_id,
    route_binding_id: authority.route_binding_id,
    expected_binding_generation: authority.expected_binding_generation,
    expected_verified_evidence_ref: authority.expected_verified_evidence_ref,
    expected_evidence_digest: authority.expected_evidence_digest,
    expected_control_identity_digest: authority.expected_control_identity_digest,
    expected_chain_authority_digest: authority.expected_chain_authority_digest,
    prior_provider_evidence_ref: authority.prior_provider_evidence_ref,
    attempt_number: 1,
    evidence_ref: "route_evidence_13",
    requirement_hash,
    request_hash: "0".repeat(64),
    provider_id: authority.provider_id,
    provider_binding_hash: authority.provider_binding_hash,
    provider_configuration: authority.provider_configuration,
    protocol_version: authority.protocol_version,
    environment: authority.environment,
    route,
  } satisfies Omit<HnsOwnerActiveLeaseRenewalRequestV1, "request_hash"> & {
    request_hash: string;
  };
  return { ...value, request_hash: await hnsActiveLeaseRenewalRequestHash(value) };
}

const leasePolicy = {
  expected_block_interval_seconds: 600,
  minimum_safe_remaining_blocks: 1,
  expiry_safety_blocks: 1,
  evidence_lease_seconds: 2_592_000,
};

async function positiveResponse(): Promise<{
  readonly request: HnsOwnerActiveLeaseRenewalRequestV1;
  readonly response: Extract<
    Awaited<ReturnType<typeof mapHnsActiveLeaseRenewalObservation>>,
    { status: "verified" }
  >;
  readonly context: {
    readonly request: HnsOwnerActiveLeaseRenewalRequestV1;
    readonly authority: HnsActiveLeaseRenewalAuthorityV1;
    readonly control_identity: HnsActiveLeaseRenewalPersistedControlIdentityV1;
    readonly policy: typeof leasePolicy;
  };
}> {
  const renewalRequest = await request();
  const response = await mapHnsActiveLeaseRenewalObservation({
    request: renewalRequest,
    authority,
    control_identity: resolvedIdentity,
    observer_request: observerRequest,
    observer_result_bytes: observerResultBytes,
    upstream_session_ref: "nvs_01",
    policy: leasePolicy,
  });
  if (response.status !== "verified") throw new Error("expected verified response");
  return {
    request: renewalRequest,
    response,
    context: {
      request: renewalRequest,
      authority,
      control_identity: persistedIdentity,
      policy: leasePolicy,
    },
  };
}

test("reproduces the ratified requirement and request vectors", async () => {
  const requirementPreimage = hnsActiveLeaseRenewalRequirementPreimage(authority);
  expect(new TextEncoder().encode(requirementPreimage).byteLength).toBe(746);
  expect(requirementPreimage).toBe(
    '["pirate-hns-active-lease-renewal-requirement-v1","community-1","route-binding-1",12,"route_evidence_12","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bad01043ba07ebaceef26497266b269d966c72f8f0b14bac44c9b7d44922f236","6c176a02ca14aedd62328e805389409a1f4b520b97bb90c2e7f90b47d43557d6","hns-observer-v1:sha256:7d531a8cbb5f778c7394dc734ba61790d34872373f8dcf3b98e46d1187cead5e:hns-observer:regtest:01","system","hns-route-renewal-scheduler","hns.owner.v1","4444444444444444444444444444444444444444444444444444444444444444","managed","hns-observer-regtest","hns-observer-config-v1","1111111111111111111111111111111111111111111111111111111111111111","hns-active-lease-renewal-v1","test","hns","jazleeuw","jazleeuw","app.jazleeuw"]',
  );
  expect(await hnsActiveLeaseRenewalRequirementHash(authority)).toBe(
    "ec62613a64bc9ae7f5249a241d5497645d9b7e13649e09b9dd269012ce1eeac7",
  );
  const renewalRequest = await request();
  expect(await hnsActiveLeaseRenewalRequestHash(renewalRequest)).toBe(
    "99a42636962fa1b8d8c18a9f278036bf710384fb66a74ec81a2a0eacd9b8acc1",
  );
  const requestPreimage = hnsActiveLeaseRenewalRequestPreimage(renewalRequest);
  expect(new TextEncoder().encode(requestPreimage).byteLength).toBe(834);
  expect(requestPreimage).toContain('"pirate-hns-active-lease-renewal-request-v1"');
  const encoded = await encodeHnsActiveLeaseRenewalRequest(renewalRequest, authority);
  expect(encoded.byteLength).toBe(1545);
  const decoded = await decodeHnsActiveLeaseRenewalRequestBytes(encoded);
  expect(decoded.request).toEqual(renewalRequest);
});

test("maps a full observer v2 result and reproduces response/evidence/result vectors", async () => {
  const renewalRequest = await request();
  expect(await hnsControlObservationRequestHash(observerRequest)).toBe(
    "0287bb2b7ca00f4798ae89a965c3c23eb2ce8eb8ba82848ecea2f22eee11e5a7",
  );
  expect(observerResultBytes.byteLength).toBe(1272);
  const response = await mapHnsActiveLeaseRenewalObservation({
    request: renewalRequest,
    authority,
    control_identity: resolvedIdentity,
    observer_request: observerRequest,
    observer_result_bytes: observerResultBytes,
    upstream_session_ref: "nvs_01",
    policy: {
      expected_block_interval_seconds: 600,
      minimum_safe_remaining_blocks: 1,
      expiry_safety_blocks: 1,
      evidence_lease_seconds: 2_592_000,
    },
  });
  expect(response.status).toBe("verified");
  if (response.status !== "verified") throw new Error("expected verified response");
  const responseBytes = new TextEncoder().encode(JSON.stringify(response));
  expect(responseBytes.byteLength).toBe(1230);
  const decoded = await decodeHnsActiveLeaseRenewalResponseBytes(responseBytes, {
    request: renewalRequest,
    authority,
    control_identity: persistedIdentity,
    policy: {
      expected_block_interval_seconds: 600,
      minimum_safe_remaining_blocks: 1,
      expiry_safety_blocks: 1,
      evidence_lease_seconds: 2_592_000,
    },
  });
  expect(decoded.response_sha256).toBe(
    "c0ad6369e1a74c0363363b25a26f82dccf63d0226f2a20254ed1bb17762a42de",
  );
  const evidence = await buildHnsActiveLeaseRenewalEvidence({
    request: renewalRequest,
    authority,
    control_identity: persistedIdentity,
    principal_id: authority.principal_id,
    binding_generation: 13,
    policy: {
      expected_block_interval_seconds: 600,
      minimum_safe_remaining_blocks: 1,
      expiry_safety_blocks: 1,
      evidence_lease_seconds: 2_592_000,
    },
    provider_response_bytes: responseBytes,
  });
  expect(evidence.provider_response_sha256).toBe(
    "c0ad6369e1a74c0363363b25a26f82dccf63d0226f2a20254ed1bb17762a42de",
  );
  expect(await hnsActiveLeaseRenewalEvidenceHash(evidence)).toBe(
    "1f8462580b2ef5ca1268c1b078af689a8df2f5fdd5a46b9b9f0df97a67a01218",
  );
  const evidencePreimage = hnsActiveLeaseRenewalEvidencePreimage(evidence);
  expect(new TextEncoder().encode(evidencePreimage).byteLength).toBe(1604);
  expect(evidencePreimage).toContain('"pirate-hns-active-lease-renewal-evidence-v1"');
  const result = {
    active_lease_renewal_id: renewalRequest.active_lease_renewal_id,
    active_lease_renewal_attempt_id: renewalRequest.active_lease_renewal_attempt_id,
    route_binding_id: renewalRequest.route_binding_id,
    expected_binding_generation: renewalRequest.expected_binding_generation,
    idempotency_key: "renewal-01",
    request_hash: renewalRequest.request_hash,
    outcome_status: "verified" as const,
    evidence_ref_or_null: renewalRequest.evidence_ref,
    evidence_digest_or_null: evidence.evidence_digest,
    provider_response_sha256_or_null: evidence.provider_response_sha256,
    ownership_status_or_null: "verified",
    route_lifecycle_status_or_null: "active",
  };
  const resultPreimage = hnsActiveLeaseRenewalResultPreimage(result);
  expect(new TextEncoder().encode(resultPreimage).byteLength).toBe(373);
  expect(resultPreimage).toContain('"pirate-hns-active-lease-renewal-result-v1"');
  expect(await hnsActiveLeaseRenewalResultHash(result)).toBe(
    "db19ebcab90b0bd568d4f82f13e79fe819691baaec99440c0c1f3aca5a81f11d",
  );
  expect(
    classifyHnsActiveLeaseRenewalResponse(
      response,
      authority.expected_control_identity_digest,
      authority.expected_chain_authority_digest,
    ),
  ).toBe("verified");
});

test("requires full request authority, v2 provenance, and strict wire bytes", async () => {
  const renewalRequest = await request();
  const bytes = await encodeHnsActiveLeaseRenewalRequest(renewalRequest, authority);
  await expect(
    decodeHnsActiveLeaseRenewalRequestBytes(
      new TextEncoder().encode(JSON.stringify({ ...renewalRequest, unknown: true })),
    ),
  ).rejects.toThrow();
  await expect(
    decodeHnsActiveLeaseRenewalRequestBytes(
      new TextEncoder().encode(JSON.stringify({ ...renewalRequest, request_hash: "f".repeat(64) })),
    ),
  ).rejects.toThrow();
  expect((await decodeHnsActiveLeaseRenewalRequestBytes(bytes)).request.request_hash).toBe(
    renewalRequest.request_hash,
  );
});

test("rejects route/encoder tampering and validates the complete response context", async () => {
  const { request: renewalRequest, response, context } = await positiveResponse();
  await expect(
    encodeHnsActiveLeaseRenewalRequest(
      {
        ...renewalRequest,
        route: { ...renewalRequest.route, path_segment: "app.forged" },
      },
      authority,
    ),
  ).rejects.toThrow();
  await expect(
    encodeHnsActiveLeaseRenewalRequest(
      { ...renewalRequest, request_hash: "f".repeat(64) },
      authority,
    ),
  ).rejects.toThrow();

  type JsonRecord = Record<string, unknown>;
  const responseObject = JSON.parse(JSON.stringify(response)) as JsonRecord;
  const responseBytes = (value: JsonRecord): Uint8Array =>
    new TextEncoder().encode(JSON.stringify(value));
  await expect(
    decodeHnsActiveLeaseRenewalResponseBytes(
      responseBytes({ ...responseObject, active_lease_renewal_id: "wrong-id" }),
      context,
    ),
  ).rejects.toThrow();
  await expect(
    decodeHnsActiveLeaseRenewalResponseBytes(responseBytes(responseObject), {
      ...context,
      control_identity: {
        ...persistedIdentity,
        expected_txt_value: "forbidden",
      } as HnsActiveLeaseRenewalPersistedControlIdentityV1,
    }),
  ).rejects.toThrow();
  await expect(
    decodeHnsActiveLeaseRenewalResponseBytes(responseBytes(responseObject), {
      ...context,
      control_identity: {
        ...persistedIdentity,
        control_identity_digest: "e".repeat(64),
      },
    }),
  ).rejects.toThrow("does not match renewal request authority");
  await expect(
    mapHnsActiveLeaseRenewalObservation({
      request: renewalRequest,
      authority,
      control_identity: {
        ...resolvedIdentity,
        expected_txt_value: "pirate-verification=wrong",
      },
      observer_request: observerRequest,
      observer_result_bytes: observerResultBytes,
      upstream_session_ref: "nvs_01",
      policy: leasePolicy,
    }),
  ).rejects.toThrow();
  const wrongTime = JSON.parse(JSON.stringify(responseObject)) as JsonRecord;
  (wrongTime.observation as JsonRecord).observed_at = "2026-02-02T03:38:21.000Z";
  await expect(
    decodeHnsActiveLeaseRenewalResponseBytes(responseBytes(wrongTime), context),
  ).rejects.toThrow();
  const wrongRef = JSON.parse(JSON.stringify(responseObject)) as JsonRecord;
  (wrongRef.observation as JsonRecord).provider_evidence_ref =
    `hns-observer-v1:sha256:${"0".repeat(64)}:tampered`;
  await expect(
    decodeHnsActiveLeaseRenewalResponseBytes(responseBytes(wrongRef), context),
  ).rejects.toThrow();

  const providerEvidencePrefix = `hns-observer-v1:sha256:${response.observation.observer_result_sha256}:`;
  const atOuterBound = {
    ...response,
    observation: {
      ...response.observation,
      provider_evidence_ref: `${providerEvidencePrefix}${"a".repeat(424)}`,
    },
  };
  await expect(
    decodeHnsActiveLeaseRenewalResponseBytes(responseBytes(atOuterBound), context),
  ).resolves.toBeDefined();
  const beyondOuterBound = {
    ...response,
    observation: {
      ...response.observation,
      provider_evidence_ref: `${providerEvidencePrefix}${"a".repeat(425)}`,
    },
  };
  await expect(
    decodeHnsActiveLeaseRenewalResponseBytes(responseBytes(beyondOuterBound), context),
  ).rejects.toThrow();
});

test("preserves nullable unavailable hints, rejects oversized hints, and classifies changed authority first", async () => {
  const { request: renewalRequest, response, context } = await positiveResponse();
  const unavailable = {
    version: "pirate-hns-active-lease-renewal-response-v1",
    active_lease_renewal_id: renewalRequest.active_lease_renewal_id,
    active_lease_renewal_attempt_id: renewalRequest.active_lease_renewal_attempt_id,
    request_hash: renewalRequest.request_hash,
    status: "unavailable",
    reason_code: "chain_view_stale",
    retry_after_seconds: null,
    diagnostic_ref: null,
  };
  const unavailableBytes = new TextEncoder().encode(JSON.stringify(unavailable));
  await expect(
    decodeHnsActiveLeaseRenewalResponseBytes(unavailableBytes, context),
  ).resolves.toMatchObject({
    response: { retry_after_seconds: null, diagnostic_ref: null },
  });
  await expect(
    decodeHnsActiveLeaseRenewalResponseBytes(
      new TextEncoder().encode(JSON.stringify({ ...unavailable, retry_after_seconds: 3601 })),
      context,
    ),
  ).rejects.toThrow();

  const changedBoth = { ...response, observation: { ...response.observation } };
  changedBoth.observation.control_identity_digest = "e".repeat(64);
  changedBoth.observation.chain_authority_digest = "d".repeat(64);
  expect(
    classifyHnsActiveLeaseRenewalResponse(
      changedBoth,
      authority.expected_control_identity_digest,
      authority.expected_chain_authority_digest,
    ),
  ).toBe("chain_authority_changed");
  const changedControl = { ...response, observation: { ...response.observation } };
  changedControl.observation.control_identity_digest = "e".repeat(64);
  expect(
    classifyHnsActiveLeaseRenewalResponse(
      changedControl,
      authority.expected_control_identity_digest,
      authority.expected_chain_authority_digest,
    ),
  ).toBe("control_identity_changed");

  const changedChainDigest = "d".repeat(64);
  const changedControlDigest = await hnsControlIdentityDigest({
    ownership_source: observerRequest.ownership_source,
    txt_name: observerRequest.txt_name,
    expected_txt_value: observerRequest.expected_txt_value,
    root_label: observerRequest.root_label,
    chain_authority_digest: changedChainDigest,
  });
  const changedInnerResult = {
    ...observerResult,
    control_identity_digest: changedControlDigest,
    chain_authority_digest: changedChainDigest,
  };
  const changedMapped = await mapHnsActiveLeaseRenewalObservation({
    request: renewalRequest,
    authority,
    control_identity: resolvedIdentity,
    observer_request: observerRequest,
    observer_result_bytes: new TextEncoder().encode(JSON.stringify(changedInnerResult)),
    upstream_session_ref: "nvs_01",
    policy: leasePolicy,
  });
  expect(
    classifyHnsActiveLeaseRenewalResponse(
      changedMapped,
      authority.expected_control_identity_digest,
      authority.expected_chain_authority_digest,
    ),
  ).toBe("chain_authority_changed");
  await expect(
    buildHnsActiveLeaseRenewalEvidence({
      request: renewalRequest,
      authority,
      control_identity: persistedIdentity,
      principal_id: authority.principal_id,
      binding_generation: 13,
      policy: leasePolicy,
      provider_response_bytes: new TextEncoder().encode(JSON.stringify(changedMapped)),
    }),
  ).rejects.toThrow();
});

test("enforces the closed renewal result status matrix", async () => {
  const { request: renewalRequest } = await positiveResponse();
  const base = {
    active_lease_renewal_id: renewalRequest.active_lease_renewal_id,
    active_lease_renewal_attempt_id: renewalRequest.active_lease_renewal_attempt_id,
    route_binding_id: renewalRequest.route_binding_id,
    expected_binding_generation: renewalRequest.expected_binding_generation,
    idempotency_key: "renewal-01",
    request_hash: renewalRequest.request_hash,
  };
  const verified = {
    ...base,
    outcome_status: "verified" as const,
    evidence_ref_or_null: "route_evidence_13",
    evidence_digest_or_null: "1".repeat(64),
    provider_response_sha256_or_null: "2".repeat(64),
    ownership_status_or_null: "verified",
    route_lifecycle_status_or_null: "active",
  };
  expect(() =>
    hnsActiveLeaseRenewalResultPreimage({ ...verified, evidence_ref_or_null: null }),
  ).toThrow();
  expect(() =>
    hnsActiveLeaseRenewalResultPreimage({
      ...base,
      outcome_status: "txt_value_mismatch",
      evidence_ref_or_null: null,
      evidence_digest_or_null: null,
      provider_response_sha256_or_null: "2".repeat(64),
      ownership_status_or_null: "verified",
      route_lifecycle_status_or_null: "suspended",
    }),
  ).toThrow();
  expect(() =>
    hnsActiveLeaseRenewalResultPreimage({
      ...base,
      outcome_status: "stale_cas",
      evidence_ref_or_null: null,
      evidence_digest_or_null: null,
      provider_response_sha256_or_null: null,
      ownership_status_or_null: "disputed",
      route_lifecycle_status_or_null: "suspended",
    }),
  ).toThrow();
  expect(() => hnsActiveLeaseRenewalResultPreimage(verified)).not.toThrow();

  const verifiedV2 = {
    ...verified,
    evidence_digest_or_null: "1f8462580b2ef5ca1268c1b078af689a8df2f5fdd5a46b9b9f0df97a67a01218",
    provider_response_sha256_or_null:
      "c0ad6369e1a74c0363363b25a26f82dccf63d0226f2a20254ed1bb17762a42de",
    ownership_status_or_null: "verified" as const,
    route_lifecycle_status_or_null: "active" as const,
  };
  expect(await hnsActiveLeaseRenewalResultV2Hash(verifiedV2)).toBe(
    "4048060d8bb561799520c49d044771b6bf9c5f8fce6ea28096aeca8c0e57570c",
  );
  const ineligible = {
    ...base,
    outcome_status: "renewal_evidence_ineligible" as const,
    evidence_ref_or_null: null,
    evidence_digest_or_null: null,
    provider_response_sha256_or_null: null,
    ownership_status_or_null: null,
    route_lifecycle_status_or_null: null,
  };
  expect(hnsActiveLeaseRenewalResultV2Preimage(ineligible)).toBe(
    '["pirate-hns-active-lease-renewal-result-v2","hns_renewal_01","hns_renewal_attempt_01","route-binding-1",12,"renewal-01","99a42636962fa1b8d8c18a9f278036bf710384fb66a74ec81a2a0eacd9b8acc1","renewal_evidence_ineligible",null,null,null,null,null]',
  );
  expect(await hnsActiveLeaseRenewalResultV2Hash(ineligible)).toBe(
    "7b161fd190f6b16d946671be09616f4003f1c31e7ea6331478f9a5bdaf9bdffa",
  );
  expect(() =>
    hnsActiveLeaseRenewalResultV2Preimage({
      ...ineligible,
      ownership_status_or_null: "disputed",
    }),
  ).toThrow();
});

test("recovers exact prior control identity only from its hash-pinned snapshot", async () => {
  const current = await request();
  const priorProviderEvidenceRef =
    "hns-observer-v1:sha256:64c057d67f3e452018e384b3fbd89dbc6d64590946e4a4f2ff6106733bb7e622:hns-observer:regtest:renewal-01";
  const withoutHash = {
    ...current,
    prior_provider_evidence_ref: priorProviderEvidenceRef,
    request_hash: "0".repeat(64),
  };
  const renewalRequest = {
    ...withoutHash,
    request_hash: await hnsActiveLeaseRenewalRequestHash(withoutHash),
  };
  await expect(
    resolveHnsActiveLeaseRenewalControlIdentity({
      request: renewalRequest,
      snapshot: {
        snapshot_reference: "hns-observer:regtest:renewal-01",
        request_bytes: new TextEncoder().encode(JSON.stringify(observerRequest)),
        result_bytes: observerResultBytes,
        result_sha256: "64c057d67f3e452018e384b3fbd89dbc6d64590946e4a4f2ff6106733bb7e622",
      },
    }),
  ).resolves.toEqual(resolvedIdentity);
  await expect(
    resolveHnsActiveLeaseRenewalControlIdentity({
      request: renewalRequest,
      snapshot: {
        snapshot_reference: "hns-observer:regtest:other",
        request_bytes: new TextEncoder().encode(JSON.stringify(observerRequest)),
        result_bytes: observerResultBytes,
        result_sha256: "64c057d67f3e452018e384b3fbd89dbc6d64590946e4a4f2ff6106733bb7e622",
      },
    }),
  ).rejects.toThrow("does not match its provider evidence reference");
});

async function operationRequestFor(
  inputAuthority: HnsActiveLeaseRenewalAuthorityV1,
): Promise<HnsOwnerActiveLeaseRenewalRequestV1> {
  const pending: HnsOwnerActiveLeaseRenewalRequestV1 = {
    version: "pirate-hns-active-lease-renewal-request-v1",
    operation_kind: "active_lease_renewal",
    active_lease_renewal_id: "hns_renewal_01",
    active_lease_renewal_attempt_id: "hns_renewal_attempt_01",
    community_id: inputAuthority.community_id,
    route_binding_id: inputAuthority.route_binding_id,
    expected_binding_generation: inputAuthority.expected_binding_generation,
    expected_verified_evidence_ref: inputAuthority.expected_verified_evidence_ref,
    expected_evidence_digest: inputAuthority.expected_evidence_digest,
    expected_control_identity_digest: inputAuthority.expected_control_identity_digest,
    expected_chain_authority_digest: inputAuthority.expected_chain_authority_digest,
    prior_provider_evidence_ref: inputAuthority.prior_provider_evidence_ref,
    attempt_number: 1,
    evidence_ref: "route_evidence_13",
    requirement_hash: await hnsActiveLeaseRenewalRequirementHash(inputAuthority),
    request_hash: "0".repeat(64),
    provider_id: inputAuthority.provider_id,
    provider_binding_hash: inputAuthority.provider_binding_hash,
    provider_configuration: inputAuthority.provider_configuration,
    protocol_version: inputAuthority.protocol_version,
    environment: inputAuthority.environment,
    route: inputAuthority.route,
  };
  return {
    ...pending,
    request_hash: await hnsActiveLeaseRenewalRequestHash(pending),
  };
}

async function operationFixture(
  inputAuthority: HnsActiveLeaseRenewalAuthorityV1,
  provider: HnsActiveLeaseRenewalServices["provider"],
): Promise<
  Readonly<{
    services: HnsActiveLeaseRenewalServices;
    request: HnsOwnerActiveLeaseRenewalRequestV1;
    finalizations: Array<Parameters<HnsActiveLeaseRenewalStore["finalize"]>[0]>;
    releaseCount: () => number;
  }>
> {
  const renewalRequest = await operationRequestFor(inputAuthority);
  let releases = 0;
  let stored: HnsActiveLeaseRenewalStoredOperation = {
    authority: inputAuthority,
    control_identity: persistedIdentity,
    terminal: null,
  };
  const finalizations: Array<Parameters<HnsActiveLeaseRenewalStore["finalize"]>[0]> = [];
  const store: HnsActiveLeaseRenewalStore = {
    resolve: () =>
      Effect.succeed({
        authority: inputAuthority,
        control_identity: persistedIdentity,
      }),
    reserve: (input) => {
      const reservation: HnsActiveLeaseRenewalReservation = {
        stored,
        request: renewalRequest,
        idempotency_key: input.idempotency_key,
        attempt: {
          active_lease_renewal_attempt_id: renewalRequest.active_lease_renewal_attempt_id,
          evidence_ref: renewalRequest.evidence_ref,
          observation_id: "observer-renewal-01",
          fence_token: 1,
          attempt_number: 1,
          database_now: "2026-02-02T04:40:00.000Z",
          lease_expires_at: "2026-02-02T04:40:20.000Z",
        },
      };
      return Effect.succeed({ kind: "acquired", reservation });
    },
    release: () => {
      releases += 1;
      return Effect.succeed({ kind: "released" });
    },
    finalize: (input) =>
      Effect.promise(async () => {
        finalizations.push(input);
        stored = {
          ...stored,
          terminal: {
            result: input.result,
            result_hash: await hnsActiveLeaseRenewalTerminalResultHash(input.result),
          },
        };
        return { kind: "committed", stored } as const;
      }),
  };
  return {
    services: {
      store,
      provider,
      policy: leasePolicy,
      ids: {
        renewal: () => renewalRequest.active_lease_renewal_id,
        attempt: () => renewalRequest.active_lease_renewal_attempt_id,
        evidence: () => renewalRequest.evidence_ref,
        observation: () => "observer-renewal-01",
      },
    },
    request: renewalRequest,
    finalizations,
    releaseCount: () => releases,
  };
}

test("runs a verified active lease renewal through exact provider bytes", async () => {
  const positive = await positiveResponse();
  const responseBytes = new TextEncoder().encode(JSON.stringify(positive.response));
  const fixture = await operationFixture(authority, {
    renew: () => Effect.succeed(responseBytes),
  });

  const result = await Effect.runPromise(
    runHnsActiveLeaseRenewal(
      { route_binding_id: authority.route_binding_id, idempotency_key: "renewal-operation-01" },
      fixture.services,
    ),
  );

  expect(result).toMatchObject({ status: "verified", outcome_status: "verified", replayed: false });
  expect(fixture.releaseCount()).toBe(0);
  expect(fixture.finalizations).toHaveLength(1);
  expect(fixture.finalizations[0]?.evidence).not.toBeNull();
  expect(fixture.finalizations[0]?.provider_response_bytes).toEqual(responseBytes);
});

test("retains exact source-ineligible bytes and binds them to the renewal request", async () => {
  const v2Authority: HnsActiveLeaseRenewalAuthorityV1 = {
    ...authority,
    provider_configuration: {
      ...authority.provider_configuration,
      version: "hns-observer-config-v2",
    },
  };
  const requestV2 = await operationRequestFor(v2Authority);
  const responseBytes = await encodeHnsActiveLeaseRenewalIneligibleResponseV2({
    version: "pirate-hns-active-lease-renewal-response-v2",
    active_lease_renewal_id: requestV2.active_lease_renewal_id,
    active_lease_renewal_attempt_id: requestV2.active_lease_renewal_attempt_id,
    request_hash: requestV2.request_hash,
    status: "ineligible",
    reason_code: "owner_authoritative_source_ineligible",
    observer_snapshot_sha256: "a".repeat(64),
    observer_result_sha256: "b".repeat(64),
    diagnostic_ref: "hns-observer:test:source-ineligible-01",
  });
  const fixture = await operationFixture(v2Authority, {
    renew: () => Effect.succeed(responseBytes),
  });

  const result = await Effect.runPromise(
    runHnsActiveLeaseRenewal(
      { route_binding_id: authority.route_binding_id, idempotency_key: "renewal-operation-02" },
      fixture.services,
    ),
  );

  expect(result).toMatchObject({
    status: "ineligible",
    outcome_status: "owner_authoritative_source_ineligible",
  });
  expect(fixture.finalizations[0]?.evidence).toBeNull();
  expect(fixture.finalizations[0]?.provider_response_bytes).toEqual(responseBytes);

  const mismatchedBytes = await encodeHnsActiveLeaseRenewalIneligibleResponseV2({
    version: "pirate-hns-active-lease-renewal-response-v2",
    active_lease_renewal_id: requestV2.active_lease_renewal_id,
    active_lease_renewal_attempt_id: requestV2.active_lease_renewal_attempt_id,
    request_hash: "f".repeat(64),
    status: "ineligible",
    reason_code: "owner_authoritative_source_ineligible",
    observer_snapshot_sha256: "a".repeat(64),
    observer_result_sha256: "b".repeat(64),
    diagnostic_ref: "hns-observer:test:source-ineligible-02",
  });
  const mismatch = await operationFixture(v2Authority, {
    renew: () => Effect.succeed(mismatchedBytes),
  });
  await expect(
    Effect.runPromise(
      runHnsActiveLeaseRenewal(
        { route_binding_id: authority.route_binding_id, idempotency_key: "renewal-operation-03" },
        mismatch.services,
      ),
    ),
  ).rejects.toEqual(new HnsActiveLeaseRenewalProviderFailed({ reason: "invalid_response" }));
  expect(mismatch.releaseCount()).toBe(1);
  expect(mismatch.finalizations).toHaveLength(0);
});

test("releases inventory-unavailable observations without consuming an attempt", async () => {
  const renewalRequest = await operationRequestFor(authority);
  const unavailableBytes = new TextEncoder().encode(
    JSON.stringify({
      version: "pirate-hns-active-lease-renewal-response-v1",
      active_lease_renewal_id: renewalRequest.active_lease_renewal_id,
      active_lease_renewal_attempt_id: renewalRequest.active_lease_renewal_attempt_id,
      request_hash: renewalRequest.request_hash,
      status: "unavailable",
      reason_code: "authority_inventory_unavailable",
      retry_after_seconds: 30,
      diagnostic_ref: "hns-observer:test:inventory-unavailable-01",
    }),
  );
  const fixture = await operationFixture(authority, {
    renew: () => Effect.succeed(unavailableBytes),
  });

  await expect(
    Effect.runPromise(
      runHnsActiveLeaseRenewal(
        { route_binding_id: authority.route_binding_id, idempotency_key: "renewal-operation-04" },
        fixture.services,
      ),
    ),
  ).rejects.toEqual(new HnsActiveLeaseRenewalProviderFailed({ reason: "unavailable" }));
  expect(fixture.releaseCount()).toBe(1);
  expect(fixture.finalizations).toHaveLength(0);
});

test("finalizes prior-evidence ineligibility without calling a hidden retry path", async () => {
  let providerCalls = 0;
  const fixture = await operationFixture(authority, {
    renew: () => {
      providerCalls += 1;
      return Effect.fail(
        new HnsActiveLeaseRenewalProviderFailed({ reason: "renewal_evidence_ineligible" }),
      );
    },
  });

  const result = await Effect.runPromise(
    runHnsActiveLeaseRenewal(
      { route_binding_id: authority.route_binding_id, idempotency_key: "renewal-operation-05" },
      fixture.services,
    ),
  );

  expect(result).toMatchObject({
    status: "unchanged",
    outcome_status: "renewal_evidence_ineligible",
  });
  expect(providerCalls).toBe(1);
  expect(fixture.releaseCount()).toBe(0);
  expect(fixture.finalizations[0]).toMatchObject({
    evidence: null,
    provider_response_bytes: null,
  });
});

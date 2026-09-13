import { describe, expect, test } from "bun:test";
import type { HnsChainObservationResultV1 } from "@pirate/application/namespace-ownership";
import {
  decodeHnsRootImportReadinessResultV1,
  HNS_ROOT_READINESS_OBSERVATION_REQUEST_VERSION,
} from "@pirate/application/namespace-ownership";
import {
  canonicalJson,
  decideHnsRootImportLifecycleBatchV1,
  decideHnsRootImportLifecycleV1,
  HNS_ROOT_IMPORT_POLICY_V1,
  initialHnsRootImportLifecycleStateV1,
} from "@pirate/domain";
import { HnsRootReadinessObservationError, observeHnsRootReadinessV1 } from "./observe-root.ts";
import {
  HNS_AUTHORITY_PROVISION_REQUEST_VERSION,
  type HnsAuthorityZoneResult,
  provisionHnsAuthorityRootV1,
} from "./provision-root.ts";

const encoder = new TextEncoder();
const now = Date.parse("2026-09-01T06:00:00.000Z");

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function observedCurrent(records: readonly unknown[]): HnsChainObservationResultV1 {
  return {
    kind: "observed",
    observation: {
      view: "current",
      network: "main",
      genesis_block_hash: `${"0".repeat(63)}1`,
      anchor: {
        network: "main",
        genesis_block_hash: `${"0".repeat(63)}1`,
        height: 812_345,
        best_block_hash: "aa".repeat(32),
        median_time_past_epoch_seconds: 1_770_000_000,
        header_time_epoch_seconds: 1_770_000_030,
        confirmations: 1,
      },
      tip_height: 812_345,
      update_inclusion_height: 800_000,
      commitment: null,
      observed_at_epoch_ms: 1_770_000_060_000,
      records: structuredClone(records) as never,
      resource_sha256: "1".repeat(64),
    },
  };
}

async function fixture() {
  const managedZoneBytes = encoder.encode(
    canonicalJson({ root_label: "newroot", serial: 7, managed: true }),
  );
  const zone: HnsAuthorityZoneResult = {
    created: true,
    dnssec: true,
    serial: 7,
    ds_records: [
      { key_tag: 10_875, algorithm: 13, digest_type: 2, digest: "a".repeat(64) },
      { key_tag: 10_875, algorithm: 13, digest_type: 4, digest: "b".repeat(96) },
    ],
    managed_rrset_sha256: await sha256(managedZoneBytes),
    managed_zone_bytes: managedZoneBytes,
    shared_tlsa_profile_sha256: "c".repeat(64),
    gateway_ipv4: "192.0.2.10",
    gateway_deployment_reference: "gateway-deployment-v1",
    gateway_certificate_spki_sha256: "d".repeat(64),
    ttl_seconds: 300,
  };
  const provision = await provisionHnsAuthorityRootV1(
    {
      version: HNS_AUTHORITY_PROVISION_REQUEST_VERSION,
      root_import_session_id: "root-import-session",
      namespace_session_id: "namespace-session",
      root_label: "newroot",
      challenge_txt_value: "pirate-verification=challenge",
      expires_at: "2099-01-01T00:00:00.000Z",
    },
    {
      observe_current_resource: async () => observedCurrent([{ type: "TXT", txt: ["preserved"] }]),
      ensure_zone: async () => zone,
    },
  );
  const plan = JSON.parse(new TextDecoder().decode(provision.publish_plan_bytes)) as {
    readonly replacement_records: readonly unknown[];
  };
  const observedZoneSha256 = await sha256(managedZoneBytes);
  const authorityView = (ordinal: 1 | 2) => ({
    authority_nameserver: `ns${ordinal}.pirate`,
    authority_address_family: "GLUE4" as const,
    authority_address: `192.0.2.${String(52 + ordinal)}`,
    dnssec_validation: "secure" as const,
    challenge_present: true as const,
    validated_dnskey_response_sha256: ordinal === 1 ? "1".repeat(64) : "2".repeat(64),
    validated_control_response_sha256: ordinal === 1 ? "3".repeat(64) : "4".repeat(64),
    validated_chain_authority_digest: "5".repeat(64),
    observed_zone_bytes: managedZoneBytes,
    observed_zone_sha256: observedZoneSha256,
  });
  const live = {
    authority_views: [authorityView(1), authorityView(2)],
    gateway: {
      normalized_host: "app.newroot",
      gateway_address: "192.0.2.10",
      certificate_spki_sha256: "d".repeat(64),
      http_status: 421 as const,
    },
  } as const;
  return {
    zone,
    provision,
    plan,
    live,
    request: {
      version: HNS_ROOT_READINESS_OBSERVATION_REQUEST_VERSION,
      root_import_session_id: "root-import-session",
      namespace_session_id: "namespace-session",
      root_label: "newroot",
      challenge_txt_value: "pirate-verification=challenge",
      ownership_result_sha256: "e".repeat(64),
      publish_plan_sha256: provision.publish_plan_sha256,
      provision_result_sha256: provision.result_sha256,
      expires_at: "2099-01-01T00:00:00.000Z",
    } as const,
  };
}

describe("HNS root readiness observation", () => {
  test("retains exact chain, signed-zone, shared TLSA, and bounded inventory evidence", async () => {
    const state = await fixture();
    let reconciledZone = false;
    const observed = await observeHnsRootReadinessV1({
      observation_attempt: { job_id: "observation-job", executor_id: "executor", lease_fence: 1 },
      operation_kind: "observe_root_v1",
      request: state.request,
      publish_plan_bytes: state.provision.publish_plan_bytes,
      provision_result_bytes: state.provision.result_bytes,
      ports: {
        observe_current_resource: async () =>
          observedCurrent([...state.plan.replacement_records].reverse()),
        reconcile_zone: async (input) => {
          expect(input).toEqual({
            root_label: "newroot",
            challenge_txt_value: "pirate-verification=challenge",
            expected_ds_records: state.zone.ds_records,
            mutation_lease: {
              job_id: "observation-job",
              executor_id: "executor",
              lease_fence: 1,
            },
          });
          reconciledZone = true;
        },
        inspect_zone: async () => ({ ...state.zone, created: false }),
        observe_live: async () => state.live,
      },
      config: {
        environment: "test",
        valid_for_seconds: 86_400,
        now: () => Date.parse("2026-09-01T06:00:00.000Z"),
      },
    });
    const decoded = await decodeHnsRootImportReadinessResultV1(observed.result_bytes);
    expect(reconciledZone).toBe(true);
    expect(decoded.result).toMatchObject({
      root_label: "newroot",
      powerdns_zone_serial: 7,
      gateway_deployment_reference: "gateway-deployment-v1",
      gateway_http_status: 421,
      delegation_matches: true,
      ds_authenticates_zone: true,
      retained_zone_digest_matches: true,
      gateway_healthy: true,
      valid_until: "2026-09-02T06:00:00.000Z",
    });
    expect(decoded.managed_zone_bytes).toEqual(state.zone.managed_zone_bytes);
    expect(decoded.authority_inventory.dns_write_capabilities).toEqual([
      {
        capability_reference: "pdns-zone:newroot",
        scope_kind: "exact_root",
        root_label: "newroot",
        active: true,
      },
    ]);
  });

  test("versions distinguish renewal attempts and evidence while exact observation replay is stable", async () => {
    const state = await fixture();
    async function observe(fence: number, now: number, validFor = 604_800) {
      return observeHnsRootReadinessV1({
        observation_attempt: {
          job_id: "recurring-renewal-job",
          executor_id: "executor",
          lease_fence: fence,
        },
        operation_kind: "renew_health_v1",
        request: state.request,
        publish_plan_bytes: state.provision.publish_plan_bytes,
        provision_result_bytes: state.provision.result_bytes,
        ports: {
          observe_current_resource: async () => observedCurrent(state.plan.replacement_records),
          reconcile_zone: async () => {},
          inspect_zone: async () => ({ ...state.zone, created: false }),
          observe_live: async () => state.live,
        },
        config: { environment: "test", valid_for_seconds: validFor, now: () => now },
      });
    }
    const now = Date.parse("2026-09-05T06:00:00.000Z");
    const first = await observe(1, now);
    const replay = await observe(1, now);
    expect(replay).toEqual(first);
    const version = async (result: typeof first) =>
      (await decodeHnsRootImportReadinessResultV1(result.result_bytes)).result
        .authority_inventory_version;
    expect(await version(await observe(2, now))).not.toBe(await version(first));
    expect(await version(await observe(1, now + 1_000))).not.toBe(await version(first));
    // Spec 012, September 5 erratum: seven days is the ceiling, not a soak.
    expect(
      (await decodeHnsRootImportReadinessResultV1(first.result_bytes)).result.valid_until,
    ).toBe("2026-09-12T06:00:00.000Z");
    await expect(observe(1, now, 604_801)).rejects.toThrow();
  });

  /** Drop every record of one type from a decoded plan's replacement list. */
  const withoutType = (records: readonly unknown[], type: string): readonly unknown[] =>
    records.filter((record) => (record as { readonly type?: unknown }).type !== type);

  test("renewal accepts unrelated TXT drift while holding NS and DS continuity", async () => {
    const state = await fixture();
    async function renew(records: readonly unknown[]) {
      return observeHnsRootReadinessV1({
        observation_attempt: { job_id: "renewal-drift", executor_id: "executor", lease_fence: 1 },
        operation_kind: "renew_health_v1",
        request: state.request,
        publish_plan_bytes: state.provision.publish_plan_bytes,
        provision_result_bytes: state.provision.result_bytes,
        ports: {
          observe_current_resource: async () => observedCurrent(records),
          reconcile_zone: async () => {},
          inspect_zone: async () => ({ ...state.zone, created: false }),
          observe_live: async () => state.live,
        },
        config: {
          environment: "test",
          valid_for_seconds: 604_800,
          now: () => Date.parse("2026-09-05T06:00:00.000Z"),
        },
      });
    }

    // The owner adds a record of their own after activation. Their NS and DS
    // still delegate to us, so authority is intact and renewal must proceed:
    // an unrelated TXT is not a loss of control.
    const drifted = [
      ...state.plan.replacement_records,
      { type: "TXT", txt: ["owner-added-after-activation=1"] },
    ];
    const renewed = await renew(drifted);
    const decoded = await decodeHnsRootImportReadinessResultV1(renewed.result_bytes);
    expect(decoded.result.root_label).toBe(state.request.root_label);

    // Grant and generation continuity: renewal reports the same authority
    // identity it was issued against, so a renewal cannot quietly migrate an
    // operation onto different infrastructure.
    const baseline = await decodeHnsRootImportReadinessResultV1(
      (await renew(state.plan.replacement_records)).result_bytes,
    );
    expect(decoded.result.ds_records).toEqual(baseline.result.ds_records);
    expect(decoded.result.authority_inventory_version).toBeDefined();

    // Losing the delegation itself is a different matter and must not renew.
    await expect(renew(withoutType(state.plan.replacement_records, "NS"))).rejects.toThrow();
    await expect(renew(withoutType(state.plan.replacement_records, "DS"))).rejects.toThrow();
  });

  test("reports owner-update pending without inspecting authority", async () => {
    const state = await fixture();
    let inspectedZone = false;
    let reconciledZone = false;
    await expect(
      observeHnsRootReadinessV1({
        observation_attempt: { job_id: "observation-job", executor_id: "executor", lease_fence: 1 },
        operation_kind: "observe_root_v1",
        request: state.request,
        publish_plan_bytes: state.provision.publish_plan_bytes,
        provision_result_bytes: state.provision.result_bytes,
        ports: {
          observe_current_resource: async () => observedCurrent([{ type: "TXT", txt: ["old"] }]),
          reconcile_zone: async () => {
            reconciledZone = true;
          },
          inspect_zone: async () => {
            inspectedZone = true;
            return state.zone;
          },
          observe_live: async () => state.live,
        },
        config: { environment: "test", valid_for_seconds: 86_400 },
      }),
    ).rejects.toEqual(new HnsRootReadinessObservationError("owner_update_pending"));
    expect(reconciledZone).toBe(false);
    expect(inspectedZone).toBe(false);
  });

  test("refuses forged health facts and mismatched authority-zone evidence", async () => {
    const state = await fixture();
    const observed = await observeHnsRootReadinessV1({
      observation_attempt: { job_id: "observation-job", executor_id: "executor", lease_fence: 1 },
      operation_kind: "observe_root_v1",
      request: state.request,
      publish_plan_bytes: state.provision.publish_plan_bytes,
      provision_result_bytes: state.provision.result_bytes,
      ports: {
        observe_current_resource: async () => observedCurrent(state.plan.replacement_records),
        reconcile_zone: async () => {},
        inspect_zone: async () => ({ ...state.zone, created: false }),
        observe_live: async () => state.live,
      },
      config: {
        environment: "test",
        valid_for_seconds: 86_400,
        now: () => Date.parse("2026-09-01T06:00:00.000Z"),
      },
    });
    const forgedFacts = JSON.parse(new TextDecoder().decode(observed.result_bytes)) as Record<
      string,
      unknown
    >;
    forgedFacts.gateway_healthy = false;
    await expect(
      decodeHnsRootImportReadinessResultV1(encoder.encode(canonicalJson(forgedFacts))),
    ).rejects.toBeInstanceOf(TypeError);

    const mismatchedViews = JSON.parse(new TextDecoder().decode(observed.result_bytes)) as {
      authority_views: Array<Record<string, unknown>>;
    };
    if (mismatchedViews.authority_views[1] !== undefined) {
      mismatchedViews.authority_views[1].observed_zone_sha256 = "f".repeat(64);
    }
    await expect(
      decodeHnsRootImportReadinessResultV1(encoder.encode(canonicalJson(mismatchedViews))),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test("separates the publication, finality, and readiness clocks (T06)", async () => {
    const state = await fixture();
    const ports = {
      observe_current_resource: async () => observedCurrent(state.plan.replacement_records),
      reconcile_zone: async () => {},
      inspect_zone: async () => ({ ...state.zone, created: false }),
      observe_live: async () => state.live,
    };
    const request = { ...state.request, expires_at: "2026-09-07T06:00:00.000Z" };

    // Publication expiry after timely observed inclusion leaves the
    // finality window open: the old single expiry would have torn the
    // session down at expires_at; the separated clocks keep observing.
    const inclusionAt = Date.parse("2026-09-06T00:00:00.000Z");
    const lifecycle = decideHnsRootImportLifecycleBatchV1(
      {
        ...initialHnsRootImportLifecycleStateV1(1),
        phase: "awaiting_publication",
        revision: 2,
        plan_exposed_at_epoch_ms: inclusionAt - 43_200_000,
        publication_deadline_at_epoch_ms:
          inclusionAt - 43_200_000 + HNS_ROOT_IMPORT_POLICY_V1.publication_window_seconds * 1_000,
      },
      [
        {
          event_id: "inclusion",
          occurred_at_epoch_ms: inclusionAt,
          event: "current_observation",
          qualifying: true,
          mismatch: false,
          resource_sha256: "a".repeat(64),
        },
        {
          event_id: "publication-deadline",
          occurred_at_epoch_ms: inclusionAt + 10 * 86_400_000,
          event: "deadline_reached",
          deadline: "publication",
        },
      ],
    );
    expect(lifecycle[0]?.next_state?.phase).toBe("waiting_safe_commitment");
    expect(lifecycle[1]?.outcome).toEqual({ kind: "rejection", reason: "no_active_window" });

    // The readiness observation itself still runs far past the old
    // expires_at: the transport-level gate is not the import clock.
    const pastOldExpiry = await observeHnsRootReadinessV1({
      observation_attempt: { job_id: "observation-job", executor_id: "executor", lease_fence: 1 },
      operation_kind: "observe_root_v1",
      request,
      publish_plan_bytes: state.provision.publish_plan_bytes,
      provision_result_bytes: state.provision.result_bytes,
      ports,
      config: {
        environment: "test",
        valid_for_seconds: 86_400,
        now: () => Date.parse("2026-09-08T06:00:00.000Z"),
      },
    });
    expect(pastOldExpiry.result_bytes.byteLength).toBeGreaterThan(0);

    // Finality exhaustion enters recovery and retains authority.
    const finalityDeadline = lifecycle[0]?.next_state?.finality_deadline_at_epoch_ms ?? 0;
    const exhausted = decideHnsRootImportLifecycleV1(
      { ...(lifecycle[0]?.next_state ?? initialHnsRootImportLifecycleStateV1(1)) },
      {
        event_id: "finality-deadline",
        occurred_at_epoch_ms: finalityDeadline,
        event: "deadline_reached",
        deadline: "finality",
      },
    );
    expect(exhausted.next_state?.phase).toBe("recovery_required");
    expect(exhausted.next_state?.pending_reason).toBe("finality_deadline_reached");

    // Unauthorized late activation: activation is rejected outside ready.
    const unauthorized = decideHnsRootImportLifecycleV1(
      exhausted.next_state ?? initialHnsRootImportLifecycleStateV1(1),
      {
        event_id: "late-activation",
        occurred_at_epoch_ms: finalityDeadline,
        event: "activation_requested",
      },
    );
    expect(unauthorized.outcome).toEqual({
      kind: "rejection",
      reason: "activation_not_permitted_in_phase",
    });

    // Activated-root renewal is governed by its own evidence policy, not
    // the import clocks: the renewal observation succeeds with unrelated
    // TXT drift accepted by the readiness comparison of the current zone.
    const renewal = await observeHnsRootReadinessV1({
      observation_attempt: { job_id: "renewal-job", executor_id: "executor", lease_fence: 1 },
      operation_kind: "renew_health_v1",
      request,
      publish_plan_bytes: state.provision.publish_plan_bytes,
      provision_result_bytes: state.provision.result_bytes,
      ports: {
        ...ports,
        observe_current_resource: async () =>
          observedCurrent([
            ...state.plan.replacement_records,
            { type: "TXT", txt: ["unrelated-drift=new-value"] },
          ]),
      },
      config: {
        environment: "test",
        valid_for_seconds: 86_400,
        now: () => Date.parse("2026-09-08T07:00:00.000Z"),
      },
    });
    const renewalDecoded = await decodeHnsRootImportReadinessResultV1(renewal.result_bytes);
    expect(renewalDecoded.result.observed_at).toBe("2026-09-08T07:00:00.000Z");
  });

  test("holds more than twenty pending observations open with mismatch classification (T06)", async () => {
    let current: ReturnType<typeof initialHnsRootImportLifecycleStateV1> = {
      ...initialHnsRootImportLifecycleStateV1(1),
      phase: "checking_publication",
      revision: 2,
      plan_exposed_at_epoch_ms: now - 86_400_000,
      publication_deadline_at_epoch_ms:
        now - 86_400_000 + HNS_ROOT_IMPORT_POLICY_V1.publication_window_seconds * 1_000,
      applied_event_ids: new Set<string>(),
    };
    // Twenty-one consecutive mismatching observations: each is a pending
    // hold with a scheduled next check and a typed classification — the
    // old single expiry stopped observing after its bounded budget.
    for (let index = 1; index <= 21; index += 1) {
      const decision = decideHnsRootImportLifecycleV1(current, {
        event_id: `mismatch-${index}`,
        occurred_at_epoch_ms: now + index * 900_000,
        event: "current_observation",
        qualifying: false,
        mismatch: true,
        resource_sha256: "b".repeat(64),
      });
      expect(decision.outcome.kind).toBe("pending");
      if (decision.outcome.kind !== "pending") throw new Error("unreachable");
      expect(decision.outcome.reason).toBe("resource_mismatch_hold");
      expect(decision.next_state?.phase).toBe("checking_publication");
      expect(decision.next_state?.next_check_at_epoch_ms).not.toBeNull();
      current = { ...(decision.next_state ?? current), applied_event_ids: new Set<string>() };
    }
    // The operational-failure budget is tracked separately: an unrelated
    // provider failure in the same window still has a full budget.
    const providerFailure = decideHnsRootImportLifecycleV1(current, {
      event_id: "failure-1",
      occurred_at_epoch_ms: now + 22 * 900_000,
      event: "provider_failure",
      classification: "transport_failure",
      budget_exempt: false,
    });
    expect(providerFailure.next_state?.consecutive_operational_failures).toBe(1);
    expect(providerFailure.next_state?.phase).toBe("checking_publication");
  });
});

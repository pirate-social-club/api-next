import { describe, expect, test } from "bun:test";
import type { HnsChainObservationResultV1 } from "@pirate/application/namespace-ownership";
import { canonicalJson } from "@pirate/domain";
import {
  type HnsTeardownRetentionPorts,
  runHnsAuthorityProvisionExecutorOnce,
} from "./executor.ts";
import type {
  HnsRootObservationFinalizeInput,
  HnsRootObservationQueue,
} from "./observation-queue.ts";
import {
  HNS_AUTHORITY_NAMESERVERS,
  HNS_AUTHORITY_PROVISION_REQUEST_VERSION,
  HNS_AUTHORITY_PROVISION_RESULT_VERSION,
} from "./provision-root.ts";
import type { HnsAuthorityProvisionFinalizeInput, HnsAuthorityProvisionQueue } from "./queue.ts";

const encoder = new TextEncoder();

function retentionPorts(
  options: {
    readonly currentDigest?: string | null;
    readonly safeDigest?: string | null;
    readonly unavailable?: "current" | "safe" | "both" | null;
    readonly retirementAuthorized?: boolean;
    readonly records?: readonly unknown[];
  } = {},
): HnsTeardownRetentionPorts {
  const observed = (view: "current" | "safe", digest: string | null) => ({
    kind: "observed" as const,
    observation: {
      view,
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
      records: (options.records ?? []) as never,
      resource_sha256: digest ?? `${view === "current" ? "1" : "2"}${"0".repeat(63)}`,
    },
  });
  return {
    observe_chain: async (_rootLabel, view) => {
      if (options.unavailable === "both" || options.unavailable === view) {
        return {
          kind: "unavailable" as const,
          classification: "transport_failure" as const,
        };
      }
      return view === "current"
        ? observed("current", options.currentDigest ?? null)
        : observed("safe", options.safeDigest ?? null);
    },
    retirement_authorization: async () =>
      options.retirementAuthorized === true
        ? { kind: "retention_review" as const, recorded_at_epoch_ms: 0, evidence_ref: "review-1" }
        : null,
  };
}

function observedCurrent(records: readonly unknown[] = []): HnsChainObservationResultV1 {
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

async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fixture(requestHash?: string): Promise<{
  readonly queue: HnsAuthorityProvisionQueue;
  readonly finalized: () => HnsAuthorityProvisionFinalizeInput | undefined;
}> {
  const requestBytes = encoder.encode(
    canonicalJson({
      version: HNS_AUTHORITY_PROVISION_REQUEST_VERSION,
      root_import_session_id: "root-import-session",
      namespace_session_id: "namespace-session",
      root_label: "newroot",
      challenge_txt_value: "pirate-verification=challenge",
      expires_at: "2099-01-01T00:00:00.000Z",
    }),
  );
  let finalizeInput: HnsAuthorityProvisionFinalizeInput | undefined;
  return {
    queue: {
      claim: async () => ({
        provision_job_id: "provision-job",
        root_import_session_id: "root-import-session",
        operation_kind: "provision_root_v1",
        request_bytes: requestBytes,
        request_sha256: requestHash ?? (await hash(requestBytes)),
        lease_fence: 1,
      }),
      finalize: async (input) => {
        finalizeInput = input;
        return {
          outcome: input.outcome,
          root_import_session_id: "root-import-session",
          session_revision: 2,
        };
      },
    },
    finalized: () => finalizeInput,
  };
}

describe("HNS authority provision executor", () => {
  test("claims one job and finalizes its bounded provisioning result", async () => {
    const state = await fixture();
    const managedZoneBytes = new TextEncoder().encode("managed-zone");
    const result = await runHnsAuthorityProvisionExecutorOnce({
      executor_id: "executor-1",
      queue: state.queue,
      provision: {
        observe_current_resource: async () => observedCurrent(),
        ensure_zone: async () => ({
          created: true,
          dnssec: true,
          serial: 1,
          ds_records: [
            { key_tag: 1, algorithm: 13, digest_type: 2, digest: "a".repeat(64) },
            { key_tag: 1, algorithm: 13, digest_type: 4, digest: "b".repeat(96) },
          ],
          managed_rrset_sha256: await hash(managedZoneBytes),
          managed_zone_bytes: managedZoneBytes,
          shared_tlsa_profile_sha256: "d".repeat(64),
          gateway_ipv4: "192.0.2.10",
          gateway_deployment_reference: "gateway-deployment-v1",
          gateway_certificate_spki_sha256: "e".repeat(64),
          ttl_seconds: 300,
        }),
      },
    });
    expect(result.outcome).toBe("completed");
    expect(state.finalized()).toMatchObject({ outcome: "completed", lease_fence: 1 });
  });

  test("rejects a changed retained request before external mutation", async () => {
    const state = await fixture("f".repeat(64));
    let mutated = false;
    const result = await runHnsAuthorityProvisionExecutorOnce({
      executor_id: "executor-1",
      queue: state.queue,
      provision: {
        observe_current_resource: async () => {
          mutated = true;
          return observedCurrent();
        },
        ensure_zone: async () => {
          throw new Error("not used");
        },
      },
    });
    expect(mutated).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(state.finalized()).toMatchObject({ outcome: "failed", failure_code: "invalid_request" });
  });

  test("retries a transient authority failure inside the fenced job", async () => {
    const state = await fixture();
    const result = await runHnsAuthorityProvisionExecutorOnce({
      executor_id: "executor-1",
      queue: state.queue,
      provision: {
        observe_current_resource: async () => observedCurrent(),
        ensure_zone: async () => {
          throw new Error("temporary PowerDNS outage");
        },
      },
    });
    expect(result.outcome).toBe("retry");
    expect(state.finalized()).toMatchObject({
      outcome: "retry",
      failure_code: "authority_unavailable",
    });
  });

  test.each([false, true])(
    "teardown finalization preserves ambiguous outcomes (%s)",
    async (ambiguous) => {
      const requestBytes = encoder.encode('{"teardown":true}');
      const publishPlanBytes = encoder.encode('{"plan":true}');
      const provisionResultBytes = encoder.encode(
        canonicalJson({
          version: HNS_AUTHORITY_PROVISION_RESULT_VERSION,
          root_import_session_id: "root-import-session",
          root_label: "newroot",
          nameservers: HNS_AUTHORITY_NAMESERVERS,
          zone_created: true,
          zone_dnssec: true,
          zone_serial: 1,
          ds_records: [
            { key_tag: 1, algorithm: 13, digest_type: 2, digest: "a".repeat(64) },
            { key_tag: 1, algorithm: 13, digest_type: 4, digest: "b".repeat(96) },
          ],
          managed_rrset_sha256: "c".repeat(64),
          shared_tlsa_profile_sha256: "d".repeat(64),
          gateway_ipv4: "192.0.2.10",
          gateway_deployment_reference: "gateway-deployment-v1",
          gateway_certificate_spki_sha256: "e".repeat(64),
          ttl_seconds: 300,
        }),
      );
      let finalized: unknown;
      let finalizations = 0;
      const observationQueue: HnsRootObservationQueue = {
        claim: async () => ({
          observation_job_id: "observation-job",
          root_import_session_id: "root-import-session",
          operation_kind: "teardown_root_v1",
          request_bytes: requestBytes,
          request_sha256: await hash(requestBytes),
          publish_plan_bytes: publishPlanBytes,
          publish_plan_sha256: await hash(publishPlanBytes),
          provision_result_bytes: provisionResultBytes,
          provision_result_sha256: await hash(provisionResultBytes),
          lease_fence: 2,
        }),
        finalize: async (input) => {
          finalized = input;
          finalizations += 1;
          if (ambiguous) throw new Error("commit acknowledgement lost");
          return {
            outcome: "failed",
            root_import_session_id: "root-import-session",
            session_revision: 5,
          };
        },
      };
      const removed: string[] = [];
      const result = runHnsAuthorityProvisionExecutorOnce({
        executor_id: "executor-1",
        queue: { claim: async () => null, finalize: async () => Promise.reject() },
        provision: {} as never,
        observation: {
          queue: observationQueue,
          observe: {} as never,
          teardown_zone: async ({ root_label }) => {
            removed.push(root_label);
          },
          retention: retentionPorts({ retirementAuthorized: true }),
          config: { environment: "test", valid_for_seconds: 300 },
        },
      });
      if (ambiguous) await expect(result).rejects.toThrow("commit acknowledgement lost");
      else expect((await result).outcome).toBe("failed");
      expect(finalizations).toBe(1);
      expect(removed).toEqual(["newroot"]);
      expect(finalized).toMatchObject({
        outcome: "failed",
        operation_kind: "teardown_root_v1",
        failure_code: "session_expired",
        lease_fence: 2,
      });
    },
  );
});

for (const corruptRequest of [false, true]) {
  test(
    corruptRequest
      ? "terminally refuses changed renewal evidence"
      : "retries an unclassified renewal exception on its first attempt",
    async () => {
      const publishPlanBytes = encoder.encode("retained-plan");
      const provisionResultBytes = encoder.encode("retained-provision");
      const planHash = await hash(publishPlanBytes);
      const provisionHash = await hash(provisionResultBytes);
      const requestBytes = encoder.encode(
        canonicalJson({
          version: "pirate-hns-root-readiness-observation-request-v1",
          root_import_session_id: "root-import-session",
          namespace_session_id: "namespace-session",
          root_label: "newroot",
          challenge_txt_value: "pirate-verification=challenge",
          ownership_result_sha256: "a".repeat(64),
          publish_plan_sha256: planHash,
          provision_result_sha256: provisionHash,
          expires_at: "2099-01-01T00:00:00.000Z",
        }),
      );
      let finalized: unknown;
      let clockCalled = false;
      const result = await runHnsAuthorityProvisionExecutorOnce({
        executor_id: "renewal-executor",
        queue: { claim: async () => null, finalize: async () => Promise.reject() },
        provision: {} as never,
        observation: {
          queue: {
            claim: async () => ({
              observation_job_id: "renewal-job",
              root_import_session_id: "root-import-session",
              operation_kind: "renew_health_v1",
              request_bytes: requestBytes,
              request_sha256: corruptRequest ? "f".repeat(64) : await hash(requestBytes),
              publish_plan_bytes: publishPlanBytes,
              publish_plan_sha256: planHash,
              provision_result_bytes: provisionResultBytes,
              provision_result_sha256: provisionHash,
              lease_fence: 1,
            }),
            finalize: async (input) => {
              finalized = input;
              return {
                outcome: input.outcome,
                root_import_session_id: "root-import-session",
                session_revision: 6,
              };
            },
          },
          observe: {} as never,
          teardown_zone: async () => {
            throw new Error("Unexpected teardown");
          },
          config: {
            environment: "test",
            valid_for_seconds: 604800,
            now: () => {
              clockCalled = true;
              throw new TypeError("unclassified observation runtime failure");
            },
          },
        },
      });
      expect(clockCalled).toBe(!corruptRequest);
      expect(result.outcome).toBe(corruptRequest ? "failed" : "retry");
      expect(finalized).toMatchObject({
        outcome: corruptRequest ? "failed" : "retry",
        failure_code: corruptRequest ? "invalid_request" : "observation_failed",
        lease_fence: 1,
      });
    },
  );
}

test.each([false, true])(
  "partial provisional cleanup uses retained request bytes; retry=%s",
  async (fail) => {
    const state = await fixture();
    const provision = await state.queue.claim("fixture", 60);
    if (provision === null) throw new Error("fixture missing");
    let completion: unknown;
    const removed: unknown[] = [];
    const result = await runHnsAuthorityProvisionExecutorOnce({
      executor_id: "cleanup-executor",
      queue: { claim: async () => null, finalize: async () => Promise.reject() },
      provision: {} as never,
      observation: {
        queue: {
          claim: async () => ({
            observation_job_id: "cleanup",
            root_import_session_id: provision.root_import_session_id,
            operation_kind: "teardown_provisional_root_v1",
            request_bytes: provision.request_bytes,
            request_sha256: provision.request_sha256,
            publish_plan_bytes: null,
            publish_plan_sha256: null,
            lease_fence: 1,
          }),
          finalize: async (input) => {
            completion = input;
            return {
              outcome: input.outcome,
              root_import_session_id: provision.root_import_session_id,
              session_revision: 3,
            };
          },
        },
        observe: {} as never,
        teardown_zone: async (input) => {
          removed.push(input);
          if (fail) throw new Error("authority unavailable");
        },
        // Partial provisioning reaches deletion only with a recorded
        // retirement authorization; this case asserts the shape of that
        // deletion, not that elapsed time permits it.
        retention: retentionPorts({ retirementAuthorized: true }),
        config: { environment: "test", valid_for_seconds: 300 },
      },
    });
    expect(removed).toEqual([
      {
        root_label: "newroot",
        challenge_txt_value: "pirate-verification=challenge",
        mutation_lease: { job_id: "cleanup", executor_id: "cleanup-executor", lease_fence: 1 },
      },
    ]);
    expect(result.outcome).toBe(fail ? "retry" : "failed");
    expect(completion).toMatchObject({
      failure_code: fail ? "zone_teardown_unavailable" : "session_expired",
    });
  },
);

test("a retrying observation root never blocks unrelated provisioning work (T09)", async () => {
  const waitingRequest = encoder.encode(
    canonicalJson({
      version: "pirate-hns-root-readiness-observation-request-v1",
      root_import_session_id: "waiting-root",
      namespace_session_id: "namespace-session",
      root_label: "waitingroot",
      challenge_txt_value: "pirate-verification=challenge",
      ownership_result_sha256: "a".repeat(64),
      publish_plan_sha256: "0".repeat(64),
      provision_result_sha256: "0".repeat(64),
      expires_at: "2099-01-01T00:00:00.000Z",
    }),
  );
  const planBytes = encoder.encode("retained-plan");
  const provisionBytes = encoder.encode("retained-provision");
  let observationClaims = 0;
  let provisionClaims = 0;
  const observe = async () => {
    throw new Error("chain transport unavailable");
  };
  const runOnce = () =>
    runHnsAuthorityProvisionExecutorOnce({
      executor_id: "fairness-executor",
      queue: {
        claim: async () => {
          provisionClaims += 1;
          if (provisionClaims < 2) return null;
          const request = encoder.encode(
            canonicalJson({
              version: HNS_AUTHORITY_PROVISION_REQUEST_VERSION,
              root_import_session_id: "unrelated-root",
              namespace_session_id: "namespace-session",
              root_label: "unrelatedroot",
              challenge_txt_value: "pirate-verification=challenge",
              expires_at: "2099-01-01T00:00:00.000Z",
            }),
          );
          return {
            provision_job_id: "provision-unrelated",
            root_import_session_id: "unrelated-root",
            operation_kind: "provision_root_v1" as const,
            request_bytes: request,
            request_sha256: await hash(request),
            lease_fence: 1,
          };
        },
        finalize: async (input: HnsAuthorityProvisionFinalizeInput) => ({
          outcome: input.outcome,
          root_import_session_id: "unrelated-root",
          session_revision: 3,
        }),
      },
      provision: {
        observe_current_resource: async () => observedCurrent(),
        ensure_zone: async () => {
          const zoneBytes = encoder.encode("unrelated-zone");
          return {
            created: true,
            dnssec: true,
            serial: 1,
            ds_records: [
              { key_tag: 1, algorithm: 13, digest_type: 2, digest: "a".repeat(64) },
              { key_tag: 1, algorithm: 13, digest_type: 4, digest: "b".repeat(96) },
            ],
            managed_rrset_sha256: await hash(zoneBytes),
            managed_zone_bytes: zoneBytes,
            shared_tlsa_profile_sha256: "d".repeat(64),
            gateway_ipv4: "192.0.2.10",
            gateway_deployment_reference: "gateway-deployment-v1",
            gateway_certificate_spki_sha256: "e".repeat(64),
            ttl_seconds: 300,
          };
        },
      },
      observation: {
        queue: {
          claim: async () => {
            observationClaims += 1;
            if (observationClaims > 1) return null;
            return {
              observation_job_id: "observation-waiting",
              root_import_session_id: "waiting-root",
              operation_kind: "observe_root_v1" as const,
              request_bytes: waitingRequest,
              request_sha256: await hash(waitingRequest),
              publish_plan_bytes: planBytes,
              publish_plan_sha256: "0".repeat(64),
              provision_result_bytes: provisionBytes,
              provision_result_sha256: "0".repeat(64),
              lease_fence: 1,
            };
          },
          finalize: async () => ({
            outcome: "retry" as const,
            root_import_session_id: "waiting-root",
            session_revision: 2,
          }),
        },
        observe: {
          observe_current_resource: observe as never,
          reconcile_zone: async () => {},
          inspect_zone: async () => {
            throw new Error("not reached");
          },
          observe_live: async () => {
            throw new Error("not reached");
          },
        },
        teardown_zone: async () => {},
        config: { environment: "test", valid_for_seconds: 86_400 },
      },
    });
  // First pass: the waiting root's observation retries (no sleep happens
  // between passes in due-job scheduling).
  const first = await runOnce();
  expect(first).toMatchObject({ outcome: "retry", root_import_session_id: "waiting-root" });
  // Second pass claims the unrelated root's provisioning immediately.
  const second = await runOnce();
  expect(second).toMatchObject({ outcome: "completed", provision_job_id: "provision-unrelated" });
  expect(provisionClaims).toBe(2);
});

describe("executor teardown retention gate (T07)", () => {
  const planDigest = "ab".repeat(32);
  const planBytes = encoder.encode(
    canonicalJson({
      version: "pirate-hns-root-import-publish-plan-v1",
      encoded_resource_sha256: planDigest,
      replacement_records: [
        { type: "NS", ns: "ns1.pirate." },
        { type: "NS", ns: "ns2.pirate." },
        { type: "TXT", txt: ["pirate-verification=challenge"] },
        { type: "DS", keyTag: 19787, algorithm: 13, digestType: 2, digest: "f0".repeat(32) },
      ],
    }),
  );
  /** A resource that keeps our authority but adds one unrelated record. */
  const authorityPlusUnrelatedTxt = [
    { type: "NS", ns: "ns1.pirate." },
    { type: "NS", ns: "ns2.pirate." },
    { type: "DS", keyTag: 19787, algorithm: 13, digestType: 2, digest: "f0".repeat(32) },
    { type: "TXT", txt: ["something-the-owner-added=1"] },
  ];

  function provisionalClaim() {
    return {
      observation_job_id: "retention-job",
      root_import_session_id: "root-import-session",
      operation_kind: "teardown_provisional_root_v1" as const,
      request_bytes: encoder.encode(
        canonicalJson({
          version: HNS_AUTHORITY_PROVISION_REQUEST_VERSION,
          root_import_session_id: "root-import-session",
          namespace_session_id: "namespace-session",
          root_label: "newroot",
          challenge_txt_value: "pirate-verification=challenge",
          expires_at: "2099-01-01T00:00:00.000Z",
        }),
      ),
      request_sha256: "",
      publish_plan_bytes: planBytes as unknown as Uint8Array,
      publish_plan_sha256: "",
      lease_fence: 1,
    };
  }

  async function runTeardown(
    claim:
      | ReturnType<typeof provisionalClaim>
      | (Omit<ReturnType<typeof provisionalClaim>, "operation_kind" | "publish_plan_bytes"> & {
          operation_kind: "teardown_root_v1";
        }),
    retention: HnsTeardownRetentionPorts,
  ) {
    const computedRequest = await hash(claim.request_bytes);
    let completion: HnsRootObservationFinalizeInput | undefined;
    let deleted = false;
    let deleteInput: unknown;
    const result = await runHnsAuthorityProvisionExecutorOnce({
      executor_id: "retention-executor",
      queue: { claim: async () => null, finalize: async () => Promise.reject() },
      provision: {} as never,
      observation: {
        queue: {
          claim: async () => {
            const planBytes = (claim as { readonly publish_plan_bytes?: Uint8Array | null })
              .publish_plan_bytes;
            return {
              ...claim,
              request_sha256: computedRequest,
              // A claim with no plan keeps both fields null; hashing a
              // substitute here would hide the partial-provisioning case the
              // gate has to handle.
              publish_plan_sha256:
                planBytes === null || planBytes === undefined ? null : await hash(planBytes),
            } as never;
          },
          finalize: async (input) => {
            completion = input;
            return {
              outcome: input.outcome,
              root_import_session_id: claim.root_import_session_id,
              session_revision: 9,
            };
          },
        },
        observe: {} as never,
        teardown_zone: async (input) => {
          deleted = true;
          deleteInput = input;
        },
        retention,
        config: { environment: "test", valid_for_seconds: 300 },
      },
    });
    return { result, completion, deleted, deleteInput };
  }

  test("retains authority without deletion when the chain references the exposed plan", async () => {
    const claim = provisionalClaim();
    const { result, completion, deleted } = await runTeardown(
      claim,
      // Authorized for retirement, and still retained: a chain reference
      // outranks the authorization.
      retentionPorts({ records: [{ type: "NS", ns: "ns1.pirate." }], retirementAuthorized: true }),
    );
    expect(deleted).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(completion).toMatchObject({
      outcome: "failed",
      failure_code: "retention_chain_reference_retained",
    });
  });

  test("retains authority and retries when either view's evidence is unavailable", async () => {
    for (const unavailable of ["current", "safe", "both"] as const) {
      const claim = provisionalClaim();
      const { result, completion, deleted } = await runTeardown(
        claim,
        retentionPorts({ unavailable, retirementAuthorized: true }),
      );
      expect(deleted).toBe(false);
      expect(result.outcome).toBe("retry");
      expect(completion).toMatchObject({
        outcome: "retry",
        failure_code: "retention_unavailable_chain_state_retained",
      });
    }
  });

  test("retains authority and retries when no retirement is authorized", async () => {
    // Fresh no-reference evidence in both views, and no recorded review or
    // supersession. Absence alone never authorizes deletion: the owner may
    // broadcast the issued plan later.
    const claim = provisionalClaim();
    const { result, completion, deleted } = await runTeardown(claim, retentionPorts({}));
    expect(deleted).toBe(false);
    expect(result.outcome).toBe("retry");
    expect(completion).toMatchObject({
      outcome: "retry",
      failure_code: "retention_chain_absence_after_exposure_retained",
    });
  });

  test("proceeds with teardown only on recorded retirement authorization", async () => {
    const claim = provisionalClaim();
    const { result, deleted } = await runTeardown(
      claim,
      retentionPorts({ retirementAuthorized: true }),
    );
    expect(deleted).toBe(true);
    expect(result.outcome).toBe("failed");
  });

  test("retains authority when an unrelated record changed the resource digest", async () => {
    // The resource is a complete replacement, so one added TXT changes its
    // digest while our NS and DS remain published. Digest inequality is not
    // absence, and treating it as absence is what authorized deleting a live
    // authority.
    const claim = provisionalClaim();
    const { completion, deleted } = await runTeardown(
      claim,
      retentionPorts({ records: authorityPlusUnrelatedTxt, retirementAuthorized: true }),
    );
    expect(deleted).toBe(false);
    expect(completion).toMatchObject({ failure_code: "retention_chain_reference_retained" });
  });

  test("retains authority when the owner broadcasts after an absent inspection", async () => {
    // Late broadcast: absence first, reference later. The first pass must not
    // delete, so that the second pass can still find the reference.
    const claim = provisionalClaim();
    const first = await runTeardown(claim, retentionPorts({}));
    expect(first.deleted).toBe(false);
    expect(first.completion).toMatchObject({
      outcome: "retry",
      failure_code: "retention_chain_absence_after_exposure_retained",
    });

    const second = await runTeardown(
      provisionalClaim(),
      retentionPorts({ records: authorityPlusUnrelatedTxt }),
    );
    expect(second.deleted).toBe(false);
    expect(second.completion).toMatchObject({
      failure_code: "retention_chain_reference_retained",
    });
  });

  test("retains authority when the plan's provenance cannot be read", async () => {
    const claim = { ...provisionalClaim(), publish_plan_bytes: encoder.encode("not-a-plan") };
    const { completion, deleted } = await runTeardown(
      claim,
      retentionPorts({ retirementAuthorized: true }),
    );
    expect(deleted).toBe(false);
    expect(completion).toMatchObject({
      outcome: "retry",
      failure_code: "retention_unknown_plan_provenance_retained",
    });
  });

  test("applies the same gate to the legacy teardown_root_v1 variant", async () => {
    const provisionResultBytes = encoder.encode(
      canonicalJson({
        version: "pirate-hns-authority-provision-result-v1",
        root_import_session_id: "root-import-session",
        root_label: "newroot",
        nameservers: ["ns1.pirate.", "ns2.pirate."],
        zone_created: true,
        zone_dnssec: true,
        zone_serial: 1,
        ds_records: [
          { key_tag: 1, algorithm: 13, digest_type: 2, digest: "a".repeat(64) },
          { key_tag: 1, algorithm: 13, digest_type: 4, digest: "b".repeat(96) },
        ],
        managed_rrset_sha256: "c".repeat(64),
        shared_tlsa_profile_sha256: "d".repeat(64),
        gateway_ipv4: "192.0.2.10",
        gateway_deployment_reference: "gateway-v1",
        gateway_certificate_spki_sha256: "e".repeat(64),
        ttl_seconds: 300,
      }),
    );
    const legacyClaim = {
      observation_job_id: "retention-job",
      root_import_session_id: "root-import-session",
      operation_kind: "teardown_root_v1" as const,
      request_bytes: encoder.encode('{"legacy":true}'),
      request_sha256: "",
      lease_fence: 3,
    };
    const held = await (async () => {
      let deleted = false;
      let completion: HnsRootObservationFinalizeInput | undefined;
      const result = await runHnsAuthorityProvisionExecutorOnce({
        executor_id: "retention-executor",
        queue: { claim: async () => null, finalize: async () => Promise.reject() },
        provision: {} as never,
        observation: {
          queue: {
            claim: async () => ({
              ...legacyClaim,
              request_sha256: await hash(legacyClaim.request_bytes),
              publish_plan_bytes: planBytes,
              publish_plan_sha256: await hash(planBytes),
              provision_result_bytes: provisionResultBytes,
              provision_result_sha256: await hash(provisionResultBytes),
            }),
            finalize: async (input) => {
              completion = input;
              return {
                outcome: input.outcome,
                root_import_session_id: "root-import-session",
                session_revision: 9,
              };
            },
          },
          observe: {} as never,
          teardown_zone: async () => {
            deleted = true;
          },
          retention: retentionPorts({ records: [{ type: "NS", ns: "ns1.pirate." }] }),
          config: { environment: "test", valid_for_seconds: 300 },
        },
      });
      return { result, completion, deleted };
    })();
    expect(held.deleted).toBe(false);
    expect(held.completion).toMatchObject({
      failure_code: "retention_chain_reference_retained",
    });
  });

  test("fences the legacy teardown_root_v1 deletion with its lease", async () => {
    // Both variants delete under the same policy and the same fence. An
    // unfenced delete can land after another executor has taken the job over.
    const claim = provisionalClaim();
    const { deleted, deleteInput } = await runTeardown(
      claim,
      retentionPorts({ retirementAuthorized: true }),
    );
    expect(deleted).toBe(true);
    expect(deleteInput).toMatchObject({
      root_label: "newroot",
      mutation_lease: {
        job_id: "retention-job",
        executor_id: "retention-executor",
        lease_fence: 1,
      },
    });
  });
});

import { describe, expect, test } from "bun:test";
import { canonicalJson } from "@pirate/domain";
import { runHnsAuthorityProvisionExecutorOnce } from "./executor.ts";
import type { HnsRootObservationQueue } from "./observation-queue.ts";
import {
  HNS_AUTHORITY_NAMESERVERS,
  HNS_AUTHORITY_PROVISION_REQUEST_VERSION,
  HNS_AUTHORITY_PROVISION_RESULT_VERSION,
} from "./provision-root.ts";
import type { HnsAuthorityProvisionFinalizeInput, HnsAuthorityProvisionQueue } from "./queue.ts";

const encoder = new TextEncoder();

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
        inspect_current_resource: async () => [],
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
        inspect_current_resource: async () => {
          mutated = true;
          return [];
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
        inspect_current_resource: async () => [],
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

  test("tears down a zone created for an expired import before terminal finalization", async () => {
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
        return {
          outcome: "failed",
          root_import_session_id: "root-import-session",
          session_revision: 5,
        };
      },
    };
    const removed: string[] = [];
    const result = await runHnsAuthorityProvisionExecutorOnce({
      executor_id: "executor-1",
      queue: { claim: async () => null, finalize: async () => Promise.reject() },
      provision: {} as never,
      observation: {
        queue: observationQueue,
        observe: {} as never,
        teardown_zone: async ({ root_label }) => {
          removed.push(root_label);
        },
        config: { environment: "test", valid_for_seconds: 300 },
      },
    });
    expect(result.outcome).toBe("failed");
    expect(removed).toEqual(["newroot"]);
    expect(finalized).toMatchObject({
      outcome: "failed",
      operation_kind: "teardown_root_v1",
      failure_code: "session_expired",
      lease_fence: 2,
    });
  });
});

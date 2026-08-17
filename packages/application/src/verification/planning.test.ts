import { describe, expect, test } from "bun:test";
import type { ProofProviderManifest } from "@pirate/domain/verification";
import { Effect } from "effect";
import {
  type VerificationProviderAdapter,
  type VerificationProviderPlanInput,
  VerificationProviderUnavailable,
} from "./adapter.ts";
import { planVerificationProviderCandidates } from "./planning.ts";
import { makeVerificationProviderRegistry } from "./registry.ts";

const planInput = (issuer: string): VerificationProviderPlanInput => ({
  method: "document",
  scope: { kind: "none", issuer },
  requested_requirements: [{ claim_id: "nationality.allowed", allowed_countries: ["GE", "US"] }],
  requested_claim_ids: ["nationality.allowed"],
  subject_binding_intent: "none",
  protocol_version: "test-v1",
  environment: "test",
});

function provider(
  provider_id: string,
  mode: "curated" | "dynamic",
  outcome: "supported" | "unsupported" | "unavailable",
): VerificationProviderAdapter {
  const manifest: ProofProviderManifest = {
    provider_id,
    manifest_version: "1",
    operation_deadlines: { plan_ms: 1000, start_ms: 5000, complete_ms: 5000, callback_ms: 5000 },
    callback_mode: "none",
    callback_header_allowlist: [],
    protocol_versions: ["test-v1"],
    environments: ["test"],
    supported_methods: ["document"],
    claim_ids: ["nationality.allowed"],
    claim_capabilities: [{ claim_id: "nationality.allowed", request_modes: [mode] }],
    presentation_kinds: ["redirect"],
    assurance_levels: ["document_zk"],
    subject_key_scope_semantics: "none",
  };
  return {
    manifest,
    plan: () =>
      outcome === "unavailable"
        ? Effect.fail(new VerificationProviderUnavailable({ provider_id, operation: "plan" }))
        : Effect.succeed(
            outcome === "supported"
              ? {
                  status: "supported" as const,
                  request_mode: mode,
                  provider_configuration: {
                    kind: mode === "curated" ? ("managed" as const) : ("dynamic" as const),
                    reference: `${provider_id}-configuration`,
                    version: "1",
                  },
                }
              : { status: "unsupported" as const },
          ),
    start: () => Effect.die("start is outside this planning test"),
    complete: () => Effect.die("complete is outside this planning test"),
  };
}

describe("verification provider planning", () => {
  test("returns every option deterministically without provider-specific branches", async () => {
    const registry = await Effect.runPromise(
      makeVerificationProviderRegistry([
        provider("zkpassport", "dynamic", "supported"),
        provider("future.provider", "dynamic", "unavailable"),
        provider("self.enterprise", "curated", "supported"),
        provider("configured.only", "curated", "unsupported"),
      ]),
    );
    const candidates = ["zkpassport", "future.provider", "self.enterprise", "configured.only"].map(
      (provider_id) => ({ provider_id, input: planInput(provider_id) }),
    );

    expect(
      await Effect.runPromise(planVerificationProviderCandidates(registry, candidates)),
    ).toEqual([
      { provider_id: "configured.only", status: "unsupported" },
      { provider_id: "future.provider", status: "unknown" },
      {
        provider_id: "self.enterprise",
        status: "supported",
        request_mode: "curated",
        provider_configuration: {
          kind: "managed",
          reference: "self.enterprise-configuration",
          version: "1",
        },
      },
      {
        provider_id: "zkpassport",
        status: "supported",
        request_mode: "dynamic",
        provider_configuration: {
          kind: "dynamic",
          reference: "zkpassport-configuration",
          version: "1",
        },
      },
    ]);
  });
});

import { describe, expect, test } from "bun:test";
import type {
  VerificationProviderAdapter,
  VerificationProviderCompleteInput,
  VerificationProviderPlanInput,
  VerificationProviderStartInput,
} from "@pirate/application/verification";
import { VerificationProviderUnavailable } from "@pirate/application/verification";
import type { ProofSession, VerificationRequirements } from "@pirate/domain/verification";
import { runProviderTransportConformance } from "@pirate/testing/verification";
import { Cause, Effect, Exit, Result } from "effect";
import {
  makeSelfEnterpriseProvider,
  SELF_ENTERPRISE_MANIFEST,
  SELF_ENTERPRISE_PROTOCOL_VERSION,
  type SelfEnterpriseAdapterOptions,
  type SelfEnterpriseFlow,
  type SelfEnterpriseTransport,
} from "./self-enterprise.ts";

const NOW = "2099-08-17T12:00:00.000Z";
const EXPIRES = "2099-08-17T13:00:00.000Z";
const HASH = "2e10fcb51abd84e7edd0541f7f9da0e0f1c0773bc13920b538ca197db3840c42";
const DIGEST = "b".repeat(64);

const SCOPE = {
  kind: "named" as const,
  scope_semantics: "issuer_rp_scope" as const,
  issuer: SELF_ENTERPRISE_MANIFEST.provider_id,
  rp_scope: "pirate-social",
};

const REQUIREMENTS = [
  { claim_id: "age.minimum", minimum_age: "18" },
  { claim_id: "credential.subject_unique" },
  { claim_id: "document.holder_bound" },
  { claim_id: "document.valid" },
  { claim_id: "gender.marker", allowed_markers: ["female", "male"] },
  { claim_id: "nationality.allowed", allowed_countries: ["GE", "US"] },
] as const satisfies VerificationRequirements;

const CLAIM_IDS = [
  "age.minimum",
  "credential.subject_unique",
  "document.holder_bound",
  "document.valid",
  "gender.marker",
  "nationality.allowed",
] as const;

const FLOW: SelfEnterpriseFlow = {
  configuration: {
    kind: "managed",
    reference: "self.enterprise.identity-proof",
    version: "2026-08-17",
  },
  method: "document",
  scope: SCOPE,
  requested_requirements: REQUIREMENTS,
  subject_binding_intent: "establish",
  protocol_version: SELF_ENTERPRISE_PROTOCOL_VERSION,
  environment: "test",
  presentation_protocol: "self",
  presentation_version: "2",
};

const START_INPUT: VerificationProviderStartInput = {
  actor_id: "user-1",
  intent_id: "intent-1",
  request_hash: HASH,
  method: FLOW.method,
  scope: FLOW.scope,
  request_mode: "curated",
  provider_configuration: FLOW.configuration,
  requested_requirements: REQUIREMENTS,
  requested_claim_ids: CLAIM_IDS,
  subject_binding_intent: FLOW.subject_binding_intent,
  protocol_version: FLOW.protocol_version,
  environment: FLOW.environment,
};

const SUBMISSION = {
  channel: "client_result" as const,
  payload: {
    kind: "self-proof" as const,
    session_id: "session-1",
    user_context_data: "context-for-session-1",
    proof: { opaque: true },
    public_signals: ["signal-1"],
  },
};

function identifiers() {
  const counts = new Map<string, number>();
  return {
    next(kind: string) {
      const next = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, next);
      return `${kind}-${next}`;
    },
  };
}

function outputFor(session: ProofSession) {
  return {
    session_id: session.id,
    subject: "self-subject-1",
    subject_unique: true,
    document_valid: true,
    holder_bound: true,
    minimum_age: "21",
    nationality: "GE",
    nationality_allowed: true,
    gender: "female",
  } as const;
}

function transportWith(overrides: Partial<SelfEnterpriseTransport> = {}): SelfEnterpriseTransport {
  return {
    start: () =>
      Effect.succeed({
        upstream_session_ref: "self-upstream-1",
        presentation_payload: { flow_reference: FLOW.configuration.reference },
      }),
    verify: ({ session }) => Effect.succeed(outputFor(session)),
    ...overrides,
  };
}

function options(
  overrides: Partial<SelfEnterpriseAdapterOptions> = {},
): SelfEnterpriseAdapterOptions {
  return {
    flows: [FLOW],
    transport: transportWith(),
    clock: { now: () => NOW, expiresAt: () => EXPIRES },
    identifiers: identifiers(),
    digest: { digest: () => Effect.succeed(DIGEST) },
    ...overrides,
  };
}

function provider(
  overrides: Partial<SelfEnterpriseAdapterOptions> = {},
): VerificationProviderAdapter {
  return makeSelfEnterpriseProvider(options(overrides));
}

function planInput(overrides: Partial<VerificationProviderPlanInput> = {}) {
  return {
    method: START_INPUT.method,
    scope: START_INPUT.scope,
    requested_requirements: START_INPUT.requested_requirements,
    requested_claim_ids: START_INPUT.requested_claim_ids,
    subject_binding_intent: START_INPUT.subject_binding_intent,
    protocol_version: START_INPUT.protocol_version,
    environment: START_INPUT.environment,
    ...overrides,
  } satisfies VerificationProviderPlanInput;
}

async function failureTag(effect: Effect.Effect<unknown, unknown>): Promise<string> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected failure");
  const failure = Cause.findError(exit.cause);
  if (Result.isFailure(failure)) throw new Error("expected typed failure");
  return String((failure.success as { readonly _tag?: unknown })._tag);
}

async function started(adapter = provider()) {
  return Effect.runPromise(adapter.start(START_INPUT));
}

function completionInput(
  session: ProofSession,
  payload: unknown = SUBMISSION.payload,
): VerificationProviderCompleteInput {
  return { session, submission: { channel: "client_result", payload } };
}

describe("Self Enterprise provider-local contract probe", () => {
  test("passes the shared deterministic transport conformance harness", async () => {
    await runProviderTransportConformance([
      {
        name: "Self Enterprise curated proof",
        makeTransport: () => transportWith(),
        makeAdapter: (transport) => provider({ transport }),
        startInput: START_INPUT,
        submission: SUBMISSION,
        operation: "complete",
        expected: "success",
        assertTransport: () => undefined,
      },
    ]);
  });

  test("returns supported only for an exact managed flow and distinguishes unknown catalog", async () => {
    const supported = await Effect.runPromise(provider().plan(planInput()));
    expect(supported).toEqual({
      status: "supported",
      request_mode: "curated",
      provider_configuration: FLOW.configuration,
    });

    const unsupported = await Effect.runPromise(provider({ flows: [] }).plan(planInput()));
    expect(unsupported).toEqual({ status: "unsupported" });

    const unknown = await Effect.runPromise(provider({ flows: undefined }).plan(planInput()));
    expect(unknown).toEqual({ status: "unknown" });

    expect(
      await Effect.runPromise(
        provider().plan(planInput({ requested_claim_ids: ["document.valid"] })),
      ),
    ).toEqual({ status: "unsupported" });
  });

  test("maps the deterministic launch session and embedded Self presentation", async () => {
    const start = await started();
    expect(start.session).toMatchObject({
      id: "session-1",
      actor_id: START_INPUT.actor_id,
      intent_id: START_INPUT.intent_id,
      request_hash: START_INPUT.request_hash,
      provider_id: SELF_ENTERPRISE_MANIFEST.provider_id,
      upstream_session_ref: "self-upstream-1",
      provider_configuration: FLOW.configuration,
      requested_requirements: REQUIREMENTS,
      requested_claim_ids: START_INPUT.requested_claim_ids,
      started_at: NOW,
      expires_at: EXPIRES,
      status: "pending",
    });
    expect(start.presentation).toEqual({
      kind: "embedded_sdk",
      session_id: "session-1",
      protocol: "self",
      version: "2",
      payload: { flow_reference: FLOW.configuration.reference },
    });
  });

  test("projects all curated Self claims into scoped, bound evidence", async () => {
    const adapter = provider();
    const start = await started(adapter);
    const bundle = await Effect.runPromise(adapter.complete(completionInput(start.session)));
    expect(bundle).toMatchObject({
      id: "bundle-1",
      proof_session_id: "session-1",
      receipts: [
        {
          id: "receipt-1",
          provider_id: SELF_ENTERPRISE_MANIFEST.provider_id,
          evidence_hash: DIGEST,
          observed_at: NOW,
          subject_key_id: "subject-1",
        },
      ],
      subject_keys: [
        {
          id: "subject-1",
          subject_digest: DIGEST,
          scope: SCOPE,
        },
      ],
      binding_groups: [{ id: "binding-1", kind: "same_subject", subject_key_id: "subject-1" }],
    });
    expect(bundle.assertions.map((assertion) => assertion.claim_id)).toEqual([
      ...START_INPUT.requested_claim_ids,
    ]);
    expect(bundle.assertions.map((assertion) => assertion.id)).toEqual([
      "assertion-1",
      "assertion-2",
      "assertion-3",
      "assertion-4",
      "assertion-5",
      "assertion-6",
    ]);
    expect(
      bundle.assertions.find((assertion) => assertion.claim_id === "age.minimum"),
    ).toMatchObject({
      value: { minimum_age: "18" },
    });
    expect(
      bundle.assertions.find((assertion) => assertion.claim_id === "nationality.allowed"),
    ).toMatchObject({ value: { allowed: true, disclosed_nationality: "GE" } });
  });

  test("rejects malformed and cross-session submissions before provider verification", async () => {
    let verifyCalls = 0;
    const adapter = provider({
      transport: transportWith({
        verify: ({ session }) => {
          verifyCalls += 1;
          return Effect.succeed(outputFor(session));
        },
      }),
    });
    const start = await started(adapter);
    expect(
      await failureTag(adapter.complete(completionInput(start.session, { malformed: true }))),
    ).toBe("VerificationProviderRejected");
    expect(
      await failureTag(
        adapter.complete(
          completionInput(start.session, { ...SUBMISSION.payload, session_id: "other" }),
        ),
      ),
    ).toBe("VerificationProviderRejected");
    expect(verifyCalls).toBe(0);
  });

  test("rejects exact managed-reference drift and unsupported channels", async () => {
    const drifted = {
      ...START_INPUT,
      provider_configuration: { ...FLOW.configuration, version: "other" },
    };
    expect(await failureTag(provider().start(drifted))).toBe("VerificationProviderRejected");
    const start = await started();
    expect(
      await failureTag(
        provider().complete({
          session: start.session,
          submission: { channel: "provider_callback", payload: SUBMISSION.payload },
        }),
      ),
    ).toBe("VerificationProviderRejected");
  });

  test("redacts unavailable and invalid upstream outcomes", async () => {
    const unavailable = provider({
      transport: transportWith({
        verify: () =>
          Effect.fail(
            new VerificationProviderUnavailable({
              provider_id: SELF_ENTERPRISE_MANIFEST.provider_id,
              operation: "complete",
            }),
          ),
      }),
    });
    const unavailableStart = await started(unavailable);
    expect(await failureTag(unavailable.complete(completionInput(unavailableStart.session)))).toBe(
      "VerificationProviderUnavailable",
    );

    const invalid = provider({
      transport: transportWith({ verify: () => Effect.succeed({ invalid: true }) }),
    });
    const invalidStart = await started(invalid);
    expect(await failureTag(invalid.complete(completionInput(invalidStart.session)))).toBe(
      "VerificationProviderInvalidResponse",
    );
  });

  test("rejects claim mismatches and invalid injected digests", async () => {
    const underage = provider({
      transport: transportWith({
        verify: ({ session }) => Effect.succeed({ ...outputFor(session), minimum_age: "17" }),
      }),
    });
    const underageStart = await started(underage);
    expect(await failureTag(underage.complete(completionInput(underageStart.session)))).toBe(
      "VerificationProviderRejected",
    );

    const invalidDigest = provider({
      digest: { digest: () => Effect.succeed("not-a-sha256") },
    });
    const invalidDigestStart = await started(invalidDigest);
    expect(
      await failureTag(invalidDigest.complete(completionInput(invalidDigestStart.session))),
    ).toBe("VerificationProviderInvalidResponse");
  });
});

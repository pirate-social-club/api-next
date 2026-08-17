import { describe, expect, test } from "bun:test";
import type {
  EvidenceBundle,
  ProofProviderManifest,
  ProofSession,
} from "@pirate/domain/verification";
import { Cause, Effect, Exit, Result } from "effect";
import {
  type ProviderSessionStart,
  type VerificationProviderAdapter,
  VerificationProviderInvalidResponse,
  VerificationProviderRejected,
  type VerificationProviderStartInput,
  VerificationProviderUnavailable,
} from "./adapter.ts";
import { makeVerificationProviderRegistry } from "./registry.ts";

const NOW = Date.parse("2026-08-17T00:00:00.000Z");
const MANIFEST: ProofProviderManifest = {
  provider_id: "test.adversarial",
  manifest_version: "1",
  protocol_versions: ["test-v1"],
  environments: ["test"],
  supported_methods: ["document"],
  claim_ids: ["document.valid", "credential.subject_unique", "age.minimum"],
  claim_capabilities: [
    { claim_id: "document.valid", request_modes: ["dynamic"] },
    { claim_id: "credential.subject_unique", request_modes: ["dynamic"] },
    { claim_id: "age.minimum", request_modes: ["dynamic"] },
  ],
  presentation_kinds: ["none"],
  assurance_levels: ["document_zk"],
  subject_key_scope_semantics: "issuer_rp_scope",
};
const START_INPUT: VerificationProviderStartInput = {
  actor_id: "user-1",
  intent_id: "intent-1",
  request_hash: "d30bcbe842ef8e7046be5cf21531d99fe95f2cb7e92d3efe1f46e094b4fa833b",
  method: "document",
  scope: {
    kind: "named",
    scope_semantics: "issuer_rp_scope",
    issuer: MANIFEST.provider_id,
    rp_scope: "pirate.test",
  },
  request_mode: "dynamic",
  requested_requirements: [
    { claim_id: "credential.subject_unique" },
    { claim_id: "document.valid" },
  ],
  requested_claim_ids: ["credential.subject_unique", "document.valid"],
  subject_binding_intent: "establish",
  protocol_version: "test-v1",
  environment: "test",
};

function sessionFor(input: VerificationProviderStartInput = START_INPUT): ProofSession {
  return {
    id: "session-1",
    actor_id: input.actor_id,
    intent_id: input.intent_id,
    request_hash: input.request_hash,
    provider_id: MANIFEST.provider_id,
    upstream_session_ref: "upstream-session-1",
    method: input.method,
    scope: input.scope,
    request_mode: input.request_mode,
    requested_requirements: input.requested_requirements,
    requested_claim_ids: input.requested_claim_ids,
    subject_binding_intent: input.subject_binding_intent,
    protocol_version: input.protocol_version,
    environment: input.environment,
    status: "pending",
    started_at: "2026-08-17T00:00:00.000Z",
    expires_at: "2026-08-17T01:00:00.000Z",
  };
}

function startFor(input: VerificationProviderStartInput = START_INPUT): ProviderSessionStart {
  const session = sessionFor(input);
  return { session, presentation: { kind: "none", session_id: session.id } };
}

function bundleFor(session: ProofSession = sessionFor()): EvidenceBundle {
  return {
    id: "bundle-1",
    proof_session_id: session.id,
    receipts: [
      {
        id: "receipt-1",
        proof_session_id: session.id,
        provider_id: session.provider_id,
        issuer: session.scope.issuer,
        method: session.method,
        scope: session.scope,
        protocol_version: session.protocol_version,
        environment: session.environment,
        provenance_kind: "proof_session",
        evidence_kind: "document",
        evidence_hash: "2".repeat(64),
        observed_at: "2026-08-17T00:00:00.000Z",
        subject_key_id: "subject-1",
      },
    ],
    subject_keys: [
      {
        id: "subject-1",
        issuer: session.scope.issuer,
        method: session.method,
        scope:
          session.scope.kind === "named"
            ? session.scope
            : {
                kind: "named",
                scope_semantics: "issuer_rp_scope",
                issuer: session.scope.issuer,
                rp_scope: "pirate.test",
              },
        subject_digest: "3".repeat(64),
      },
    ],
    binding_groups: [{ id: "binding-1", kind: "same_subject", subject_key_id: "subject-1" }],
    assertions: session.requested_claim_ids.map((claim, index) =>
      claim === "document.valid"
        ? {
            id: `assertion-${index + 1}`,
            subject_key_id: "subject-1",
            evidence_receipt_id: "receipt-1",
            claim_id: claim,
            assurance: "document_zk",
            binding_group_id: "binding-1",
            value: { valid: true },
            observed_at: "2026-08-17T00:00:00.000Z",
          }
        : {
            id: `assertion-${index + 1}`,
            subject_key_id: "subject-1",
            evidence_receipt_id: "receipt-1",
            claim_id: "credential.subject_unique",
            assurance: "document_zk",
            binding_group_id: "binding-1",
            value: { subject_unique: true },
            observed_at: "2026-08-17T00:00:00.000Z",
          },
    ),
  };
}

type AdapterOutputs = Readonly<{
  plan?: unknown;
  start?: unknown;
  complete?: unknown;
  startFailure?: "unavailable" | "defect";
  completeFailure?: "unavailable" | "defect";
}>;

function unsafe<A>(value: unknown): A {
  return value as A;
}

function adapterFor(
  outputs: AdapterOutputs = {},
  calls: { start: number; complete: number } = { start: 0, complete: 0 },
  manifest: ProofProviderManifest = MANIFEST,
): VerificationProviderAdapter {
  return {
    manifest,
    plan: () =>
      Effect.succeed(unsafe(outputs.plan ?? { status: "supported", request_mode: "dynamic" })),
    start: () => {
      calls.start += 1;
      if (outputs.startFailure === "defect") return Effect.die("upstream secret");
      if (outputs.startFailure === "unavailable") {
        return Effect.fail(
          new VerificationProviderUnavailable({
            provider_id: manifest.provider_id,
            operation: "start",
          }),
        );
      }
      return Effect.succeed(unsafe<ProviderSessionStart>(outputs.start ?? startFor()));
    },
    complete: (input) => {
      calls.complete += 1;
      if (outputs.completeFailure === "defect") return Effect.die("upstream secret");
      if (outputs.completeFailure === "unavailable") {
        return Effect.fail(
          new VerificationProviderUnavailable({
            provider_id: manifest.provider_id,
            operation: "complete",
          }),
        );
      }
      return Effect.succeed(unsafe<EvidenceBundle>(outputs.complete ?? bundleFor(input.session)));
    },
  };
}

function failureOf(exit: Exit.Exit<unknown, unknown>): unknown {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.findError(exit.cause);
  return Result.isSuccess(failure) ? failure.success : undefined;
}

async function providerFor(adapter: VerificationProviderAdapter) {
  const registry = await Effect.runPromise(
    makeVerificationProviderRegistry([adapter], { now: () => NOW }),
  );
  return Effect.runPromise(registry.resolve(adapter.manifest.provider_id));
}

describe("verification registry adversarial corpus", () => {
  test("keeps request support distinct from runtime document coverage", async () => {
    const planInput = {
      method: START_INPUT.method,
      scope: START_INPUT.scope,
      requested_requirements: START_INPUT.requested_requirements,
      requested_claim_ids: START_INPUT.requested_claim_ids,
      subject_binding_intent: START_INPUT.subject_binding_intent,
      protocol_version: START_INPUT.protocol_version,
      environment: START_INPUT.environment,
    };
    for (const status of ["supported", "unsupported", "unknown"] as const) {
      const expected =
        status === "supported" ? { status, request_mode: "dynamic" as const } : { status };
      const provider = await providerFor(adapterFor({ plan: expected }));
      expect(await Effect.runPromise(provider.plan(planInput))).toEqual(expected);
    }

    const malformed = await providerFor(adapterFor({ plan: { status: "maybe" } }));
    const malformedExit = await Effect.runPromiseExit(malformed.plan(planInput));
    expect(failureOf(malformedExit)).toBeInstanceOf(VerificationProviderInvalidResponse);

    const modeEscape = await providerFor(
      adapterFor({ plan: { status: "supported", request_mode: "curated" } }),
    );
    const modeEscapeExit = await Effect.runPromiseExit(modeEscape.plan(planInput));
    expect(failureOf(modeEscapeExit)).toBeInstanceOf(VerificationProviderInvalidResponse);

    const futureManifest: ProofProviderManifest = {
      ...MANIFEST,
      provider_id: "future.arbitrary-provider",
      claim_capabilities: MANIFEST.claim_capabilities.map((capability) => ({
        ...capability,
        request_modes: ["curated"],
      })),
    };
    const future = await providerFor(
      adapterFor(
        { plan: { status: "supported", request_mode: "curated" } },
        { start: 0, complete: 0 },
        futureManifest,
      ),
    );
    expect(await Effect.runPromise(future.plan(planInput))).toEqual({
      status: "supported",
      request_mode: "curated",
    });
  });

  test("runtime-decodes inputs and rejects invalid requests before transport", async () => {
    const calls = { start: 0, complete: 0 };
    const provider = await providerFor(adapterFor({}, calls));
    for (const input of [
      { ...START_INPUT, request_hash: "not-a-hash" },
      { ...START_INPUT, request_hash: "f".repeat(64) },
      { ...START_INPUT, requested_claim_ids: [] },
      { ...START_INPUT, requested_claim_ids: ["document.valid", "document.valid"] },
      {
        ...START_INPUT,
        requested_requirements: [{ claim_id: "document.valid" }],
      },
      { ...START_INPUT, method: "other" },
      { ...START_INPUT, protocol_version: "other-v1" },
      { ...START_INPUT, environment: "production" },
      { ...START_INPUT, request_mode: "curated" },
      { ...START_INPUT, subject_binding_intent: "none" },
    ]) {
      const exit = await Effect.runPromiseExit(provider.start(unsafe(input)));
      expect(failureOf(exit)).toBeInstanceOf(VerificationProviderRejected);
    }
    expect(calls.start).toBe(0);
  });

  test("binds a privacy-preserving nationality assertion to the session allowlist", async () => {
    const nationalityManifest: ProofProviderManifest = {
      ...MANIFEST,
      claim_ids: ["nationality.allowed"],
      claim_capabilities: [{ claim_id: "nationality.allowed", request_modes: ["dynamic"] }],
    };
    const nationalityInput: VerificationProviderStartInput = {
      ...START_INPUT,
      request_hash: "45ab9cad760f1156977edbad6b4487517c2a5c4537ef4037e9170c24aef0fadd",
      requested_requirements: [{ claim_id: "nationality.allowed", allowed_countries: ["GE"] }],
      requested_claim_ids: ["nationality.allowed"],
    };
    const nationalitySession = sessionFor(nationalityInput);
    const commonAssertion = {
      id: "assertion-nationality",
      subject_key_id: "subject-1",
      evidence_receipt_id: "receipt-1",
      claim_id: "nationality.allowed" as const,
      assurance: "document_zk" as const,
      binding_group_id: "binding-1",
      observed_at: "2026-08-17T00:00:00.000Z",
    };
    const baseBundle = bundleFor(nationalitySession);
    const predicateOnly = {
      ...baseBundle,
      assertions: [{ ...commonAssertion, value: { allowed: true as const } }],
    };
    const provider = await providerFor(
      adapterFor(
        { start: startFor(nationalityInput), complete: predicateOnly },
        { start: 0, complete: 0 },
        nationalityManifest,
      ),
    );
    const started = await Effect.runPromise(provider.start(nationalityInput));
    const accepted = await Effect.runPromise(
      provider.complete({ session: started.session, submission: { callback: "signed" } }),
    );
    expect(accepted).toMatchObject({ id: "bundle-1" });

    const disclosedOutsideAllowlist = await providerFor(
      adapterFor(
        {
          start: startFor(nationalityInput),
          complete: {
            ...baseBundle,
            assertions: [
              {
                ...commonAssertion,
                value: { allowed: true, disclosed_nationality: "US" },
              },
            ],
          },
        },
        { start: 0, complete: 0 },
        nationalityManifest,
      ),
    );
    const invalid = await Effect.runPromiseExit(
      disclosedOutsideAllowlist.complete({
        session: nationalitySession,
        submission: { callback: "signed" },
      }),
    );
    expect(failureOf(invalid)).toBeInstanceOf(VerificationProviderInvalidResponse);
  });

  test("rejects every hostile start echo after transport", async () => {
    const base = startFor();
    const hostile: readonly unknown[] = [
      { session: base.session },
      { ...base, session: { ...base.session, status: "completed" } },
      { ...base, session: { ...base.session, expires_at: "2026-08-17T00:00:00.000Z" } },
      { ...base, session: { ...base.session, provider_id: "other.provider" } },
      { ...base, session: { ...base.session, actor_id: "other-user" } },
      { ...base, session: { ...base.session, intent_id: "other-intent" } },
      { ...base, session: { ...base.session, request_hash: "4".repeat(64) } },
      { ...base, session: { ...base.session, method: "other" } },
      { ...base, session: { ...base.session, request_mode: "curated" } },
      {
        ...base,
        session: {
          ...base.session,
          scope: { ...START_INPUT.scope, rp_scope: "other.test" },
        },
      },
      {
        ...base,
        session: {
          ...base.session,
          requested_requirements: [
            { claim_id: "age.minimum", minimum_age: "21" },
            { claim_id: "credential.subject_unique" },
          ],
        },
      },
      { ...base, session: { ...base.session, requested_claim_ids: ["document.valid"] } },
      {
        ...base,
        session: {
          ...base.session,
          requested_claim_ids: ["document.valid", "credential.subject_unique"],
        },
      },
      {
        ...base,
        session: {
          ...base.session,
          requested_claim_ids: ["document.valid", "document.valid"],
        },
      },
      { ...base, session: { ...base.session, protocol_version: "other-v1" } },
      { ...base, session: { ...base.session, environment: "production" } },
      { ...base, session: { ...base.session, subject_binding_intent: "recover" } },
      { ...base, presentation: { kind: "none", session_id: "other-session" } },
      {
        ...base,
        presentation: {
          kind: "redirect",
          session_id: base.session.id,
          url: "https://provider.test",
        },
      },
    ];
    for (const start of hostile) {
      const provider = await providerFor(adapterFor({ start }));
      const exit = await Effect.runPromiseExit(provider.start(START_INPUT));
      expect(failureOf(exit)).toBeInstanceOf(VerificationProviderInvalidResponse);
    }
  });

  test("rejects terminal replay, exact expiry, and action-scope evidence drift", async () => {
    const calls = { start: 0, complete: 0 };
    const provider = await providerFor(adapterFor({}, calls));
    for (const session of [
      { ...sessionFor(), status: "completed" },
      { ...sessionFor(), status: "failed" },
      { ...sessionFor(), expires_at: "2026-08-17T00:00:00.000Z" },
    ]) {
      const exit = await Effect.runPromiseExit(
        provider.complete({ session: unsafe(session), submission: {} }),
      );
      expect(failureOf(exit)).toBeInstanceOf(VerificationProviderRejected);
    }
    expect(calls.complete).toBe(0);

    const actionManifest: ProofProviderManifest = {
      ...MANIFEST,
      subject_key_scope_semantics: "issuer_rp_action_scope",
    };
    const actionInput: VerificationProviderStartInput = {
      ...START_INPUT,
      scope: {
        kind: "named",
        scope_semantics: "issuer_rp_action_scope",
        issuer: MANIFEST.provider_id,
        rp_scope: "pirate.test",
        action_scope: "campaign-a",
      },
    };
    const actionSession = sessionFor(actionInput);
    const actionProvider = await providerFor(
      adapterFor(
        { start: startFor(actionInput), complete: bundleFor(actionSession) },
        undefined,
        actionManifest,
      ),
    );
    const drift = await Effect.runPromiseExit(
      actionProvider.complete({
        session: {
          ...actionSession,
          scope: {
            kind: "named",
            scope_semantics: "issuer_rp_action_scope",
            issuer: MANIFEST.provider_id,
            rp_scope: "pirate.test",
            action_scope: "campaign-b",
          },
        },
        submission: {},
      }),
    );
    expect(failureOf(drift)).toBeInstanceOf(VerificationProviderInvalidResponse);
  });

  test("rejects partial fulfillment, every duplicate record set, and untyped claim values", async () => {
    const base = bundleFor();
    const hostile: readonly unknown[] = [
      { ...base, assertions: base.assertions.slice(0, 1) },
      { ...base, receipts: [...base.receipts, base.receipts[0]] },
      { ...base, subject_keys: [...base.subject_keys, base.subject_keys[0]] },
      { ...base, binding_groups: [...base.binding_groups, base.binding_groups[0]] },
      { ...base, assertions: [...base.assertions, base.assertions[0]] },
      {
        ...base,
        assertions: base.assertions.map((assertion, index) =>
          index === 0 ? { ...assertion, value: { meaningless: true } } : assertion,
        ),
      },
      { ...base, proof_session_id: "other-session" },
    ];
    for (const complete of hostile) {
      const provider = await providerFor(adapterFor({ complete }));
      const exit = await Effect.runPromiseExit(
        provider.complete({ session: sessionFor(), submission: {} }),
      );
      expect(failureOf(exit)).toBeInstanceOf(VerificationProviderInvalidResponse);
    }
  });

  test("preserves closed failures and redacts defects at both operations", async () => {
    for (const operation of ["start", "complete"] as const) {
      const unavailable = await providerFor(
        adapterFor(
          operation === "start"
            ? { startFailure: "unavailable" }
            : { completeFailure: "unavailable" },
        ),
      );
      const unavailableExit =
        operation === "start"
          ? await Effect.runPromiseExit(unavailable.start(START_INPUT))
          : await Effect.runPromiseExit(
              unavailable.complete({ session: sessionFor(), submission: {} }),
            );
      expect(failureOf(unavailableExit)).toBeInstanceOf(VerificationProviderUnavailable);

      const defective = await providerFor(
        adapterFor(
          operation === "start" ? { startFailure: "defect" } : { completeFailure: "defect" },
        ),
      );
      const defectExit =
        operation === "start"
          ? await Effect.runPromiseExit(defective.start(START_INPUT))
          : await Effect.runPromiseExit(
              defective.complete({ session: sessionFor(), submission: {} }),
            );
      expect(failureOf(defectExit)).toBeInstanceOf(VerificationProviderInvalidResponse);
    }
  });
});

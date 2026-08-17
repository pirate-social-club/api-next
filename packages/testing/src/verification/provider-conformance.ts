import type {
  ProviderSessionStart,
  VerificationProviderAdapter,
  VerificationProviderFailure,
  VerificationProviderPlanInput,
  VerificationProviderStartInput,
  VerificationSubmission,
} from "@pirate/application/verification";
import { makeVerificationProviderRegistry } from "@pirate/application/verification";
import type { SubjectScope } from "@pirate/domain/verification";
import { Cause, Effect, Exit, Result } from "effect";

export interface ProviderConformanceHarness {
  readonly adapter: VerificationProviderAdapter;
  readonly startInput: VerificationProviderStartInput;
  readonly submission: VerificationSubmission;
}

export interface ProviderTransportConformanceCase<Transport> {
  readonly name: string;
  readonly makeTransport: () => Transport;
  readonly makeAdapter: (transport: Transport) => VerificationProviderAdapter;
  readonly startInput: VerificationProviderStartInput;
  readonly submission: VerificationSubmission;
  readonly operation: "plan" | "start" | "complete";
  readonly tamperSession?: (
    session: ProviderSessionStart["session"],
  ) => ProviderSessionStart["session"];
  readonly expected: "success" | VerificationProviderFailure["_tag"];
  readonly assertTransport: (transport: Transport) => void;
}

function failureOf<A, E>(exit: Exit.Exit<A, E>): unknown {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.findError(exit.cause);
  return Result.isSuccess(failure) ? failure.success : undefined;
}

function outcomeOf<A, E>(
  exit: Exit.Exit<A, E>,
): {
  readonly success: boolean;
  readonly failure: unknown;
} {
  return { success: Exit.isSuccess(exit), failure: failureOf(exit) };
}

function sameScope(left: SubjectScope, right: SubjectScope): boolean {
  if (left.kind !== right.kind || left.issuer !== right.issuer) return false;
  if (left.kind === "none" && right.kind === "none") return true;
  if (left.kind !== "named" || right.kind !== "named") return false;
  if (left.scope_semantics !== right.scope_semantics || left.rp_scope !== right.rp_scope) {
    return false;
  }
  return left.scope_semantics === "issuer_rp_action_scope"
    ? right.scope_semantics === "issuer_rp_action_scope" && left.action_scope === right.action_scope
    : true;
}

function planInputOf(startInput: VerificationProviderStartInput): VerificationProviderPlanInput {
  return {
    method: startInput.method,
    scope: startInput.scope,
    requested_requirements: startInput.requested_requirements,
    requested_claim_ids: startInput.requested_claim_ids,
    subject_binding_intent: startInput.subject_binding_intent,
    protocol_version: startInput.protocol_version,
    environment: startInput.environment,
  };
}

/**
 * Provider-neutral happy ceremony. A real adapter supplies its own injected
 * fake transport, canonical request, and provider-shaped submission.
 */
export async function runProviderConformance(harness: ProviderConformanceHarness): Promise<{
  readonly provider: VerificationProviderAdapter;
  readonly sessionId: string;
  readonly evidenceBundleId: string;
}> {
  const { adapter, startInput, submission } = harness;
  const registry = await Effect.runPromise(makeVerificationProviderRegistry([adapter]));
  const manifests = registry.list();
  if (manifests.length !== 1 || manifests[0]?.provider_id !== adapter.manifest.provider_id) {
    throw new Error("provider manifest was not registered deterministically");
  }

  const provider = await Effect.runPromise(registry.resolve(adapter.manifest.provider_id));
  const planInput = planInputOf(startInput);
  const planned = await Effect.runPromise(provider.plan(planInput));
  if (
    planned.status !== "supported" ||
    planned.request_mode !== startInput.request_mode ||
    JSON.stringify(planned.provider_configuration) !==
      JSON.stringify(startInput.provider_configuration)
  ) {
    throw new Error("provider did not support its conformance request");
  }
  const started = await Effect.runPromise(provider.start(startInput));
  if (
    started.session.provider_id !== adapter.manifest.provider_id ||
    started.session.actor_id !== startInput.actor_id ||
    started.session.intent_id !== startInput.intent_id ||
    started.session.request_hash !== startInput.request_hash ||
    JSON.stringify(started.session.provider_configuration) !==
      JSON.stringify(startInput.provider_configuration) ||
    started.session.method !== startInput.method ||
    !sameScope(started.session.scope, startInput.scope) ||
    JSON.stringify(started.session.requested_requirements) !==
      JSON.stringify(startInput.requested_requirements) ||
    JSON.stringify(started.session.requested_claim_ids) !==
      JSON.stringify(startInput.requested_claim_ids) ||
    started.session.protocol_version !== startInput.protocol_version ||
    started.session.environment !== startInput.environment ||
    started.presentation.session_id !== started.session.id
  ) {
    throw new Error("provider session metadata was not preserved");
  }

  const bundle = await Effect.runPromise(
    provider.complete({ session: started.session, submission }),
  );
  const receiptIds = new Set(bundle.receipts.map((receipt) => receipt.id));
  const receiptsById = new Map(bundle.receipts.map((receipt) => [receipt.id, receipt]));
  const subjectIds = new Set(bundle.subject_keys.map((subjectKey) => subjectKey.id));
  const bindingIds = new Set(bundle.binding_groups.map((group) => group.id));
  const bindingsById = new Map(bundle.binding_groups.map((group) => [group.id, group]));
  const assertionClaims = new Set(bundle.assertions.map((assertion) => assertion.claim_id));
  if (
    bundle.proof_session_id !== started.session.id ||
    startInput.requested_claim_ids.some((claim) => !assertionClaims.has(claim)) ||
    bundle.receipts.some(
      (receipt) => receipt.subject_key_id !== undefined && !subjectIds.has(receipt.subject_key_id),
    ) ||
    bundle.receipts.some(
      (receipt) =>
        receipt.provider_id !== adapter.manifest.provider_id ||
        JSON.stringify(receipt.provider_configuration) !==
          JSON.stringify(startInput.provider_configuration) ||
        receipt.protocol_version !== startInput.protocol_version ||
        receipt.environment !== startInput.environment ||
        !sameScope(receipt.scope, startInput.scope),
    ) ||
    bundle.binding_groups.some((group) =>
      group.kind === "same_subject"
        ? !subjectIds.has(group.subject_key_id)
        : !receiptIds.has(group.evidence_receipt_id),
    ) ||
    bundle.assertions.some((assertion) => {
      const receipt = receiptsById.get(assertion.evidence_receipt_id);
      const binding = bindingsById.get(assertion.binding_group_id);
      return (
        !receiptIds.has(assertion.evidence_receipt_id) ||
        (assertion.subject_key_id !== undefined && !subjectIds.has(assertion.subject_key_id)) ||
        !bindingIds.has(assertion.binding_group_id) ||
        receipt?.subject_key_id !== assertion.subject_key_id ||
        (binding?.kind === "same_subject"
          ? binding.subject_key_id !== assertion.subject_key_id
          : binding?.kind === "same_receipt"
            ? binding.evidence_receipt_id !== assertion.evidence_receipt_id
            : true)
      );
    })
  ) {
    throw new Error("provider evidence references or metadata were not preserved");
  }

  return {
    provider,
    sessionId: started.session.id,
    evidenceBundleId: bundle.id,
  };
}

/**
 * Shared driver for real-adapter suites. Each case must construct the real
 * adapter over an injected deterministic upstream transport.
 */
export async function runProviderTransportConformance<Transport>(
  cases: readonly ProviderTransportConformanceCase<Transport>[],
): Promise<void> {
  for (const scenario of cases) {
    const transport = scenario.makeTransport();
    const adapter = scenario.makeAdapter(transport);
    const registry = await Effect.runPromise(makeVerificationProviderRegistry([adapter]));
    const provider = await Effect.runPromise(registry.resolve(adapter.manifest.provider_id));
    const planned = await Effect.runPromiseExit(provider.plan(planInputOf(scenario.startInput)));
    let outcome = outcomeOf(planned);
    if (scenario.operation !== "plan" && Exit.isSuccess(planned)) {
      if (
        planned.value.status !== "supported" ||
        planned.value.request_mode !== scenario.startInput.request_mode
      ) {
        throw new Error(`${scenario.name}: plan did not support the start request`);
      }
      const started = await Effect.runPromiseExit(provider.start(scenario.startInput));
      outcome = outcomeOf(started);
      if (scenario.operation === "complete" && Exit.isSuccess(started)) {
        outcome = outcomeOf(
          await Effect.runPromiseExit(
            provider.complete({
              session: scenario.tamperSession?.(started.value.session) ?? started.value.session,
              submission: scenario.submission,
            }),
          ),
        );
      }
    }
    scenario.assertTransport(transport);
    if (scenario.expected === "success") {
      if (!outcome.success) {
        throw new Error(`${scenario.name}: ${scenario.operation} expected success`);
      }
      continue;
    }
    const failure = outcome.failure as { readonly _tag?: string } | undefined;
    if (failure?._tag !== scenario.expected) {
      throw new Error(`${scenario.name}: ${scenario.operation} expected ${scenario.expected}`);
    }
  }
}

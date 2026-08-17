import type {
  VerificationProviderAdapter,
  VerificationProviderStartInput,
} from "@pirate/application/verification";
import {
  makeVerificationProviderRegistry,
  VerificationProviderDuplicate,
  VerificationProviderUnknown,
} from "@pirate/application/verification";
import { Cause, Effect, Exit, Result } from "effect";

const FAKE_RP_SCOPE = "test-rp";

export const FAKE_START_INPUT: VerificationProviderStartInput = {
  actor_id: "user-1",
  intent_id: "intent-1",
  request_hash: "1111111111111111111111111111111111111111111111111111111111111111",
  method: "document",
  scope: {
    kind: "named",
    issuer: "test.fake",
    rp_scope: FAKE_RP_SCOPE,
    scope_semantics: "issuer_rp_scope",
  },
  requested_claim_ids: ["document.valid", "credential.subject_unique"],
  protocol_version: "fake-v2",
  environment: "test",
};

function failureOf<A, E>(exit: Exit.Exit<A, E>): E | undefined {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.findError(exit.cause);
  return Result.isSuccess(failure) ? failure.success : undefined;
}

/**
 * A provider conformance fixture deliberately goes through the public registry
 * boundary. It proves that registration, presentation, evidence metadata, and
 * cross-record references work without importing contracts, routes, or an
 * engine implementation.
 */
export async function runProviderConformance(adapter: VerificationProviderAdapter): Promise<{
  readonly provider: VerificationProviderAdapter;
  readonly sessionId: string;
  readonly evidenceBundleId: string;
}> {
  const registry = await Effect.runPromise(makeVerificationProviderRegistry([adapter]));
  const manifests = registry.list();
  if (manifests.length !== 1 || manifests[0]?.provider_id !== adapter.manifest.provider_id) {
    throw new Error("provider manifest was not registered deterministically");
  }

  const provider = await Effect.runPromise(registry.resolve(adapter.manifest.provider_id));
  const started = await Effect.runPromise(provider.start(FAKE_START_INPUT));
  const startedScope = started.session.scope;
  if (
    started.session.provider_id !== adapter.manifest.provider_id ||
    started.session.intent_id !== FAKE_START_INPUT.intent_id ||
    started.session.request_hash !== FAKE_START_INPUT.request_hash ||
    started.session.protocol_version !== FAKE_START_INPUT.protocol_version ||
    started.session.environment !== FAKE_START_INPUT.environment ||
    startedScope.kind !== "named" ||
    startedScope.scope_semantics !== "issuer_rp_scope" ||
    startedScope.rp_scope !== FAKE_RP_SCOPE ||
    started.presentation.session_id !== started.session.id
  ) {
    throw new Error("provider session metadata was not preserved");
  }

  const bundle = await Effect.runPromise(
    provider.verify({
      session: started.session,
      submission: { kind: "fake-submission", request_hash: FAKE_START_INPUT.request_hash },
    }),
  );
  const receiptIds = new Set(bundle.receipts.map((receipt) => receipt.id));
  const receiptsById = new Map(bundle.receipts.map((receipt) => [receipt.id, receipt]));
  const subjectIds = new Set(bundle.subject_keys.map((subjectKey) => subjectKey.id));
  const bindingIds = new Set(bundle.binding_groups.map((group) => group.id));
  const bindingsById = new Map(bundle.binding_groups.map((group) => [group.id, group]));
  if (
    bundle.proof_session_id !== started.session.id ||
    bundle.receipts.some(
      (receipt) => receipt.subject_key_id !== undefined && !subjectIds.has(receipt.subject_key_id),
    ) ||
    bundle.receipts.some(
      (receipt) =>
        receipt.provider_id !== adapter.manifest.provider_id ||
        receipt.protocol_version !== FAKE_START_INPUT.protocol_version ||
        receipt.environment !== FAKE_START_INPUT.environment ||
        receipt.scope.kind !== "named" ||
        receipt.scope.scope_semantics !== "issuer_rp_scope" ||
        receipt.scope.rp_scope !== FAKE_RP_SCOPE,
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

  const unknown = await Effect.runPromiseExit(registry.resolve("missing.provider"));
  const unknownFailure = failureOf(unknown);
  if (!(unknownFailure instanceof VerificationProviderUnknown)) {
    throw new Error("unknown providers must fail with a typed registry error");
  }

  const duplicate = await Effect.runPromiseExit(
    makeVerificationProviderRegistry([adapter, adapter]),
  );
  const duplicateFailure = failureOf(duplicate);
  if (!(duplicateFailure instanceof VerificationProviderDuplicate)) {
    throw new Error("duplicate provider IDs must fail with a typed registry error");
  }

  return {
    provider,
    sessionId: started.session.id,
    evidenceBundleId: bundle.id,
  };
}

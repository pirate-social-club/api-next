/** Stand-in for a valid Very web claim ceremony; no provider or network calls. */
import type { VerificationProviderAdapter } from "@pirate/application/verification";
import {
  CURATED_HUMAN_MEMBERSHIP_POLICY,
  VERY_WEB_CONFIGURATION_REFERENCE,
  VERY_WEB_CONFIGURATION_VERSION,
  VERY_WEB_ISSUER,
  VERY_WEB_METHOD,
  VERY_WEB_PROTOCOL_VERSION,
  VERY_WEB_PROVIDER_ID,
  VERY_WEB_RP_SCOPE,
} from "@pirate/domain";
import type {
  EvidenceBundle,
  ProofProviderManifest,
  ProofSession,
} from "@pirate/domain/verification";
import { Effect } from "effect";

const configuration = {
  kind: "dynamic" as const,
  reference: VERY_WEB_CONFIGURATION_REFERENCE,
  version: VERY_WEB_CONFIGURATION_VERSION,
};

const manifest: ProofProviderManifest = {
  provider_id: VERY_WEB_PROVIDER_ID,
  manifest_version: "1",
  operation_deadlines: { plan_ms: 1000, start_ms: 15000, complete_ms: 50000, callback_ms: 1000 },
  callback_mode: "none",
  callback_header_allowlist: [],
  protocol_versions: [VERY_WEB_PROTOCOL_VERSION],
  environments: ["test"],
  supported_methods: [VERY_WEB_METHOD],
  claim_ids: ["human.personhood", "credential.subject_unique"],
  claim_capabilities: ["human.personhood", "credential.subject_unique"].map((claim_id) => ({
    claim_id: claim_id as "human.personhood" | "credential.subject_unique",
    request_modes: ["dynamic" as const],
  })),
  presentation_kinds: ["embedded_sdk"],
  assurance_levels: ["provider_attested"],
  subject_key_scope_semantics: "issuer_rp_scope",
};

function evidenceFor(session: ProofSession, subjectDigest: string): EvidenceBundle {
  if (session.scope.kind !== "named") throw new Error("expected named Very scope");
  const suffix = session.id;
  const subjectId = `claim-ceremony-subject-${suffix}`;
  const receiptId = `claim-ceremony-receipt-${suffix}`;
  const bindingId = `claim-ceremony-binding-${suffix}`;
  const evidenceHash = session.id.replaceAll("-", "").slice(-32).repeat(2);
  const observedAt = new Date().toISOString();
  return {
    id: `claim-ceremony-bundle-${suffix}`,
    proof_session_id: session.id,
    subject_keys: [
      {
        id: subjectId,
        issuer: session.scope.issuer,
        method: session.method,
        scope: session.scope,
        subject_digest: subjectDigest,
      },
    ],
    receipts: [
      {
        id: receiptId,
        proof_session_id: session.id,
        provider_id: session.provider_id,
        issuer: session.scope.issuer,
        method: session.method,
        scope: session.scope,
        provider_configuration: session.provider_configuration,
        protocol_version: session.protocol_version,
        environment: session.environment,
        provenance_kind: "proof_session",
        evidence_kind: "very.web.server-verified.v1",
        evidence_hash: evidenceHash,
        observed_at: observedAt,
        subject_key_id: subjectId,
      },
    ],
    binding_groups: [{ id: bindingId, kind: "same_subject", subject_key_id: subjectId }],
    assertions: [
      {
        id: `claim-ceremony-unique-${suffix}`,
        subject_key_id: subjectId,
        evidence_receipt_id: receiptId,
        claim_id: "credential.subject_unique",
        value: { subject_unique: true },
        assurance: "provider_attested",
        binding_group_id: bindingId,
        observed_at: observedAt,
      },
      {
        id: `claim-ceremony-personhood-${suffix}`,
        subject_key_id: subjectId,
        evidence_receipt_id: receiptId,
        claim_id: "human.personhood",
        value: { personhood: true },
        assurance: "provider_attested",
        binding_group_id: bindingId,
        observed_at: observedAt,
      },
    ],
  };
}

export function makeRewardClaimVeryStub(subjectDigest: string): VerificationProviderAdapter {
  return {
    manifest,
    plan: (input) =>
      Effect.succeed(
        input.method === VERY_WEB_METHOD &&
          input.scope.kind === "named" &&
          input.scope.issuer === VERY_WEB_ISSUER &&
          input.scope.rp_scope === VERY_WEB_RP_SCOPE &&
          input.verification_purpose?.intent === "community_join" &&
          input.verification_purpose.policy_id === CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id
          ? { status: "supported", request_mode: "dynamic", provider_configuration: configuration }
          : { status: "unsupported" },
      ),
    start: (input) => {
      const now = new Date();
      const session: ProofSession = {
        id: `claim-ceremony-${crypto.randomUUID()}`,
        actor_id: input.actor_id,
        intent_id: input.intent_id,
        request_hash: input.request_hash,
        provider_id: VERY_WEB_PROVIDER_ID,
        method: input.method,
        scope: input.scope,
        request_mode: input.request_mode,
        provider_configuration: input.provider_configuration,
        requested_requirements: input.requested_requirements,
        requested_claim_ids: input.requested_claim_ids,
        subject_binding_intent: input.subject_binding_intent,
        protocol_version: input.protocol_version,
        environment: input.environment,
        status: "pending",
        started_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 300_000).toISOString(),
      };
      return Effect.succeed({
        session,
        presentation: {
          kind: "embedded_sdk",
          session_id: session.id,
          protocol: "very-widget",
          version: "1",
          payload: { fixture: true },
        },
      });
    },
    complete: (input) => Effect.succeed(evidenceFor(input.session, subjectDigest)),
  };
}

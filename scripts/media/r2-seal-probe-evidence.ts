import type { ScenarioName, SealFixture } from "./r2-seal-probe-fixtures";

export type ProbeOutcome =
  | "success"
  | "source_missing"
  | "expectation_mismatch"
  | "conditional_precondition_ambiguous"
  | "verification_mismatch"
  | "provider_response_unknown"
  | "transport_error";

export type ProofScope = "local-only" | "inconclusive";
export type DiagnosticScope = "none" | "transport-ambiguous";
export type FixtureIntent =
  | "none"
  | "source-overwrite"
  | "destination-conflict"
  | "destination-race"
  | "source-and-destination-race"
  | "ambiguous-412";
export type VersionBinding = "matched" | "unavailable" | "mismatch";
export type VerificationFailure =
  | "none"
  | "destination_missing"
  | "provider_error"
  | "etag_mismatch"
  | "size_mismatch"
  | "content_type_mismatch"
  | "checksum_mismatch"
  | "version_unavailable"
  | "version_mismatch";

export type ScenarioEvidence = Readonly<{
  name: ScenarioName;
  outcome: ProbeOutcome;
  proof_scope: ProofScope;
  diagnostic_scope: DiagnosticScope;
  fixture_intent: FixtureIntent;
  source_key: string;
  destination_key: string;
  expected_size_bytes: number;
  expected_content_type: string;
  expected_sha256: string | null;
  observed_source_etag: string | null;
  observed_source_size_bytes: number | null;
  observed_source_content_type: string | null;
  observed_source_sha256: string | null;
  observed_source_version_id: string | null;
  observed_destination_etag: string | null;
  observed_destination_size_bytes: number | null;
  observed_destination_content_type: string | null;
  observed_destination_sha256: string | null;
  observed_destination_version_id: string | null;
  version_binding: VersionBinding;
  verification_failure: VerificationFailure;
  source_head_calls: number;
  source_head_status: number | null;
  source_head_code: string | null;
  conditional_copy_calls: number;
  conditional_copy_status: number | null;
  conditional_copy_code: string | null;
  destination_head_calls: number;
  destination_head_status: number | null;
  destination_head_code: string | null;
  automatic_retry: false;
  destination_verified: boolean;
}>;

export type ProbeEvidence = Readonly<{
  schema_version: "r2-seal-evidence-v1";
  run: Readonly<{
    run_id: "local-r2-seal-dry-run-v1";
    started_at: "1970-01-01T00:00:00.000Z";
    completed_at: "1970-01-01T00:00:00.000Z";
    deterministic: true;
  }>;
  account_id: null;
  bucket: null;
  mode: "local-dry-run";
  transport: "fake";
  provider_contacted: false;
  credentials_read: false;
  scenarios: readonly ScenarioEvidence[];
  cleanup: Readonly<{
    status: "not-run";
    attempted: false;
    objects_removed: 0;
    reason: "local-fake-has-no-external-objects";
  }>;
  safety: Readonly<{
    ambiguous_precondition_is_terminal: true;
    conditional_copy_is_never_retried: true;
    destination_verification_uses_one_head_on_success: true;
    secrets_emitted: false;
  }>;
  remaining_live_proof_questions: readonly string[];
}>;

const REMAINING_LIVE_PROOF_QUESTIONS = [
  "The production contract must ratify an ambiguous conditional outcome, a conservative precedence rule, or another sealing protocol because R2 exposes the source and destination conditional failures through the same HTTP 412 PreconditionFailed response.",
  "Production dependence on the beta cf-copy-destination-if-none-match extension is unratified and must be decided before a production sealing adapter is accepted.",
  "Staging must determine whether SHA-256 checksums and destination VersionId are available and bindable; this harness checks an optional local SHA and modeled VersionId but never infers unavailable live metadata.",
  "An authorized staging transcript must bind account, bucket, object keys, observed ETags, parsed statuses/codes, timestamps, and cleanup while recording no credential, URL, header, body, or secret value.",
] as const;

function fixtureIntent(name: ScenarioName): FixtureIntent {
  switch (name) {
    case "source-overwritten-before-copy":
      return "source-overwrite";
    case "destination-conflict":
      return "destination-conflict";
    case "destination-appears-before-copy":
      return "destination-race";
    case "simultaneous-source-destination-race":
      return "source-and-destination-race";
    case "ambiguous-412":
      return "ambiguous-412";
    default:
      return "none";
  }
}

export function emptyScenarioEvidence(fixture: SealFixture): ScenarioEvidence {
  return {
    name: fixture.name,
    outcome: "transport_error",
    proof_scope: "inconclusive",
    diagnostic_scope: "transport-ambiguous",
    fixture_intent: fixtureIntent(fixture.name),
    source_key: fixture.sourceKey,
    destination_key: fixture.destinationKey,
    expected_size_bytes: fixture.expectedSizeBytes,
    expected_content_type: fixture.expectedContentType,
    expected_sha256: fixture.expectedSha256 ?? null,
    observed_source_etag: null,
    observed_source_size_bytes: null,
    observed_source_content_type: null,
    observed_source_sha256: null,
    observed_source_version_id: null,
    observed_destination_etag: null,
    observed_destination_size_bytes: null,
    observed_destination_content_type: null,
    observed_destination_sha256: null,
    observed_destination_version_id: null,
    version_binding: "unavailable",
    verification_failure: "none",
    source_head_calls: 0,
    source_head_status: null,
    source_head_code: null,
    conditional_copy_calls: 0,
    conditional_copy_status: null,
    conditional_copy_code: null,
    destination_head_calls: 0,
    destination_head_status: null,
    destination_head_code: null,
    automatic_retry: false,
    destination_verified: false,
  };
}

type InternalEvidence = Readonly<{ scenarios: readonly ScenarioEvidence[] }>;

const FORBIDDEN_EVIDENCE_VALUE =
  /(?:https?:\/\/|authorization|x-amz-(?:credential|signature)|(?:credential|signature)=|[\r\n])/i;

function safeValue(value: string | null, field: string): string | null {
  if (value !== null && FORBIDDEN_EVIDENCE_VALUE.test(value)) {
    throw new Error(`unsafe ${field} value refused by evidence allowlist`);
  }
  return value;
}

function projectScenarioEvidence(scenario: ScenarioEvidence): ScenarioEvidence {
  return {
    name: scenario.name,
    outcome: scenario.outcome,
    proof_scope: scenario.proof_scope,
    diagnostic_scope: scenario.diagnostic_scope,
    fixture_intent: scenario.fixture_intent,
    source_key: safeValue(scenario.source_key, "source_key") ?? "",
    destination_key: safeValue(scenario.destination_key, "destination_key") ?? "",
    expected_size_bytes: scenario.expected_size_bytes,
    expected_content_type: safeValue(scenario.expected_content_type, "expected_content_type") ?? "",
    expected_sha256: safeValue(scenario.expected_sha256, "expected_sha256"),
    observed_source_etag: safeValue(scenario.observed_source_etag, "observed_source_etag"),
    observed_source_size_bytes: scenario.observed_source_size_bytes,
    observed_source_content_type: safeValue(
      scenario.observed_source_content_type,
      "observed_source_content_type",
    ),
    observed_source_sha256: safeValue(scenario.observed_source_sha256, "observed_source_sha256"),
    observed_source_version_id: safeValue(
      scenario.observed_source_version_id,
      "observed_source_version_id",
    ),
    observed_destination_etag: safeValue(
      scenario.observed_destination_etag,
      "observed_destination_etag",
    ),
    observed_destination_size_bytes: scenario.observed_destination_size_bytes,
    observed_destination_content_type: safeValue(
      scenario.observed_destination_content_type,
      "observed_destination_content_type",
    ),
    observed_destination_sha256: safeValue(
      scenario.observed_destination_sha256,
      "observed_destination_sha256",
    ),
    observed_destination_version_id: safeValue(
      scenario.observed_destination_version_id,
      "observed_destination_version_id",
    ),
    version_binding: scenario.version_binding,
    verification_failure: scenario.verification_failure,
    source_head_calls: scenario.source_head_calls,
    source_head_status: scenario.source_head_status,
    source_head_code: safeValue(scenario.source_head_code, "source_head_code"),
    conditional_copy_calls: scenario.conditional_copy_calls,
    conditional_copy_status: scenario.conditional_copy_status,
    conditional_copy_code: safeValue(scenario.conditional_copy_code, "conditional_copy_code"),
    destination_head_calls: scenario.destination_head_calls,
    destination_head_status: scenario.destination_head_status,
    destination_head_code: safeValue(scenario.destination_head_code, "destination_head_code"),
    automatic_retry: false,
    destination_verified: scenario.destination_verified,
  };
}

/** Project evidence through a key and value allowlist before emitting it. */
export function redactEvidence(input: InternalEvidence): ProbeEvidence {
  const scenarios = input.scenarios.map(projectScenarioEvidence);
  return {
    schema_version: "r2-seal-evidence-v1",
    run: {
      run_id: "local-r2-seal-dry-run-v1",
      started_at: "1970-01-01T00:00:00.000Z",
      completed_at: "1970-01-01T00:00:00.000Z",
      deterministic: true,
    },
    account_id: null,
    bucket: null,
    mode: "local-dry-run",
    transport: "fake",
    provider_contacted: false,
    credentials_read: false,
    scenarios,
    cleanup: {
      status: "not-run",
      attempted: false,
      objects_removed: 0,
      reason: "local-fake-has-no-external-objects",
    },
    safety: {
      ambiguous_precondition_is_terminal: true,
      conditional_copy_is_never_retried: true,
      destination_verification_uses_one_head_on_success: true,
      secrets_emitted: false,
    },
    remaining_live_proof_questions: REMAINING_LIVE_PROOF_QUESTIONS,
  };
}

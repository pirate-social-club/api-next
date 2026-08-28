import { createHash } from "node:crypto";

const STAGING_HOST_SUFFIX = "-staging.workers.dev";
const lockedKeys = ["kind", "content_rating", "next_action"] as const;

export type AcceptanceEvidence = {
  readonly origin: string;
  readonly attestation: {
    readonly before_restricted_status: number;
    readonly after_attestation_status: number;
  };
  readonly locked_resources: readonly unknown[];
  readonly rating_ancestry: {
    readonly parent_rating: "general" | "adult_18";
    readonly child_rating: "general" | "adult_18";
    readonly raised_parent_rating: "adult_18";
    readonly raised_descendant_ratings: readonly ("general" | "adult_18")[];
  };
  readonly prospectivity: {
    readonly evaluation_revision_before_policy_change: string;
    readonly evaluation_revision_after_policy_change: string;
  };
  readonly legacy_action: {
    readonly fresh_status: number;
    readonly fresh_reason_code: string;
    readonly committed_body: unknown;
    readonly replay_body: unknown;
  };
  readonly authority: {
    readonly owner_status: number;
    readonly non_owner_status: number;
  };
  readonly text_provider: {
    readonly clean_status: "published";
    readonly flagged_status: "manual_review" | "blocked";
    readonly disabled_status: "manual_review";
  };
  readonly cover: {
    readonly clean_artifact_projected: true;
    readonly withheld_artifact_ref: null;
    readonly withheld_public_fetch_status: 403 | 404;
  };
};

export type AcceptanceResult = {
  readonly environment: "staging";
  readonly checks: number;
  readonly evidence_sha256: string;
};

export class ModerationAcceptanceError extends Error {
  constructor(
    readonly code: "invalid-input" | "not-staging" | "acceptance-failed",
    message: string,
  ) {
    super(message);
    this.name = "ModerationAcceptanceError";
  }
}

const fail = (message: string): never => {
  throw new ModerationAcceptanceError("acceptance-failed", message);
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ModerationAcceptanceError("invalid-input", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertLockedResource(value: unknown): void {
  const resource = object(value, "locked resource");
  if (Object.keys(resource).sort().join(",") !== [...lockedKeys].sort().join(",")) {
    fail("Age-locked resources must contain exactly the three ratified fields.");
  }
  const nextAction = object(resource.next_action, "locked resource next_action");
  if (
    resource.kind !== "age_locked" ||
    resource.content_rating !== "adult_18" ||
    Object.keys(nextAction).sort().join(",") !== "kind,minimum_age" ||
    nextAction.kind !== "verify_minimum_age" ||
    nextAction.minimum_age !== 18
  ) {
    fail("Age-locked resource does not match AgeLockedResourceV1.");
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function verifyModerationStagingEvidence(evidence: AcceptanceEvidence): AcceptanceResult {
  let origin: URL;
  try {
    origin = new URL(evidence.origin);
  } catch {
    throw new ModerationAcceptanceError("invalid-input", "origin must be an absolute URL.");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    (!origin.hostname.endsWith(STAGING_HOST_SUFFIX) && origin.hostname !== "localhost")
  ) {
    throw new ModerationAcceptanceError(
      "not-staging",
      "Evidence verification is refused unless origin is an explicit staging Worker or localhost.",
    );
  }

  if (evidence.attestation.before_restricted_status < 400) {
    fail("A pre-attestation authenticated route was not restricted.");
  }
  if (evidence.attestation.after_attestation_status !== 200) {
    fail("The same authenticated route did not recover after attestation.");
  }
  if (evidence.locked_resources.length < 3) {
    fail("Feed, detail, and public-thread locked resources are all required.");
  }
  evidence.locked_resources.forEach(assertLockedResource);

  if (
    evidence.rating_ancestry.parent_rating !== "adult_18" ||
    evidence.rating_ancestry.child_rating !== "adult_18" ||
    evidence.rating_ancestry.raised_descendant_ratings.some((rating) => rating !== "adult_18")
  ) {
    fail("Comment rating ancestry or descendant raising failed.");
  }
  if (
    evidence.prospectivity.evaluation_revision_before_policy_change !==
    evidence.prospectivity.evaluation_revision_after_policy_change
  ) {
    fail("An existing evaluation changed after a prospective policy update.");
  }
  if (
    evidence.legacy_action.fresh_status !== 409 ||
    evidence.legacy_action.fresh_reason_code !== "contract_version_unsupported"
  ) {
    fail("A fresh V1 moderation action was not refused by the compatibility fence.");
  }
  if (
    stable(evidence.legacy_action.committed_body) !== stable(evidence.legacy_action.replay_body)
  ) {
    fail("A committed V1 action did not replay byte-semantically identically.");
  }
  if (evidence.authority.owner_status !== 200 || evidence.authority.non_owner_status !== 404) {
    fail("Owner authorization or non-owner not-found redaction failed.");
  }
  if (
    evidence.text_provider.clean_status !== "published" ||
    !["manual_review", "blocked"].includes(evidence.text_provider.flagged_status) ||
    evidence.text_provider.disabled_status !== "manual_review"
  ) {
    fail("Text provider allow, flag, or disabled fail-closed behavior failed.");
  }
  if (
    evidence.cover.clean_artifact_projected !== true ||
    evidence.cover.withheld_artifact_ref !== null ||
    ![403, 404].includes(evidence.cover.withheld_public_fetch_status)
  ) {
    fail("Cover projection or restricted-object boundary failed.");
  }

  return {
    environment: "staging",
    checks: 18,
    evidence_sha256: createHash("sha256").update(stable(evidence)).digest("hex"),
  };
}

async function main(): Promise<void> {
  const text = await Bun.stdin.text();
  let evidence: AcceptanceEvidence;
  try {
    evidence = JSON.parse(text) as AcceptanceEvidence;
  } catch {
    throw new ModerationAcceptanceError("invalid-input", "Evidence must be valid JSON on stdin.");
  }
  console.log(JSON.stringify(verifyModerationStagingEvidence(evidence)));
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(
      error instanceof ModerationAcceptanceError ? error.message : "Verification failed.",
    );
    process.exitCode = 1;
  });
}

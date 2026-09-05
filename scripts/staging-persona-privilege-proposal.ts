import {
  loadStagingResetArtifacts,
  validateStagingResetArtifacts,
} from "./staging-persona-reset-plan";

/** Review proposal, not GRANT SQL or execution authority. Explicit rows are
 * generated from the pinned baseline rather than copied from old database ACLs.
 */
export function draftStagingPrivilegeProposal() {
  const artifacts = loadStagingResetArtifacts();
  const plan = validateStagingResetArtifacts(artifacts);
  const names = (kind: "TABLE" | "SEQUENCE") =>
    [...artifacts.baseline.matchAll(new RegExp(`^CREATE ${kind} ([a-z_][a-z0-9_]*)[ (]`, "gm"))]
      .map((match) => match[1] as string)
      .sort();
  const tables = names("TABLE");
  const sequences = [
    ...names("SEQUENCE"),
    ...[...artifacts.baseline.matchAll(/^\s*SEQUENCE NAME ([a-z_][a-z0-9_]*)\s*$/gm)].map(
      (match) => match[1] as string,
    ),
  ].sort();
  if (
    tables.length === 0 ||
    new Set(tables).size !== tables.length ||
    new Set(sequences).size !== sequences.length
  ) {
    throw new Error("reset_privilege_proposal_catalog_invalid");
  }
  return {
    version: 1,
    status: "draft_requires_owner_review",
    execution_authorized: false,
    source_sha: plan.sourceSha,
    baseline_sha256: plan.baselineSha256,
    role_binding: "runtime SQL identity must be independently verified before use",
    rationale:
      "Shared application runtime reads and mutates product tables; migrations and schema ownership remain operator-only. This broad per-table proposal is not a claim of minimum privileges for every individual operation.",
    default_acl_recommendation:
      "Keep the two observed runtime defaults for the paired rollout, subject to explicit owner approval; assess tighter per-operation privileges separately.",
    observed_default_acl_sha256: "f0973701f1b93a794190b0a16ab24126ff6bda647a0d4476f6a00f9d75b2329d",
    entries: [
      {
        role: "runtime",
        object: "api_next",
        kind: "schema",
        privileges: ["USAGE"],
        grant_option: false,
      },
      ...tables
        .filter((name) => name !== "schema_migrations")
        .map((name) => ({
          role: "runtime",
          object: `api_next.${name}`,
          kind: "table",
          privileges: ["SELECT", "INSERT", "UPDATE", "DELETE"],
          grant_option: false,
        })),
      ...sequences.map((name) => ({
        role: "runtime",
        object: `api_next.${name}`,
        kind: "sequence",
        privileges: ["SELECT", "UPDATE", "USAGE"],
        grant_option: false,
      })),
    ],
    unresolved: [
      "The table default also affects schema_migrations. Review an explicit runtime ledger-write denial; the current positive-only reconciler does not implement that override.",
      "Review exact EXECUTE grants for the fenced HNS and song-policy routines separately; the migrations revoke PUBLIC and supply no named runtime grants.",
      "This proposal is not complete or executable until the routine and ledger dispositions plus runtime binding have been approved.",
    ],
  };
}

if (import.meta.main) {
  if (Bun.argv.length !== 3 || Bun.argv[2] !== "--draft")
    throw new Error("only --draft is supported");
  console.log(JSON.stringify(draftStagingPrivilegeProposal(), null, 2));
}

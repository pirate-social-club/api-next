import { describe, expect, test } from "bun:test";

const migration = await Bun.file(
  new URL("../../../db/postgres/migrations/0044_optional_route_v2.sql", import.meta.url),
).text();
const contentRepository = await Bun.file(
  new URL("./content-repository.ts", import.meta.url),
).text();
const textSubmissionRepository = await Bun.file(
  new URL("./text-submission-repository.ts", import.meta.url),
).text();

describe("optional-route-v2 migration authority", () => {
  test("pins generated-id creation to one human requirement and no namespace requirement", () => {
    expect(migration).toContain(
      "creation_contract_version IN ('legacy_slug_v1', 'route_v1', 'optional_route_v2')",
    );
    expect(migration).toContain("human_count <> 1 OR namespace_count <> 0");
    expect(migration).toContain("committed_resource_href = '/c/' || committed_community_id");
    expect(migration).toContain("canonical_route_binding_id IS NOT NULL");
    expect(migration).toContain("route_authority_version <> 'route_v1'");
  });

  test("keeps attachment authority in a sibling aggregate", () => {
    for (const table of [
      "community_route_attachment_intents",
      "community_route_attachment_requirement_states",
      "community_route_attachment_ceremony_attempts",
      "community_route_attachment_ceremony_results",
      "community_route_attachment_intent_revisions",
    ]) {
      expect(migration).toContain(`CREATE TABLE ${table}`);
    }
    expect(migration).toContain(
      "requirement_kind TEXT NOT NULL CHECK (requirement_kind = 'namespace_ownership')",
    );
    expect(migration).toContain("route attachment is only available to an unrouted community");
    expect(migration).toContain("community_route_attachment_intents_one_open_per_community_uidx");
    expect(migration).toContain("WHERE status IN ('verification_required', 'commit_ready')");
    expect(migration).toContain("community_route_operator_override_audit");
    expect(migration).toContain("guard_community_route_attachment_requirement_state");
    expect(migration).toContain("validate_community_route_attachment_attempt_insert");
    expect(migration).toContain("validate_community_route_attachment_result_insert");
    expect(migration).toContain("validate_community_route_attachment_evidence_insert");
    expect(migration).toContain("validate_community_route_attachment_binding_insert");
    expect(migration).toContain(
      "route attachment commit requires the community to remain unrouted",
    );
    expect(migration).toContain("WHERE community_id = NEW.community_id\n   FOR UPDATE");
    expect(migration).toContain("route attachment result does not match current requirement state");
    expect(migration).toContain("attempt_record.attachment_intent_id <> NEW.attachment_intent_id");
    expect(migration).toContain("'authority_version', 'optional_route_v2'");
  });

  test("stores only binding lifecycle states and scopes the generic effect predicate", () => {
    expect(migration).not.toMatch(/route_lifecycle_status[^\n]*none/u);
    const predicate = migration.slice(
      migration.indexOf("CREATE OR REPLACE FUNCTION active_community_effect"),
    );
    expect(predicate).toContain("community.status = 'active'");
    expect(predicate).toContain("membership.status = 'member'");
    expect(predicate).not.toContain("effective_active_route");
    expect(predicate).not.toContain("community_canonical_route_bindings");
  });

  test("keeps posting and voting effects independent of namespace-route state", () => {
    expect(contentRepository).toContain("SELECT active_community_effect($1, $2) AS allowed");
    expect(contentRepository).not.toContain("effective_active_route");
    expect(textSubmissionRepository).toContain("SELECT active_community_effect($1, $2) AS allowed");
    expect(textSubmissionRepository).not.toContain("effective_active_route");
    expect(textSubmissionRepository).toContain("moderation-action.approve.active-community-effect");
  });
});

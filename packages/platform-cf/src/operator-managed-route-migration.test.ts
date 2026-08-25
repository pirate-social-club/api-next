import { describe, expect, test } from "bun:test";

const migration = await Bun.file(
  new URL("../../../db/postgres/migrations/0047_hns_operator_managed_routes.sql", import.meta.url),
).text();
const publicRouteMigration = await Bun.file(
  new URL("../../../db/postgres/migrations/0049_bare_hns_community_route_v2.sql", import.meta.url),
).text();
const routeRepository = await Bun.file(
  new URL("./community-route-repository.ts", import.meta.url),
).text();

describe("operator-managed route migration authority", () => {
  test("keeps verified and operator-managed authority exactly discriminated", () => {
    expect(migration).toContain(
      "route_authority_kind IN ('verified_namespace_v1', 'operator_managed_route_v1')",
    );
    expect(migration).toContain("route_authority_kind = 'operator_managed_route_v1'");
    expect(migration).toContain("ownership_status <> 'verified'");
    expect(migration).toContain("verified_evidence_ref IS NULL");
    expect(migration).toContain("CREATE FUNCTION effective_route_authority_v2");
    expect(migration).toContain("FROM effective_active_route(expected_community_id, database_now)");
    expect(publicRouteMigration).toContain(
      "FROM effective_route_authority_v2(expected_community_id, database_now) AS route",
    );
    expect(routeRepository).toContain("effective_public_community_route_v2");
  });

  test("retains exact registry bytes and derives root admission from them", () => {
    expect(migration).toContain("operator_managed_root_registry_versions_exact_bytes");
    expect(migration).toContain("encode(sha256(registry_bytes), 'hex') = registry_digest");
    expect(migration).toContain("is_operator_managed_root_registry_document");
    expect(migration).toContain("convert_from(exact_bytes, 'UTF8') <> canonical_document");
    expect(migration).toContain("operator_managed_registry_has_active_root");
    expect(migration).toContain("current operator-managed registry cannot remove an active route");
  });

  test("rechecks platform authority and fences activation and revocation", () => {
    expect(migration).toContain("platform_operator_route_authority_grants");
    expect(migration).toContain("authority.status <> 'active'");
    expect(migration).toContain("activate_operator_managed_route_v1");
    expect(migration).toContain("revoke_operator_managed_route_v1");
    expect(migration).toContain("operator-managed route activation idempotency conflict");
    expect(migration).toContain("operator-managed route revocation fence does not match");
    expect(migration).toContain("operator_route_activation_generation + 1");
  });

  test("keeps operator route authority out of ownership evidence and commerce", () => {
    expect(migration).toContain("effective_active_route");
    expect(migration).toContain("binding.route_authority_kind = 'verified_namespace_v1'");
    expect(migration).not.toMatch(
      /INSERT INTO community_route_ownership_evidence[\s\S]*operator_managed/u,
    );
  });
});

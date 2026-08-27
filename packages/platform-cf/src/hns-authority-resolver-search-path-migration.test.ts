import { expect, test } from "bun:test";

const migration = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0067_hns_authority_resolver_search_path.sql",
    import.meta.url,
  ),
).text();

test("the authority resolver graph captures its installation schema", () => {
  expect(migration).toContain("installed_schema TEXT := current_schema()");
  expect(migration).toContain("effective_active_route(TEXT, TIMESTAMPTZ) SET search_path");
  expect(migration).toContain("effective_route_authority_v2(TEXT, TIMESTAMPTZ) SET search_path");
  expect(migration).toContain(
    "resolve_hns_community_app_host_authority_v1(TEXT, TIMESTAMPTZ) SET search_path",
  );
  expect(migration.match(/pg_temp/gu)?.length).toBe(4);
});

test("the VPS gateway selects the production resolver schema explicitly", async () => {
  const gateway = await Bun.file(
    new URL("./hns-community-app-gateway-authority-postgres.ts", import.meta.url),
  ).text();
  const repository = await Bun.file(
    new URL("./hns-host-persistence-repository.ts", import.meta.url),
  ).text();
  expect(gateway).toContain('{ authority_schema: "api_next" }');
  expect(repository).toContain('"api_next.resolve_hns_community_app_host_authority_v1"');
});

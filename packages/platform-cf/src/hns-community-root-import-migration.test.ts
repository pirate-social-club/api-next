import { describe, expect, test } from "bun:test";

const migration = await Bun.file(
  new URL("../../../db/postgres/migrations/0114_hns_community_root_import.sql", import.meta.url),
).text();

describe("community HNS root-import migration", () => {
  test("keeps provider sessions attachment-owned", () => {
    expect(migration).toContain("CREATE TABLE community_route_attachment_start_reservations");
    expect(migration).toContain("CREATE TABLE hns_community_root_import_preparations");
    expect(migration).toContain("CREATE TABLE community_route_attachment_namespace_sessions");
    expect(migration).toContain(
      "REFERENCES community_route_attachment_intents(actor_id, attachment_intent_id)",
    );
    expect(migration).not.toContain("community_creation_intents(actor_id, intent_id)");
  });

  test("gives root imports an exclusive creation-or-attachment origin", () => {
    expect(migration).toContain("origin_kind = 'creation_intent'");
    expect(migration).toContain("origin_kind = 'community_attachment'");
    expect(migration).toContain("AND creation_intent_id IS NULL");
    expect(migration).toContain("AND attachment_intent_id IS NOT NULL");
    expect(migration).toContain("HNS root-import session origin is invalid");
  });

  test("preserves explicit activation as the only ready successor", () => {
    expect(migration).toContain("OLD.status = 'ready' AND NEW.status IN ('activated', 'expired')");
    expect(migration).not.toContain("OLD.status = 'ready' AND NEW.status = 'committed'");
  });
});

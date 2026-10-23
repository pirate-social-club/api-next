import { describe, expect, test } from "bun:test";
import { notificationTriggerShapeVariants } from "../../../tests/postgres/notifications-trigger-shape.pg-fixture.ts";
import {
  assertNotificationErasurePrivileges,
  NOTIFICATION_ERASURE_BOUNDARIES,
  NotificationErasurePrivilegesRefused,
  notificationErasurePrivilegeParameters,
} from "./notification-erasure-privileges.ts";

const ready = (writer = true) =>
  NOTIFICATION_ERASURE_BOUNDARIES.map(([name, boundary]) => ({
    runtime_role: "erasure_fixture",
    session_role: "erasure_fixture",
    object_name: String(name),
    boundary: String(boundary),
    role_safe: true,
    schema_usage: true,
    schema_create: false,
    owner_equivalent: false,
    account_status_executor: writer,
    public_status_authority: false,
    users_select: writer,
    inherited_status_authority: false,
    forward_destructive_default: false,
    guards_valid: true,
    anchored_owner: true,
    object_exists: true,
    can_select: boundary === "inbox",
    can_delete: boundary === "inbox" && writer,
    excessive_table_authority: false,
    direct_delete: boundary === "inbox" && writer,
    delete_grant_option: false,
    public_delete: false,
    private_access: false,
    inherited_unsafe: false,
  }));
const fact = (rows: ReturnType<typeof ready>, name: string) => {
  const row = rows.find((row) => row.object_name === name);
  if (!row) throw new Error("Privilege test row is missing");
  return row;
};

describe("bounded Notifications account-status executor admission", () => {
  test("the real catalog fixture retains forty trigger negatives and adds exact current function security drift", async () => {
    const ddl = (
      await Bun.file(
        new URL("../../../db/postgres/migrations/0271_notifications_inbox.sql", import.meta.url),
      ).text()
    ).replace(/\s+/gu, " ");
    const variants = notificationTriggerShapeVariants(); // Pure builder; no SQL/client call.
    expect(variants).toHaveLength(46);
    expect(new Set(variants.map(({ guard, name }) => `${guard.table}/${name}`)).size).toBe(46);
    expect(variants.filter(({ securityDefiner }) => securityDefiner !== undefined)).toHaveLength(4);
    expect(variants.filter(({ searchPath }) => searchPath !== undefined)).toHaveLength(2);
    expect(
      variants
        .filter(({ searchPath }) => searchPath !== undefined)
        .every(({ guard }) => guard.table === "notification_inbox"),
    ).toBe(true);
    for (const table of [
      "users",
      "notification_inbox",
      "notification_publication_deliveries",
      "content_publication_outbox",
    ]) {
      const selected = variants.filter(({ guard }) => guard.table === table);
      const first = selected[0];
      if (!first) throw new Error("Retained guard variant required");
      const { guard } = first;
      expect(ddl).toContain(
        `CREATE TRIGGER ${guard.trigger} ${guard.timing} ${guard.events} ON ${guard.table} FOR EACH ROW EXECUTE FUNCTION ${guard.fn}();`,
      );
      expect(selected.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          "missing-trigger",
          "expected-function-absent",
          "wrong-timing",
          "statement-not-row",
          "false-WHEN",
          "unexpected-argument",
          "wrong-update-columns",
          "missing-UPDATE",
        ]),
      );
      if (table !== "users")
        expect(selected.some(({ name }) => name === "missing-DELETE")).toBe(true);
      if (table === "users")
        expect(selected.some(({ name }) => name === "unrestricted-UPDATE")).toBe(true);
    }
    expect(
      variants
        .filter(({ name }) => name === "missing-INSERT")
        .map(({ guard }) => guard.table)
        .sort(),
    ).toEqual(["notification_inbox", "notification_publication_deliveries"]);
    expect(
      variants
        .filter(({ rebound }) => rebound)
        .map(({ name }) => name)
        .sort(),
    ).toEqual(["expected-function-absent-and-rebound", "rebound-function"]);
  });
  test("admits the actual direct LOGIN executor without requiring receipt UPDATE", () => {
    expect(assertNotificationErasurePrivileges(ready())).toBe("erasure_fixture");
    expect(Object.keys(fact(ready(), "notification_publication_deliveries"))).not.toContain(
      "can_update",
    );
  });
  test("a non-status caller needs no erasure grant and must not have inbox DELETE", () => {
    expect(assertNotificationErasurePrivileges(ready(false))).toBe("erasure_fixture");
    const rows = ready(false);
    fact(rows, "notification_inbox").can_delete = true;
    fact(rows, "notification_inbox").direct_delete = true;
    expect(() => assertNotificationErasurePrivileges(rows)).toThrow("privileges refused");
  });
  test("one invalid guard result among otherwise valid rows cannot be ignored", () => {
    for (const [name] of NOTIFICATION_ERASURE_BOUNDARIES) {
      for (const guards_valid of [false, null, undefined, "true", 0]) {
        const rows = ready().map((row) =>
          row.object_name === name ? { ...row, guards_valid } : row,
        );
        expect(() => assertNotificationErasurePrivileges(rows)).toThrow(
          NotificationErasurePrivilegesRefused,
        );
      }
    }
  });
  test.each([
    "role_safe",
    "schema_usage",
    "guards_valid",
    "anchored_owner",
    "object_exists",
    "users_select",
    "can_select",
    "can_delete",
    "direct_delete",
  ] as const)("refuses a missing required %s fact", (field) => {
    const rows = ready();
    fact(rows, "notification_inbox")[field] = false;
    expect(() => assertNotificationErasurePrivileges(rows)).toThrow(
      NotificationErasurePrivilegesRefused,
    );
  });
  test.each([
    "schema_create",
    "owner_equivalent",
    "public_status_authority",
    "inherited_status_authority",
    "forward_destructive_default",
    "excessive_table_authority",
    "delete_grant_option",
    "public_delete",
    "inherited_unsafe",
  ] as const)("refuses excessive or reachable %s authority", (field) => {
    const rows = ready();
    fact(rows, "notification_inbox")[field] = true;
    expect(() => assertNotificationErasurePrivileges(rows)).toThrow(
      NotificationErasurePrivilegesRefused,
    );
  });
  test("an inherited DELETE does not substitute for the explicitly bounded direct grant", () => {
    const rows = ready();
    fact(rows, "notification_inbox").direct_delete = false;
    expect(() => assertNotificationErasurePrivileges(rows)).toThrow(
      NotificationErasurePrivilegesRefused,
    );
  });
  test("every retained/private boundary rejects newly effective or reachable authority", () => {
    for (const [name, boundary] of NOTIFICATION_ERASURE_BOUNDARIES) {
      if (boundary === "inbox") continue;
      const rows = ready();
      if (boundary === "function" || boundary === "private") fact(rows, name).private_access = true;
      else fact(rows, name).can_delete = true;
      expect(() => assertNotificationErasurePrivileges(rows)).toThrow(
        NotificationErasurePrivilegesRefused,
      );
      const inherited = ready();
      fact(inherited, name).inherited_unsafe = true;
      expect(() => assertNotificationErasurePrivileges(inherited)).toThrow(
        NotificationErasurePrivilegesRefused,
      );
    }
  });
  test("fails closed on missing, duplicate, unexpected, malformed and inconsistent login facts", () => {
    expect(() => assertNotificationErasurePrivileges([])).toThrow(
      NotificationErasurePrivilegesRefused,
    );
    expect(() => assertNotificationErasurePrivileges(ready().slice(1))).toThrow(
      NotificationErasurePrivilegesRefused,
    );
    const duplicate = ready();
    duplicate[1] = { ...fact(duplicate, "notification_inbox") };
    expect(() => assertNotificationErasurePrivileges(duplicate)).toThrow(
      NotificationErasurePrivilegesRefused,
    );
    for (const mutate of [
      (rows: ReturnType<typeof ready>) => {
        fact(rows, "notification_inbox").object_name = "unexpected";
      },
      (rows: ReturnType<typeof ready>) => {
        fact(rows, "notification_inbox").boundary = "private";
      },
      (rows: ReturnType<typeof ready>) => {
        fact(rows, "notification_inbox").session_role = "administrator";
      },
      (rows: ReturnType<typeof ready>) => {
        fact(rows, "notification_publication_deliveries").runtime_role = "another-login";
      },
      (rows: ReturnType<typeof ready>) => {
        fact(rows, "notification_publication_deliveries").account_status_executor = false;
      },
    ]) {
      const rows = ready();
      mutate(rows);
      expect(() => assertNotificationErasurePrivileges(rows)).toThrow(
        NotificationErasurePrivilegesRefused,
      );
    }
    expect(() =>
      assertNotificationErasurePrivileges([
        { ...fact(ready(), "notification_inbox"), role_safe: "true" },
      ]),
    ).toThrow(NotificationErasurePrivilegesRefused);
  });
  test("the portable operator policy grants only inbox DELETE and does not change defaults or receipt authority", async () => {
    const source = await Bun.file(
      new URL("../../../db/postgres/roles.sql.example", import.meta.url),
    ).text();
    const policy = source
      .split("-- Notifications account erasure grants begin")[1]
      ?.split("-- Notifications account erasure grants end")[0];
    if (!policy) throw new Error("Owned operator erasure block missing");
    expect(policy.trim()).toBe("GRANT DELETE ON notification_inbox TO api_next_app;");
    expect(source).toContain("GRANT SELECT, INSERT, UPDATE ON TABLES TO api_next_app");
    expect(source).not.toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO api_next_app");
    expect(new Set(NOTIFICATION_ERASURE_BOUNDARIES.map(([name]) => name)).size).toBe(
      NOTIFICATION_ERASURE_BOUNDARIES.length,
    );
    expect(notificationErasurePrivilegeParameters("owned-schema")[0]).toBe("owned-schema");
  });
});

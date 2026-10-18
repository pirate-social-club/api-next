/** Parent-executed catalog drift proof, not application DDL or a serving repair.
 * Only catalog queries run while a guard is weakened; every variant restores
 * the exact captured definitions/function identity/ownership before returning. */
import { expect } from "bun:test";
import type { Client } from "pg";
import {
  assertNotificationErasurePrivileges,
  NOTIFICATION_ERASURE_BOUNDARIES,
  NOTIFICATION_ERASURE_PRIVILEGES_SQL,
  NotificationErasurePrivilegesRefused,
  notificationErasurePrivilegeParameters,
} from "../../packages/platform-cf/src/notification-erasure-privileges.ts";

const guards = [
  {
    table: "users",
    trigger: "users_delete_notification_inbox",
    fn: "delete_recipient_notification_inbox_v1",
    timing: "AFTER",
    events: "UPDATE OF status",
    narrowed: "UPDATE OF user_id",
  },
  {
    table: "notification_inbox",
    trigger: "notification_inbox_guard",
    fn: "guard_notification_inbox_v1",
    timing: "BEFORE",
    events: "INSERT OR UPDATE OR DELETE",
    narrowed: "INSERT OR UPDATE OF read_at OR DELETE",
  },
  {
    table: "notification_publication_deliveries",
    trigger: "notification_delivery_guard",
    fn: "guard_notification_delivery_v1",
    timing: "BEFORE",
    events: "INSERT OR UPDATE OR DELETE",
    narrowed: "INSERT OR UPDATE OF notification_id OR DELETE",
  },
  {
    table: "content_publication_outbox",
    trigger: "comment_notification_fact_guard",
    fn: "guard_comment_notification_fact_v1",
    timing: "BEFORE",
    events: "UPDATE OR DELETE",
    narrowed: "UPDATE OF state OR DELETE",
  },
] as const;
type Guard = (typeof guards)[number];
type Mutation = {
  readonly name: string;
  readonly guard: Guard;
  readonly timing?: "BEFORE" | "AFTER";
  readonly events?: string;
  readonly statement?: true;
  readonly whenFalse?: true;
  readonly argument?: true;
  readonly missingTrigger?: true;
  readonly renameExpected?: true;
  readonly rebound?: true;
};

export function notificationTriggerShapeVariants(): readonly Mutation[] {
  const result: Mutation[] = [];
  for (const guard of guards) {
    result.push(
      { guard, name: "missing-trigger", missingTrigger: true },
      { guard, name: "expected-function-absent", renameExpected: true },
      { guard, name: "wrong-timing", timing: guard.timing === "BEFORE" ? "AFTER" : "BEFORE" },
      { guard, name: "statement-not-row", statement: true },
      { guard, name: "false-WHEN", whenFalse: true },
      { guard, name: "unexpected-argument", argument: true },
      { guard, name: "wrong-update-columns", events: guard.narrowed },
      {
        guard,
        name: "missing-UPDATE",
        events: guard.table === "users" ? "DELETE" : guard.events.replace("UPDATE OR ", ""),
      },
    );
    if (guard.table !== "users")
      result.push({
        guard,
        name: "missing-DELETE",
        events: guard.events.replace(" OR DELETE", ""),
      });
    if (
      guard.table === "notification_inbox" ||
      guard.table === "notification_publication_deliveries"
    )
      result.push({ guard, name: "missing-INSERT", events: "UPDATE OR DELETE" });
    if (guard.table === "users")
      result.push({ guard, name: "unrestricted-UPDATE", events: "UPDATE" });
    if (guard.table === "notification_publication_deliveries")
      result.push(
        { guard, name: "rebound-function", rebound: true },
        {
          guard,
          name: "expected-function-absent-and-rebound",
          renameExpected: true,
          rebound: true,
        },
      );
  }
  return result;
}

type CatalogGuard = {
  readonly table_name: string;
  readonly trigger_name: string;
  readonly definition: string;
  readonly function_oid: string;
  readonly function_name: string;
  readonly function_definition: string;
  readonly function_owner: string;
  readonly table_owner: string;
  readonly schema_owner: string;
};
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

export async function exerciseNotificationTriggerShapeNegatives(input: {
  readonly admin: Client;
  readonly runtime: Client;
  readonly schema: string;
  readonly executor: string;
}): Promise<void> {
  const { admin, runtime, schema, executor } = input;
  if (
    !/^api_next_notifications_[0-9a-f]{32}$/u.test(schema) ||
    !/^notifications_acl_[0-9a-f]{32}$/u.test(executor)
  )
    throw new Error("Owned disposable Notifications scope required");
  const catalog = async () =>
    (
      await admin.query<CatalogGuard>(
        `SELECT c.relname AS table_name,t.tgname AS trigger_name,
    pg_get_triggerdef(t.oid) AS definition,p.oid::text AS function_oid,p.proname AS function_name,
    pg_get_functiondef(p.oid) AS function_definition,
    pg_get_userbyid(p.proowner) AS function_owner,pg_get_userbyid(c.relowner) AS table_owner,
    pg_get_userbyid(n.nspowner) AS schema_owner
    FROM pg_namespace n JOIN pg_class c ON c.relnamespace=n.oid
    JOIN pg_trigger t ON t.tgrelid=c.oid JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE n.nspname=$1::text AND t.tgname=ANY($2::text[])
    ORDER BY t.tgname`,
        [schema, guards.map((guard) => guard.trigger)],
      )
    ).rows;
  const facts = async () =>
    (
      await runtime.query<Record<string, unknown>>(NOTIFICATION_ERASURE_PRIVILEGES_SQL, [
        ...notificationErasurePrivilegeParameters(schema),
      ])
    ).rows;
  const baseline = await catalog();
  expect(baseline).toHaveLength(4);
  for (const guard of guards) {
    const row = baseline.find((row) => row.trigger_name === guard.trigger);
    if (!row || row.table_name !== guard.table || row.function_name !== guard.fn)
      throw new Error("Retained guard binding missing before mutation");
    expect(row.function_owner).toBe(row.schema_owner);
    expect(row.table_owner).toBe(row.schema_owner);
  }
  const baselineFacts = await facts();
  expect(assertNotificationErasurePrivileges(baselineFacts)).toBe(executor);
  const ordered = (rows: readonly Record<string, unknown>[]) =>
    [...rows].sort((a, b) => String(a.object_name).localeCompare(String(b.object_name)));
  const withoutGuard = (rows: readonly Record<string, unknown>[]) =>
    ordered(rows).map(({ guards_valid: _guard, ...row }) => row);

  const variants = notificationTriggerShapeVariants();
  expect(variants).toHaveLength(40);
  for (const mutation of variants) {
    const { guard } = mutation;
    const original = baseline.find((row) => row.trigger_name === guard.trigger);
    if (!original) throw new Error("Original definition required");
    const table = `${quote(schema)}.${quote(guard.table)}`;
    const expectedFn = `${quote(schema)}.${quote(guard.fn)}()`;
    const temporary = `notifications_shape_${crypto.randomUUID().replaceAll("-", "")}`;
    const temporaryFn = `${quote(schema)}.${quote(temporary)}()`;
    const identity = `${guard.table}/${mutation.name}`;
    expect(
      (await admin.query("SELECT to_regprocedure($1)::text AS existing", [temporaryFn])).rows,
    ).toEqual([{ existing: null }]);
    let primary: unknown;
    let failed = false;
    const cleanup: unknown[] = [];
    const restore = async () => {
      const current = (
        await admin.query<{ name: string; owner: string }>(
          "SELECT proname AS name,pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid=$1::oid",
          [original.function_oid],
        )
      ).rows[0];
      if (
        !current ||
        current.owner !== original.function_owner ||
        (current.name !== guard.fn && current.name !== temporary)
      )
        throw new Error("Unexpected function identity/ownership blocks restoration");
      await admin.query("BEGIN");
      await admin.query(`DROP TRIGGER IF EXISTS ${quote(guard.trigger)} ON ${table}`);
      if (current.name === temporary)
        await admin.query(`ALTER FUNCTION ${temporaryFn} RENAME TO ${quote(guard.fn)}`);
      await admin.query(original.definition);
      await admin.query("COMMIT");
      expect(await catalog(), identity).toEqual(baseline);
      expect(ordered(await facts()), identity).toEqual(ordered(baselineFacts));
    };
    try {
      await admin.query("BEGIN");
      if (mutation.renameExpected)
        await admin.query(`ALTER FUNCTION ${expectedFn} RENAME TO ${quote(temporary)}`);
      // A rename-only case preserves the original trigger's OID binding but
      // makes the required named function lookup NULL: the old bool_and hole.
      if (!mutation.renameExpected || mutation.rebound) {
        await admin.query(`DROP TRIGGER ${quote(guard.trigger)} ON ${table}`);
        if (!mutation.missingTrigger) {
          const fn = mutation.rebound ? "guard_notification_inbox_v1" : guard.fn;
          await admin.query(`CREATE TRIGGER ${quote(guard.trigger)}
            ${mutation.timing ?? guard.timing} ${mutation.events ?? guard.events} ON ${table}
            FOR EACH ${mutation.statement ? "STATEMENT" : "ROW"}
            ${mutation.whenFalse ? "WHEN (FALSE)" : ""}
            EXECUTE FUNCTION ${quote(schema)}.${quote(fn)}(${mutation.argument ? "'unexpected'" : ""})`);
        }
      }
      await admin.query("COMMIT"); // Separate real LOGIN must see the drift.
      if (mutation.renameExpected)
        expect(
          (await admin.query("SELECT to_regprocedure($1)::text AS expected", [expectedFn])).rows,
        ).toEqual([{ expected: null }]);
      const altered = await facts();
      expect(altered, identity).toHaveLength(NOTIFICATION_ERASURE_BOUNDARIES.length);
      expect(
        altered.every((row) => row.guards_valid === false),
        identity,
      ).toBe(true);
      expect(withoutGuard(altered), identity).toEqual(withoutGuard(baselineFacts));
      let refused = false;
      try {
        assertNotificationErasurePrivileges(altered);
      } catch (error) {
        if (!(error instanceof NotificationErasurePrivilegesRefused)) throw error;
        refused = true;
        expect([...error.failures].sort(), identity).toEqual(
          NOTIFICATION_ERASURE_BOUNDARIES.map(([name]) => `${name}: guards_valid refused`).sort(),
        );
      }
      expect(refused, identity).toBe(true);
    } catch (error) {
      failed = true;
      primary = error;
    } finally {
      // Never blindly replay an uncertain DDL transaction. End any open one,
      // inspect the retained function's OID/name/owner, then restore once.
      try {
        await admin.query("ROLLBACK");
      } catch (error) {
        cleanup.push(error);
      }
      try {
        await restore();
      } catch (error) {
        cleanup.push(error);
        try {
          await admin.query("ROLLBACK");
        } catch (rollback) {
          cleanup.push(rollback);
        }
      }
    }
    if (failed && cleanup.length)
      throw new AggregateError(
        [primary, ...cleanup],
        `Guard catalog proof/restore failed: ${identity}`,
        { cause: primary },
      );
    if (failed) throw primary;
    if (cleanup.length)
      throw new AggregateError(cleanup, `Guard catalog restore failed: ${identity}`);
  }
}

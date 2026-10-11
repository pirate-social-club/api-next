import { expect, test } from "bun:test";
import {
  assertTelegramActivationPrivileges,
  TELEGRAM_ACTIVATION_TABLES,
} from "./telegram-activation-privileges.ts";

const healthy = () =>
  TELEGRAM_ACTIVATION_TABLES.map(([table_name, expected_delete]) => ({
    runtime_role: "restricted_executor",
    table_name,
    expected_delete,
    expected_truncate: false,
    schema_usage: true,
    table_exists: true,
    owner_equivalent: false,
    can_select: true,
    can_insert: true,
    can_update: true,
    can_delete: expected_delete,
    can_truncate: false,
  }));
test("exact effective executor facts admit only the bounded privileges", () => {
  expect(assertTelegramActivationPrivileges(healthy())).toBe("restricted_executor");
});
for (const [table] of TELEGRAM_ACTIVATION_TABLES) {
  for (const field of [
    "schema_usage",
    "table_exists",
    "owner_equivalent",
    "can_select",
    "can_insert",
    "can_update",
    "can_delete",
    "can_truncate",
  ] as const) {
    test(`${table} refuses incorrect ${field}`, () => {
      const rows = healthy();
      const row = rows.find((item) => item.table_name === table);
      if (!row) throw Error("fixture absent");
      row[field] = !row[field];
      expect(() => assertTelegramActivationPrivileges(rows)).toThrow("admission refused");
    });
  }
}
test("missing, duplicate, mixed-role and malformed catalogue evidence fails closed", () => {
  expect(() => assertTelegramActivationPrivileges([])).toThrow();
  const rows = healthy();
  expect(() => assertTelegramActivationPrivileges(rows.slice(1))).toThrow();
  expect(() =>
    assertTelegramActivationPrivileges(
      rows.map((row, index) => (index === 1 ? { ...row, table_name: rows[0]?.table_name } : row)),
    ),
  ).toThrow();
  expect(() =>
    assertTelegramActivationPrivileges(
      rows.map((row, i) => ({ ...row, runtime_role: i ? "other_role" : row.runtime_role })),
    ),
  ).toThrow();
  expect(() =>
    assertTelegramActivationPrivileges(rows.map((row) => ({ ...row, can_delete: "true" }))),
  ).toThrow();
});

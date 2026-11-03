import { expect, test } from "bun:test";
import {
  assertTelegramCommunityCataloguePrivileges,
  makeTelegramCommunityStudyCatalogue,
} from "./telegram-community-study-catalogue.ts";
import type { TelegramDatabase } from "./telegram-database.ts";

const allowed = {
  runtime_role: "serving",
  schema_usage: true,
  owner_equivalent: false,
  can_select: true,
  can_insert: false,
  can_update: false,
  can_delete: false,
  can_truncate: false,
};
test("community catalogue setup refuses missing access, owner privilege and every write grant", async () => {
  const db = (rows: readonly Record<string, unknown>[]): TelegramDatabase => ({
    query: async () => rows,
    transaction: async () => {
      throw Error("unexpected transaction");
    },
  });
  await assertTelegramCommunityCataloguePrivileges(db([allowed]));
  for (const rows of [
    [],
    [allowed, allowed],
    [{ ...allowed, can_select: false }],
    [{ ...allowed, schema_usage: false }],
    ...["owner_equivalent", "can_insert", "can_update", "can_delete", "can_truncate"].map((key) => [
      { ...allowed, [key]: true },
    ]),
  ]) {
    await expect(assertTelegramCommunityCataloguePrivileges(db(rows))).rejects.toMatchObject({
      category: "permission_refused",
    });
  }
});
test("bounded catalogue pages bind community, admitted policy and direct song readiness separately", async () => {
  const requests: readonly unknown[][] = [];
  const calls = requests as unknown[][];
  const db: TelegramDatabase = {
    query: async (_sql, values = []) => {
      calls.push([...values]);
      return values[4]
        ? [{ post_id: values[4], title: "Ninth" }]
        : Array.from({ length: 9 }, (_, index) => ({
            post_id: `post-${index}`,
            title: `Song ${index}`,
          }));
    },
    transaction: async () => {
      throw Error("unexpected transaction");
    },
  };
  const catalogue = makeTelegramCommunityStudyCatalogue(db, "reviewed-policy");
  const page = await catalogue.page("community");
  expect(page.items).toHaveLength(8);
  expect(page.nextCursor).toBe("post-7");
  expect(await catalogue.ready("community", "post-9")).toBe(true);
  expect(calls).toEqual([
    ["community", null, "reviewed-policy", null, null],
    ["community", null, "reviewed-policy", null, "post-9"],
  ]);
});

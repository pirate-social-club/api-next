import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { REWARD_SHUTDOWN_PREDICATES } from "../rewards-binding-deploy-preflight.ts";
import { assertShutdownInventory, isolatedDatabase } from "./database-evidence.mjs";

test("an obligation in any shutdown family or a missing category refuses acceptance", () => {
  const categories = [
    ...REWARD_SHUTDOWN_PREDICATES.map(([category]) => category),
    "unresolved_winner_sends",
  ];
  const cleared = Object.fromEntries(categories.map((category) => [category, "0"]));
  expect(assertShutdownInventory(cleared).nothingOwed).toBe(true);
  for (const category of categories) {
    expect(() => assertShutdownInventory({ ...cleared, [category]: "1" })).toThrow(category);
    expect(() => assertShutdownInventory({ ...cleared, [category]: undefined })).toThrow(category);
  }
});

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const isolatedHost = "aws-us-east-1-3.pg.psdb.cloud";
const identity = {
  branchId: "l8mhyb0fxy54",
  branchName: "rewards-runner-20261004",
  hostname: isolatedHost,
  usernameSha256: sha256("admin-role"),
  runtimeUsernameSha256: sha256("runtime-role"),
};
const url = (user: string, host = isolatedHost) =>
  `postgres://${user}:secret@${host}:5432/postgres`;

test("only the isolated database branch is accepted, before any connection is opened", () => {
  // Building the handle validates and connects to nothing; reads and writes connect later.
  expect(typeof isolatedDatabase(identity, url("admin-role"), url("runtime-role")).read).toBe(
    "function",
  );
  // The production branch, the shared staging branch and any other are refused
  // even when every other part of the identity is self-consistent.
  for (const branchId of ["mqfaju65wdm3", "ojbnlrgihio8", "anotherbranch"])
    expect(() =>
      isolatedDatabase({ ...identity, branchId }, url("admin-role"), url("runtime-role")),
    ).toThrow("Runner branch differs");
});

test("credentials for another host or another role are refused before any connection", () => {
  const productionHost = "aws-us-east-1-4.pg.psdb.cloud";
  for (const [admin, runtime] of [
    [url("admin-role", productionHost), url("runtime-role")],
    [url("admin-role"), url("runtime-role", productionHost)],
    [url("someone-else"), url("runtime-role")],
    [url("admin-role"), url("someone-else")],
    ["https://example.invalid/", url("runtime-role")],
  ])
    expect(() => isolatedDatabase(identity, admin, runtime)).toThrow(
      "Isolated database identity mismatch",
    );
});

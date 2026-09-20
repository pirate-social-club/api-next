import { expect, test } from "bun:test";
import { parseAvatarRemoval } from "./remove-avatar.ts";

const id = "avatar-11111111-1111-4111-8111-111111111111";
const args = ["--database-url-env", "AVATAR_OPERATOR_DATABASE", "--asset-id", id];
test("avatar removal requires an exact asset and explicit apply", () => {
  expect(parseAvatarRemoval(args)).toEqual({
    variable: "AVATAR_OPERATOR_DATABASE",
    assetId: id,
    apply: false,
  });
  expect(parseAvatarRemoval([...args, "--apply"]).apply).toBe(true);
  for (const invalid of [
    [],
    [...args, "--apply", "--apply"],
    [...args, "--asset-id", id],
    [...args, "--force"],
    ["--database-url-env", "postgres://secret", "--asset-id", id],
    ["--database-url-env", "DB", "--asset-id", "*"],
  ]) {
    expect(() => parseAvatarRemoval(invalid)).toThrow();
  }
});

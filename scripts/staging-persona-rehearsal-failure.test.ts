import { expect, test } from "bun:test";
import { describeRehearsalFailure } from "./staging-persona-rehearsal-failure";

test("failure evidence excludes driver text, details and causes", () => {
  const error = Object.assign(
    new Error("postgres://private:secret@example.invalid/database", {
      cause: new Error("private-cause"),
    }),
    { code: "57014", detail: "private-detail" },
  );
  const result = describeRehearsalFailure(error);
  expect(result.sqlstate).toBe("57014");
  expect(result.message_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toContain("private");
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(describeRehearsalFailure({ code: "invalid-private" })).toEqual({
    sqlstate: null,
    message_sha256: null,
  });
});

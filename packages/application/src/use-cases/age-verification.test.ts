import { expect, test } from "bun:test";
import { Effect } from "effect";
import { AgeVerificationStoreError, getMyAgeVerification } from "./age-verification.ts";

test("age authority uses the authenticated account and grants no action on its behalf", async () => {
  const accounts: string[] = [];
  const store = {
    getVerification: ({ accountId }: { accountId: string }) => {
      accounts.push(accountId);
      return Effect.succeed({
        version: "account-age-verification-v1",
        minimum_age: 18,
        status: "verified",
      } as const);
    },
  };
  for (const actor of [
    { kind: "user", userId: "account-a" },
    { kind: "admin", userId: "account-b", scopes: [] },
  ] as const) {
    expect(
      await Effect.runPromise(getMyAgeVerification({ actor }, { ageVerificationStore: store })),
    ).toMatchObject({ status: "verified" });
  }
  expect(accounts).toEqual(["account-a", "account-b"]);
});
test("invalid accounts never reach storage and storage errors remain private", async () => {
  let calls = 0;
  const store = {
    getVerification: () => {
      calls++;
      return Effect.fail(new AgeVerificationStoreError());
    },
  };
  for (const userId of ["", " account", "account "]) {
    await expect(
      Effect.runPromise(
        getMyAgeVerification({ actor: { kind: "user", userId } }, { ageVerificationStore: store }),
      ),
    ).rejects.toMatchObject({ _tag: "BadRequest" });
  }
  expect(calls).toBe(0);
  await expect(
    Effect.runPromise(
      getMyAgeVerification(
        { actor: { kind: "user", userId: "account" } },
        { ageVerificationStore: store },
      ),
    ),
  ).rejects.toMatchObject({ _tag: "InternalError", message: "Age verification is unavailable" });
  expect(calls).toBe(1);
});

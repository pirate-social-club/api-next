import { describe, expect, test } from "bun:test";
import {
  ControlPlaneDb,
  type ControlPlaneResult,
  type ControlPlaneStatement,
} from "@pirate/application";
import { Cause, Effect, Exit, Result } from "effect";
import {
  DataRegistrationSigningIntentReadFailed,
  makeDataRegistrationSigningIntentReader,
} from "./signing-intent-reader";

const row = (overrides: Record<string, unknown> = {}) => ({
  submission_attempt_id: "registration-1:attempt:1",
  registration_operation_id: "registration-1",
  chain_id: "1315",
  attempt_number: "1",
  signer_namespace: "data-registration-staging",
  signer_address: `0x${"1".repeat(40)}`,
  signing_intent_id: "registration-1:attempt:1:signing-intent",
  target_address: `0x${"2".repeat(40)}`,
  method_selector: "0x12345678",
  calldata_hash: "a".repeat(64),
  signing_deadline: new Date("2026-08-27T00:04:00.000Z"),
  value_wei: "0",
  gas_limit: "1500000",
  max_fee_per_gas: "5000000000",
  max_priority_fee_per_gas: "2000000000",
  nonce: "7",
  signed_transaction: null,
  signed_transaction_hash: null,
  transaction_hash: null,
  supersedes_submission_attempt_id: null,
  state: "nonce_reserved",
  failure_code: null,
  failure_evidence_ref: null,
  ...overrides,
});

const db = (
  rows: readonly Record<string, unknown>[],
  calls: ControlPlaneStatement[],
): ControlPlaneDb["Service"] => {
  const execute = <Row = unknown>(
    statement: ControlPlaneStatement,
  ): Effect.Effect<ControlPlaneResult<Row>, never> => {
    calls.push(statement);
    return Effect.succeed({ rows: rows as readonly Row[], rowCount: rows.length });
  };
  return {
    execute,
    withTransaction: <A, E, R>(
      use: (transaction: { execute: typeof execute }) => Effect.Effect<A, E, R>,
    ) => use({ execute }),
  } satisfies ControlPlaneDb["Service"];
};

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.findError(exit.cause);
  if (!Result.isSuccess(failure)) throw new Error("expected typed failure");
  return failure.success;
};

describe("DATA registration signing intent reader", () => {
  test("reloads the complete signer authority envelope with a read-only query", async () => {
    const calls: ControlPlaneStatement[] = [];
    const attempt = await Effect.runPromise(
      makeDataRegistrationSigningIntentReader()
        .getSigningAttempt("registration-1:attempt:1")
        .pipe(Effect.provideService(ControlPlaneDb, db([row()], calls))),
    );

    expect(attempt).toMatchObject({
      chainId: 1315n,
      targetAddress: `0x${"2".repeat(40)}`,
      methodSelector: "0x12345678",
      nonce: 7n,
      valueWei: 0n,
      state: "nonce_reserved",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      label: "data-registration.signing-intent.read",
      values: ["registration-1:attempt:1"],
      readonly: true,
    });
  });

  test("fails closed on duplicate or invalid persisted authority", async () => {
    for (const rows of [[row(), row()], [row({ state: "invented" })]]) {
      const exit = await Effect.runPromiseExit(
        makeDataRegistrationSigningIntentReader()
          .getSigningAttempt("registration-1:attempt:1")
          .pipe(Effect.provideService(ControlPlaneDb, db(rows, []))),
      );
      expect(failureOf(exit)).toBeInstanceOf(DataRegistrationSigningIntentReadFailed);
      expect(failureOf(exit)).toMatchObject({ reason: "invalid-row" });
    }
  });
});

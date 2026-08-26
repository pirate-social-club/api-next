import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Result } from "effect";
import {
  DataRegistrationSigningFailed,
  type DataRegistrationSigningRequest,
  type DataRegistrationSigningResult,
  DataRegistrationTransactionSigner,
} from "../ports";
import type {
  DataRegistrationSigningAttempt,
  DataRegistrationStore,
} from "./registration-persistence";
import {
  type DataRegistrationSigningPolicy,
  makeDataRegistrationSigningCoordinator,
} from "./signing-coordinator";

const NOW = Date.parse("2026-08-27T00:00:00.000Z");
const CALLDATA = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0xaa]);
const CALLDATA_HASH = "80a14a107e4724bab764e13dc3b98e044961bea9c078973e3b2956a35a098811";
const SIGNED_HASH = `0x${"a".repeat(64)}`;
const SIGNED_BYTES = new Uint8Array([1, 2, 3]);
const SIGNER = `0x${"1".repeat(40)}`;
const TARGET = `0x${"2".repeat(40)}`;

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.findError(exit.cause);
  if (!Result.isSuccess(failure)) throw new Error(Cause.pretty(exit.cause));
  return failure.success;
};

const policy: DataRegistrationSigningPolicy = {
  chainId: 1315n,
  signerNamespace: "data-registration-staging",
  signerAddress: SIGNER,
  targetAddress: TARGET,
  methodSelector: "0x12345678",
  valueWei: 0n,
  maximumDeadlineSeconds: 300,
  maximumGasLimit: 1_500_000n,
  maximumFeePerGas: 5_000_000_000n,
  maximumPriorityFeePerGas: 2_000_000_000n,
};

const attempt = (
  overrides: Partial<DataRegistrationSigningAttempt> = {},
): DataRegistrationSigningAttempt => ({
  submissionAttemptId: "registration-1:attempt:1",
  registrationOperationId: "registration-1",
  chainId: policy.chainId,
  attemptNumber: 1,
  signerNamespace: policy.signerNamespace,
  signerAddress: policy.signerAddress,
  signingIntentId: "registration-1:attempt:1:signing-intent",
  targetAddress: policy.targetAddress,
  methodSelector: policy.methodSelector,
  calldataHash: CALLDATA_HASH,
  signingDeadline: "2026-08-27T00:04:00.000Z",
  valueWei: 0n,
  gasLimit: policy.maximumGasLimit,
  maxFeePerGas: policy.maximumFeePerGas,
  maxPriorityFeePerGas: policy.maximumPriorityFeePerGas,
  nonce: 7n,
  signedTransaction: null,
  signedTransactionHash: null,
  transactionHash: null,
  supersedesSubmissionAttemptId: null,
  state: "nonce_reserved",
  failureCode: null,
  failureEvidenceRef: null,
  ...overrides,
});

const run = async (options: {
  attempt?: DataRegistrationSigningAttempt | null;
  policy?: DataRegistrationSigningPolicy;
  calldata?: Uint8Array;
  persistenceRaceWinner?: DataRegistrationSigningAttempt;
  signer?: (
    request: DataRegistrationSigningRequest,
  ) => Effect.Effect<DataRegistrationSigningResult, DataRegistrationSigningFailed>;
}) => {
  let calls = 0;
  let request: DataRegistrationSigningRequest | null = null;
  const persisted: (readonly unknown[])[] = [];
  let current = options.attempt === undefined ? attempt() : options.attempt;
  const store = {
    persistPreparedTransaction: async (...values: readonly unknown[]) => {
      persisted.push(values);
      if (options.persistenceRaceWinner !== undefined) {
        current = options.persistenceRaceWinner;
        throw new Error("concurrent preparation won");
      }
      if (current === null) throw new Error("missing attempt");
      return {
        ...current,
        state: "prepared" as const,
        signedTransaction: SIGNED_BYTES,
        signedTransactionHash: SIGNED_HASH,
      };
    },
  } as unknown as DataRegistrationStore;
  const coordinator = makeDataRegistrationSigningCoordinator({
    policy: options.policy ?? policy,
    reader: { getSigningAttempt: () => Effect.succeed(current) },
    store,
    now: () => NOW,
  });
  const signer = {
    sign: (value: DataRegistrationSigningRequest) => {
      calls += 1;
      request = value;
      return (
        options.signer?.(value) ??
        Effect.succeed({ signedTransaction: SIGNED_BYTES, signedTransactionHash: SIGNED_HASH })
      );
    },
  };
  const result = await Effect.runPromiseExit(
    coordinator
      .sign({
        submissionAttemptId: "registration-1:attempt:1",
        calldata: options.calldata ?? CALLDATA,
        evidenceRef: "evidence://signing/1",
      })
      .pipe(Effect.provideService(DataRegistrationTransactionSigner, signer)),
  );
  return { calls, persisted, request, result };
};

describe("DATA registration signing coordinator", () => {
  test("signs only the exact PostgreSQL-authorized transaction envelope", async () => {
    const outcome = await run({});
    if (Exit.isFailure(outcome.result)) throw failureOf(outcome.result);
    expect(outcome.result.value).toMatchObject({
      kind: "signed",
      submissionAttemptId: "registration-1:attempt:1",
      signedTransactionHash: SIGNED_HASH,
      state: "prepared",
    });
    expect(outcome.request).toMatchObject({
      version: "data-registration-signing-v1",
      chainId: 1315n,
      signerAddress: SIGNER,
      targetAddress: TARGET,
      methodSelector: "0x12345678",
      nonce: 7n,
      gasLimit: 1_500_000n,
    });
    expect(outcome.persisted[0]?.slice(0, 3)).toEqual([
      "registration-1:attempt:1",
      SIGNED_BYTES,
      SIGNED_HASH,
    ]);
    expect(JSON.stringify(outcome.result)).not.toContain("1,2,3");
  });

  test("rejects substituted authority, deadline, nonce, and calldata before signing", async () => {
    const cases: readonly DataRegistrationSigningAttempt[] = [
      attempt({ chainId: 1n }),
      attempt({ targetAddress: `0x${"3".repeat(40)}` }),
      attempt({ methodSelector: "0x87654321" }),
      attempt({ valueWei: 1n }),
      attempt({ nonce: null }),
      attempt({ signingDeadline: "2026-08-27T00:10:00.000Z" }),
      attempt({ calldataHash: "0".repeat(64) }),
    ];
    for (const value of cases) {
      const outcome = await run({ attempt: value });
      expect(outcome.result._tag).toBe("Failure");
      expect(outcome.calls).toBe(0);
      expect(outcome.persisted).toHaveLength(0);
    }
  });

  test("returns a redacted persisted replay without calling the signer", async () => {
    const outcome = await run({
      attempt: attempt({
        state: "prepared",
        signedTransaction: SIGNED_BYTES,
        signedTransactionHash: SIGNED_HASH,
      }),
    });
    expect(outcome.result).toMatchObject({
      _tag: "Success",
      value: { kind: "replay", signedTransactionHash: SIGNED_HASH, state: "prepared" },
    });
    expect(outcome.calls).toBe(0);
    expect(outcome.persisted).toHaveLength(0);
    expect(JSON.stringify(outcome.result)).not.toContain("1,2,3");
  });

  test("converges on a concurrent sibling's prepared transaction", async () => {
    const winnerHash = `0x${"b".repeat(64)}`;
    const outcome = await run({
      persistenceRaceWinner: attempt({
        state: "prepared",
        signedTransaction: new Uint8Array([9, 8, 7]),
        signedTransactionHash: winnerHash,
      }),
    });

    if (Exit.isFailure(outcome.result)) throw failureOf(outcome.result);
    expect(outcome.result.value).toEqual({
      kind: "replay",
      submissionAttemptId: "registration-1:attempt:1",
      signedTransactionHash: winnerHash,
      state: "prepared",
    });
    expect(outcome.calls).toBe(1);
    expect(outcome.persisted).toHaveLength(1);
    expect(JSON.stringify(outcome.result)).not.toContain("9,8,7");
  });

  test("redacts signer failures and rejects malformed signer output", async () => {
    const failed = await run({
      signer: () => Effect.fail(new DataRegistrationSigningFailed({ reason: "unavailable" })),
    });
    expect(failureOf(failed.result)).toMatchObject({ reason: "signer-failed" });
    expect(JSON.stringify(failed.result)).not.toContain("private");

    const malformed = await run({
      signer: () =>
        Effect.succeed({ signedTransaction: new Uint8Array(), signedTransactionHash: "bad" }),
    });
    expect(failureOf(malformed.result)).toMatchObject({ reason: "invalid-signature" });
    expect(malformed.persisted).toHaveLength(0);
  });
});

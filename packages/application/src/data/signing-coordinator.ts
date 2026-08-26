import { Data, Effect } from "effect";
import {
  DATA_REGISTRATION_SIGNING_PORT_VERSION,
  type DataRegistrationSigningRequest,
  DataRegistrationTransactionSigner,
} from "../ports";
import type {
  DataRegistrationSigningAttempt,
  DataRegistrationStore,
} from "./registration-persistence";

const HASH = /^[0-9a-f]{64}$/u;
const TRANSACTION_HASH = /^0x[0-9a-f]{64}$/u;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const METHOD_SELECTOR = /^0x[0-9a-f]{8}$/u;

export type DataRegistrationSigningPolicy = Readonly<{
  chainId: bigint;
  signerNamespace: string;
  signerAddress: string;
  targetAddress: string;
  methodSelector: string;
  valueWei: bigint;
  maximumDeadlineSeconds: number;
  maximumGasLimit: bigint;
  maximumFeePerGas: bigint;
  maximumPriorityFeePerGas: bigint;
}>;

export interface DataRegistrationSigningIntentReader<Requirements = never> {
  readonly getSigningAttempt: (
    submissionAttemptId: string,
  ) => Effect.Effect<DataRegistrationSigningAttempt | null, unknown, Requirements>;
}

export type DataRegistrationSigningCoordinatorInput = Readonly<{
  submissionAttemptId: string;
  calldata: Uint8Array;
  evidenceRef: string;
}>;

export type DataRegistrationSigningCoordinatorResult = Readonly<{
  kind: "signed" | "replay";
  submissionAttemptId: string;
  signedTransactionHash: string;
  state: "prepared" | "broadcast" | "mined" | "confirmed" | "replaced";
}>;

export class DataRegistrationSigningCoordinatorError extends Data.TaggedError(
  "DataRegistrationSigningCoordinatorError",
)<{
  readonly reason:
    | "invalid-input"
    | "not-found"
    | "not-signable"
    | "authority-mismatch"
    | "deadline-invalid"
    | "calldata-mismatch"
    | "signer-failed"
    | "invalid-signature"
    | "persistence-failed";
}> {}

const fail = (reason: DataRegistrationSigningCoordinatorError["reason"]) =>
  new DataRegistrationSigningCoordinatorError({ reason });

const boundedId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  value === value.trim() &&
  !value.includes("\u0000");

const canonicalAddress = (value: string): string => value.toLowerCase();

const selectorFromCalldata = (calldata: Uint8Array): string =>
  `0x${[...calldata.slice(0, 4)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

const sha256Hex = (bytes: Uint8Array): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  });

const policyIsValid = (policy: DataRegistrationSigningPolicy): boolean =>
  policy.chainId > 0n &&
  boundedId(policy.signerNamespace) &&
  ADDRESS.test(policy.signerAddress) &&
  ADDRESS.test(policy.targetAddress) &&
  METHOD_SELECTOR.test(policy.methodSelector) &&
  policy.valueWei >= 0n &&
  Number.isSafeInteger(policy.maximumDeadlineSeconds) &&
  policy.maximumDeadlineSeconds > 0 &&
  policy.maximumGasLimit > 0n &&
  policy.maximumFeePerGas > 0n &&
  policy.maximumPriorityFeePerGas >= 0n &&
  policy.maximumPriorityFeePerGas <= policy.maximumFeePerGas;

const authorityMatches = (
  attempt: DataRegistrationSigningAttempt,
  policy: DataRegistrationSigningPolicy,
): boolean =>
  attempt.chainId === policy.chainId &&
  attempt.signerNamespace === policy.signerNamespace &&
  canonicalAddress(attempt.signerAddress) === canonicalAddress(policy.signerAddress) &&
  canonicalAddress(attempt.targetAddress) === canonicalAddress(policy.targetAddress) &&
  attempt.methodSelector === policy.methodSelector &&
  attempt.valueWei === policy.valueWei &&
  attempt.gasLimit <= policy.maximumGasLimit &&
  attempt.maxFeePerGas <= policy.maximumFeePerGas &&
  attempt.maxPriorityFeePerGas <= policy.maximumPriorityFeePerGas;

const replay = (
  attempt: DataRegistrationSigningAttempt,
): DataRegistrationSigningCoordinatorResult | null => {
  if (
    !["prepared", "broadcast", "mined", "confirmed", "replaced"].includes(attempt.state) ||
    attempt.signedTransaction === null ||
    attempt.signedTransactionHash === null ||
    !TRANSACTION_HASH.test(attempt.signedTransactionHash)
  ) {
    return null;
  }
  return {
    kind: "replay",
    submissionAttemptId: attempt.submissionAttemptId,
    signedTransactionHash: attempt.signedTransactionHash,
    state: attempt.state as DataRegistrationSigningCoordinatorResult["state"],
  };
};

export const makeDataRegistrationSigningCoordinator = <Requirements = never>(options: {
  readonly policy: DataRegistrationSigningPolicy;
  readonly reader: DataRegistrationSigningIntentReader<Requirements>;
  readonly store: DataRegistrationStore;
  readonly now: () => number;
}) => ({
  sign: (
    input: DataRegistrationSigningCoordinatorInput,
  ): Effect.Effect<
    DataRegistrationSigningCoordinatorResult,
    DataRegistrationSigningCoordinatorError,
    DataRegistrationTransactionSigner | Requirements
  > =>
    Effect.gen(function* () {
      if (
        !policyIsValid(options.policy) ||
        !boundedId(input.submissionAttemptId) ||
        !boundedId(input.evidenceRef) ||
        !(input.calldata instanceof Uint8Array) ||
        input.calldata.byteLength < 4
      ) {
        return yield* Effect.fail(fail("invalid-input"));
      }
      const attempt = yield* options.reader
        .getSigningAttempt(input.submissionAttemptId)
        .pipe(Effect.mapError(() => fail("persistence-failed")));
      if (attempt === null) return yield* Effect.fail(fail("not-found"));

      const replayResult = replay(attempt);
      if (replayResult !== null) return replayResult;
      if (attempt.state !== "nonce_reserved" || attempt.nonce === null) {
        return yield* Effect.fail(fail("not-signable"));
      }
      if (!authorityMatches(attempt, options.policy)) {
        return yield* Effect.fail(fail("authority-mismatch"));
      }
      const now = options.now();
      const deadline = Date.parse(attempt.signingDeadline);
      if (
        !Number.isFinite(now) ||
        !Number.isFinite(deadline) ||
        deadline <= now ||
        deadline > now + options.policy.maximumDeadlineSeconds * 1_000
      ) {
        return yield* Effect.fail(fail("deadline-invalid"));
      }
      const calldataHash = yield* sha256Hex(input.calldata);
      if (
        !HASH.test(attempt.calldataHash) ||
        calldataHash !== attempt.calldataHash ||
        selectorFromCalldata(input.calldata) !== attempt.methodSelector
      ) {
        return yield* Effect.fail(fail("calldata-mismatch"));
      }

      const request: DataRegistrationSigningRequest = {
        version: DATA_REGISTRATION_SIGNING_PORT_VERSION,
        registrationOperationId: attempt.registrationOperationId,
        submissionAttemptId: attempt.submissionAttemptId,
        signingIntentId: attempt.signingIntentId,
        chainId: attempt.chainId,
        signerNamespace: attempt.signerNamespace,
        signerAddress: attempt.signerAddress,
        targetAddress: attempt.targetAddress,
        methodSelector: attempt.methodSelector,
        calldata: new Uint8Array(input.calldata),
        calldataHash: attempt.calldataHash,
        signingDeadline: attempt.signingDeadline,
        nonce: attempt.nonce,
        valueWei: attempt.valueWei,
        gasLimit: attempt.gasLimit,
        maxFeePerGas: attempt.maxFeePerGas,
        maxPriorityFeePerGas: attempt.maxPriorityFeePerGas,
      };
      const signer = yield* DataRegistrationTransactionSigner;
      const signed = yield* signer.sign(request).pipe(Effect.mapError(() => fail("signer-failed")));
      if (
        !(signed.signedTransaction instanceof Uint8Array) ||
        signed.signedTransaction.byteLength === 0 ||
        !TRANSACTION_HASH.test(signed.signedTransactionHash)
      ) {
        return yield* Effect.fail(fail("invalid-signature"));
      }
      const persisted = yield* Effect.tryPromise({
        try: () =>
          options.store.persistPreparedTransaction(
            attempt.submissionAttemptId,
            new Uint8Array(signed.signedTransaction),
            signed.signedTransactionHash,
            input.evidenceRef,
          ),
        catch: () => fail("persistence-failed"),
      }).pipe(
        Effect.catch(() =>
          options.reader.getSigningAttempt(attempt.submissionAttemptId).pipe(
            Effect.mapError(() => fail("persistence-failed")),
            Effect.flatMap((concurrent) => {
              if (concurrent === null) return Effect.fail(fail("persistence-failed"));
              const concurrentReplay = replay(concurrent);
              return concurrentReplay === null
                ? Effect.fail(fail("persistence-failed"))
                : Effect.succeed(concurrentReplay);
            }),
          ),
        ),
      );
      if ("kind" in persisted) return persisted;
      if (
        persisted.state !== "prepared" ||
        persisted.signedTransactionHash !== signed.signedTransactionHash
      ) {
        return yield* Effect.fail(fail("persistence-failed"));
      }
      return {
        kind: "signed",
        submissionAttemptId: persisted.submissionAttemptId,
        signedTransactionHash: signed.signedTransactionHash,
        state: "prepared",
      };
    }),
});

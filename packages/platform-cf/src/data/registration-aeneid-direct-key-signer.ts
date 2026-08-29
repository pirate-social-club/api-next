import {
  DATA_REGISTRATION_SIGNING_PORT_VERSION,
  DataRegistrationSigningFailed,
  type DataRegistrationSigningRequest,
  DataRegistrationTransactionSigner,
} from "@pirate/application";
import { Effect, Layer } from "effect";
import { hexToBytes, isAddress, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const PRIVATE_KEY = /^0x[0-9a-f]{64}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const SELECTOR = /^0x[0-9a-f]{8}$/u;

export type DataRegistrationAeneidDirectKeySignerOptions = Readonly<{
  privateKey: string;
  expectedAddress: string;
  chainId: bigint;
  signerNamespace: "data_registration";
}>;

const rejected = () => new DataRegistrationSigningFailed({ reason: "rejected" });

function requestMatches(
  request: DataRegistrationSigningRequest,
  options: DataRegistrationAeneidDirectKeySignerOptions,
): boolean {
  return (
    request.version === DATA_REGISTRATION_SIGNING_PORT_VERSION &&
    request.chainId === options.chainId &&
    request.signerNamespace === options.signerNamespace &&
    request.signerAddress.toLowerCase() === options.expectedAddress.toLowerCase() &&
    isAddress(request.targetAddress, { strict: true }) &&
    SELECTOR.test(request.methodSelector) &&
    request.calldata.byteLength >= 4 &&
    `0x${[...request.calldata.slice(0, 4)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}` === request.methodSelector &&
    HASH.test(request.calldataHash) &&
    request.nonce >= 0n &&
    request.nonce <= BigInt(Number.MAX_SAFE_INTEGER) &&
    request.valueWei === 0n &&
    request.gasLimit > 0n &&
    request.maxFeePerGas > 0n &&
    request.maxPriorityFeePerGas >= 0n &&
    request.maxPriorityFeePerGas <= request.maxFeePerGas
  );
}

/** Aeneid-only offline EIP-1559 signer. It cannot broadcast or choose a transaction. */
export function makeDataRegistrationAeneidDirectKeySigner(
  options: DataRegistrationAeneidDirectKeySignerOptions,
): DataRegistrationTransactionSigner["Service"] {
  if (
    !PRIVATE_KEY.test(options.privateKey) ||
    !isAddress(options.expectedAddress, { strict: true }) ||
    options.chainId !== 1315n ||
    options.signerNamespace !== "data_registration"
  ) {
    throw new TypeError("invalid Aeneid DATA signer configuration");
  }
  const account = privateKeyToAccount(options.privateKey as `0x${string}`);
  if (account.address.toLowerCase() !== options.expectedAddress.toLowerCase()) {
    throw new TypeError("Aeneid DATA signer address mismatch");
  }

  return DataRegistrationTransactionSigner.of({
    sign: (request) =>
      Effect.gen(function* () {
        if (!requestMatches(request, options)) return yield* Effect.fail(rejected());
        const digest = yield* Effect.promise(async () => {
          const value = await crypto.subtle.digest("SHA-256", request.calldata);
          return [...new Uint8Array(value)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
        });
        if (digest !== request.calldataHash) return yield* Effect.fail(rejected());

        const signed = yield* Effect.tryPromise({
          try: () =>
            account.signTransaction({
              type: "eip1559",
              chainId: Number(request.chainId),
              nonce: Number(request.nonce),
              to: request.targetAddress as `0x${string}`,
              data: `0x${[...request.calldata]
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("")}`,
              value: request.valueWei,
              gas: request.gasLimit,
              maxFeePerGas: request.maxFeePerGas,
              maxPriorityFeePerGas: request.maxPriorityFeePerGas,
            }),
          catch: () => new DataRegistrationSigningFailed({ reason: "unavailable" }),
        });
        const signedTransactionHash = keccak256(signed);
        if (!/^0x[0-9a-f]{64}$/u.test(signedTransactionHash)) {
          return yield* Effect.fail(
            new DataRegistrationSigningFailed({ reason: "invalid-result" }),
          );
        }
        return {
          signedTransaction: hexToBytes(signed),
          signedTransactionHash,
        };
      }),
  });
}

export const makeDataRegistrationAeneidDirectKeySignerLayer = (
  options: DataRegistrationAeneidDirectKeySignerOptions,
) =>
  Layer.succeed(
    DataRegistrationTransactionSigner,
    makeDataRegistrationAeneidDirectKeySigner(options),
  );

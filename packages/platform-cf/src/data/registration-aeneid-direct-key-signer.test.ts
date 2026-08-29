import { describe, expect, test } from "bun:test";
import {
  DATA_REGISTRATION_SIGNING_PORT_VERSION,
  type DataRegistrationSigningRequest,
} from "@pirate/application";
import { Effect } from "effect";
import { bytesToHex, keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { makeDataRegistrationAeneidDirectKeySigner } from "./registration-aeneid-direct-key-signer";

const PRIVATE_KEY = generatePrivateKey();
const account = privateKeyToAccount(PRIVATE_KEY);
const calldata = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0xaa]);

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const request = async (): Promise<DataRegistrationSigningRequest> => ({
  version: DATA_REGISTRATION_SIGNING_PORT_VERSION,
  registrationOperationId: "data-registration:1315:post-1:1",
  submissionAttemptId: "attempt-1",
  signingIntentId: "intent-1",
  chainId: 1315n,
  signerNamespace: "data_registration",
  signerAddress: account.address,
  targetAddress: "0x2222222222222222222222222222222222222222",
  methodSelector: "0x12345678",
  calldata,
  calldataHash: await sha256(calldata),
  signingDeadline: "2026-08-28T00:00:00.000Z",
  nonce: 3n,
  valueWei: 0n,
  gasLimit: 1_500_000n,
  maxFeePerGas: 5_000_000_000n,
  maxPriorityFeePerGas: 2_000_000_000n,
});

const signer = () =>
  makeDataRegistrationAeneidDirectKeySigner({
    privateKey: PRIVATE_KEY,
    expectedAddress: account.address,
    chainId: 1315n,
    signerNamespace: "data_registration",
  });

describe("Aeneid direct-key DATA registration signer", () => {
  test("signs only the exact typed zero-value Aeneid envelope", async () => {
    const result = await Effect.runPromise(signer().sign(await request()));
    expect(result.signedTransaction.byteLength).toBeGreaterThan(0);
    expect(result.signedTransactionHash).toBe(keccak256(bytesToHex(result.signedTransaction)));
  });

  test("rejects cross-namespace, value-bearing, and calldata-drift requests", async () => {
    const base = await request();
    for (const hostile of [
      { ...base, signerNamespace: "megapot_custody" },
      { ...base, valueWei: 1n },
      { ...base, calldata: new Uint8Array([0xff, ...base.calldata.slice(1)]) },
      { ...base, signerAddress: "0x3333333333333333333333333333333333333333" },
    ]) {
      const exit = await Effect.runPromiseExit(signer().sign(hostile));
      expect(exit._tag).toBe("Failure");
    }
  });

  test("fails construction when the key does not own the configured address", () => {
    expect(() =>
      makeDataRegistrationAeneidDirectKeySigner({
        privateKey: PRIVATE_KEY,
        expectedAddress: "0x3333333333333333333333333333333333333333",
        chainId: 1315n,
        signerNamespace: "data_registration",
      }),
    ).toThrow("address mismatch");
  });
});

import { describe, expect, test } from "bun:test";
import type {
  DataRegistrationOperation,
  DataRegistrationPinVerification,
  DataRegistrationSigningAttempt,
} from "@pirate/application/data/registration-persistence";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import {
  DATA_REGISTRATION_AENEID_SELECTORS,
  DATA_REGISTRATION_AENEID_TARGETS,
  type DataRegistrationAeneidChainOptions,
  makeDataRegistrationAeneidChain,
  makeJsonRpcTransport,
} from "./registration-aeneid-chain";
import type {
  DataRegistrationArtifactAuthority,
  DataRegistrationArtifactAuthorityReader,
} from "./registration-artifact-pipeline";

const operation: DataRegistrationOperation = {
  registrationOperationId: "data-registration:1315:post-1:1",
  communityId: "community-1",
  actorUserId: "actor-1",
  submissionId: "submission-1",
  mediaOperationId: "media-operation-1",
  postId: "post-1",
  assetId: "post-1",
  chainId: 1315n,
  registrationRevision: 1n,
  publicationCreationRevision: 1n,
  publicationAudioRevision: 1n,
  publicationAnalysisRevision: 1n,
  publicationDecisionRevision: 1n,
  canonicalAudioSha256: "a".repeat(64),
  state: "signing",
  workflowRevision: 1n,
  workflowInstanceId: "data-registration-workflow:data-registration:1315:post-1:1:r1",
  currentAttemptId: null,
  registeredIpId: null,
  confirmedTransactionHash: null,
  confirmedBlockNumber: null,
  confirmedBlockHash: null,
  confirmedLogIndex: null,
  confirmedAt: null,
  failureCode: null,
  failureEvidenceRef: null,
};

const baseAuthority: DataRegistrationArtifactAuthority = {
  postId: "post-1",
  title: "A staging song",
  projectedAt: "2026-08-27T00:00:00.000Z",
  audioAssetRef: "media://immutable/song.mp3",
  audioMediaType: "audio/mpeg",
  audioByteLength: 3n,
  canonicalAudioSha256: "a".repeat(64),
  coverArtifactRef: null,
  lyrics: null,
  lyricsExplicitness: "not_applicable",
  primaryLanguageBcp47: null,
  licensePreset: "non-commercial",
  commercialRemixShareBps: 1_000,
  royaltyAllocations: [
    {
      recipientId: "actor-1",
      address: "0x1111111111111111111111111111111111111111",
      shareBps: 10_000,
    },
  ],
  acrDecision: "allow",
  acrPolicyRevision: "acr-v1",
  creatorAddress: "0x1111111111111111111111111111111111111111",
};

const pin = (
  kind: "ip_metadata" | "nft_metadata",
  hashByte: string,
): DataRegistrationPinVerification => ({
  pinVerificationId: `${kind}-primary`,
  registrationOperationId: operation.registrationOperationId,
  artifactId: `${operation.registrationOperationId}:artifact:${kind}`,
  artifactKind: kind,
  role: "primary",
  providerId: "filebase",
  attemptNumber: 1,
  outcome: "verified",
  cid: `bafy${kind}`,
  canonicalSha256: hashByte.repeat(64),
  byteLength: 10n,
  evidenceRef: `evidence://${kind}`,
  verifiedAt: "2026-08-27T00:00:00.000Z",
});

const chain = (
  authorityValue: DataRegistrationArtifactAuthority,
  rpc: (method: string, params: readonly unknown[]) => Promise<unknown> = async () => {
    throw new Error("RPC must not be used while planning");
  },
  receiptReader: DataRegistrationAeneidChainOptions["receiptReader"] = {
    getLatestMinedReceipt: async () => null,
  },
) => {
  const authority: DataRegistrationArtifactAuthorityReader = {
    read: async () => authorityValue,
    listPins: async () => [pin("ip_metadata", "b"), pin("nft_metadata", "c")],
  };
  return makeDataRegistrationAeneidChain({
    authority,
    rpc,
    signerAddress: "0x2222222222222222222222222222222222222222",
    spgNftContract: "0x3333333333333333333333333333333333333333",
    requiredConfirmations: 3,
    gasLimit: 1_500_000n,
    maxFeePerGas: 5_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n,
    receiptReader,
  });
};

const transactionHash = `0x${"d".repeat(64)}`;
const attempt: DataRegistrationSigningAttempt = {
  registrationOperationId: operation.registrationOperationId,
  submissionAttemptId: `${operation.registrationOperationId}:attempt:1`,
  chainId: 1315n,
  attemptNumber: 1,
  signerNamespace: "data_registration",
  signerAddress: "0x2222222222222222222222222222222222222222",
  signingIntentId: `${operation.registrationOperationId}:attempt:1:intent`,
  targetAddress: DATA_REGISTRATION_AENEID_TARGETS.license,
  methodSelector: DATA_REGISTRATION_AENEID_SELECTORS.license,
  calldataHash: "e".repeat(64),
  signingDeadline: "2026-09-01T00:00:00.000Z",
  valueWei: 0n,
  gasLimit: 1_500_000n,
  maxFeePerGas: 5_000_000_000n,
  maxPriorityFeePerGas: 2_000_000_000n,
  nonce: 1n,
  signedTransaction: new Uint8Array([1]),
  signedTransactionHash: transactionHash,
  transactionHash,
  supersedesSubmissionAttemptId: null,
  state: "broadcast",
  failureCode: null,
  failureEvidenceRef: null,
};

const ipRegisteredEvent = {
  type: "event",
  name: "IPRegistered",
  inputs: [
    { name: "ipId", type: "address", indexed: false },
    { name: "chainId", type: "uint256", indexed: true },
    { name: "tokenContract", type: "address", indexed: true },
    { name: "tokenId", type: "uint256", indexed: true },
    { name: "name", type: "string", indexed: false },
    { name: "uri", type: "string", indexed: false },
    { name: "registrationDate", type: "uint256", indexed: false },
  ],
} as const;

describe("Aeneid DATA registration chain", () => {
  test("plans a zero-value non-commercial registration with the fixed target", async () => {
    const plan = await chain(baseAuthority).plan(operation, 1);
    expect(plan.reservation).toMatchObject({
      chainId: 1315n,
      signerNamespace: "data_registration",
      targetAddress: DATA_REGISTRATION_AENEID_TARGETS.license.toLowerCase(),
      methodSelector: DATA_REGISTRATION_AENEID_SELECTORS.license,
      valueWei: 0n,
    });
  });

  test("uses the fixed royalty workflow for commercial remix terms", async () => {
    const plan = await chain({ ...baseAuthority, licensePreset: "commercial-remix" }).plan(
      operation,
      1,
    );
    expect(plan.reservation.targetAddress).toBe(
      DATA_REGISTRATION_AENEID_TARGETS.royalty.toLowerCase(),
    );
    expect(plan.reservation.methodSelector).toBe(DATA_REGISTRATION_AENEID_SELECTORS.royalty);
  });

  test("rejects non-HTTPS RPC configuration before any request", () => {
    expect(() => makeJsonRpcTransport("http://aeneid.invalid")).toThrow("must use HTTPS");
  });

  test("keeps mined evidence schema-safe until final confirmations arrive", async () => {
    const tokenContract = "0x3333333333333333333333333333333333333333";
    const rpc = async (method: string): Promise<unknown> => {
      if (method === "eth_blockNumber") return "0xa";
      if (method === "eth_getTransactionReceipt") {
        return {
          transactionHash,
          blockNumber: "0xa",
          blockHash: `0x${"f".repeat(64)}`,
          status: "0x1",
          logs: [
            {
              address: "0x77319B4031e6eF1250907aa00018B8B1c67a244b",
              logIndex: "0x2",
              topics: encodeEventTopics({
                abi: [ipRegisteredEvent],
                eventName: "IPRegistered",
                args: { chainId: 1315n, tokenContract, tokenId: 1n },
              }),
              data: encodeAbiParameters(
                [{ type: "address" }, { type: "string" }, { type: "string" }, { type: "uint256" }],
                ["0x4444444444444444444444444444444444444444", "Song", "ipfs://metadata", 1n],
              ),
            },
          ],
        };
      }
      throw new Error("unexpected RPC method");
    };
    const result = await chain(baseAuthority, rpc).observeReceipt(operation, attempt);
    expect(result).toMatchObject({
      status: "mined",
      observation: {
        outcome: "mined",
        registeredIpId: null,
        ipMetadataUri: null,
        nftMetadataUri: null,
      },
    });
  });

  test("uses the durable mined block identity when a receipt becomes orphaned", async () => {
    const minedAttempt = { ...attempt, state: "mined" as const };
    const result = await chain(baseAuthority, async () => null, {
      getLatestMinedReceipt: async () => ({
        receiptObservationId: `${attempt.submissionAttemptId}:receipt:1`,
        registrationOperationId: operation.registrationOperationId,
        submissionAttemptId: attempt.submissionAttemptId,
        observationSequence: 1n,
        transactionHash,
        outcome: "mined",
        blockNumber: 10n,
        blockHash: `0x${"f".repeat(64)}`,
        logIndex: null,
        confirmations: 1,
        registeredIpId: null,
        ipMetadataUri: null,
        ipMetadataHash: null,
        nftMetadataUri: null,
        nftMetadataHash: null,
        evidenceRef: "evidence://mined",
        observedAt: "2026-08-27T00:00:00.000Z",
      }),
    }).observeReceipt(operation, minedAttempt);
    expect(result).toMatchObject({
      status: "orphaned",
      observation: {
        outcome: "orphaned",
        blockNumber: 10n,
        blockHash: `0x${"f".repeat(64)}`,
      },
    });
  });
});

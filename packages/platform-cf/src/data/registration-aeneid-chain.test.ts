import { describe, expect, test } from "bun:test";
import type {
  DataLicensePreset,
  DataRegistrationOperation,
  DataRegistrationPinVerification,
  DataRegistrationSigningAttempt,
} from "@pirate/application/data/registration-persistence";
import {
  bytesToHex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
} from "viem";
import {
  DATA_REGISTRATION_AENEID_LICENSE_TEMPLATE,
  DATA_REGISTRATION_AENEID_SELECTORS,
  DATA_REGISTRATION_AENEID_TARGETS,
  type DataRegistrationAeneidChainOptions,
  DERIVATIVE_WORKFLOW_ABI,
  LICENSE_WORKFLOW_ABI,
  makeDataRegistrationAeneidChain,
  makeJsonRpcTransport,
  PIL_LICENSE_TEMPLATE_ABI,
  presetTerms,
  REGISTRATION_WORKFLOW_ABI,
  ROYALTY_WORKFLOW_ABI,
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
  mediaKind: "song",
  rightsBasis: "original",
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
  attachedLicense: null,
};

const baseAuthority: DataRegistrationArtifactAuthority = {
  postId: "post-1",
  title: "A staging song",
  projectedAt: "2026-08-27T00:00:00.000Z",
  contentRating: "general",
  audioAssetRef: "media://immutable/song.mp3",
  audioMediaType: "audio/mpeg",
  audioByteLength: 3n,
  canonicalAudioSha256: "a".repeat(64),
  coverArtifactRef: null,
  lyrics: null,
  lyricsExplicitness: "not_applicable",
  primaryLanguageBcp47: null,
  mediaKind: "song",
  rightsBasis: "original",
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

/** The hex a PILicenseTemplate.getLicenseTerms call returns, from the same
 * preset definition the adapter plans with. */
type PilTermsOverrides = Partial<{
  commercialUse: boolean;
  derivativesAllowed: boolean;
  derivativesAttribution: boolean;
  derivativesReciprocal: boolean;
  derivativesApproval: boolean;
  commercialRevShare: number;
  royaltyPolicy: `0x${string}`;
  currency: `0x${string}`;
}>;
const pilTerms = (
  preset: DataLicensePreset,
  share: number | null = null,
  overrides: PilTermsOverrides = {},
): string =>
  encodeFunctionResult({
    abi: PIL_LICENSE_TEMPLATE_ABI,
    functionName: "getLicenseTerms",
    result: { ...presetTerms(preset, share).terms, ...overrides },
  });

const originalVideoAuthority: DataRegistrationArtifactAuthority = {
  ...baseAuthority,
  mediaKind: "video",
  rightsBasis: "original",
  licensePreset: null,
  caption: "An original video",
  videoAssetRef: "media://immutable/video.mp4",
  videoMediaType: "video/mp4",
  videoByteLength: 4n,
  canonicalVideoSha256: "b".repeat(64),
  posterArtifactRef: "media://immutable/poster.jpg",
  posterSha256: "c".repeat(64),
  originalSoundId: "original-sound-1",
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
  spgNftContract: `0x${string}` = "0x3333333333333333333333333333333333333333",
) => {
  const authority: DataRegistrationArtifactAuthorityReader = {
    read: async () => authorityValue,
    listPins: async () => [pin("ip_metadata", "b"), pin("nft_metadata", "c")],
  };
  return makeDataRegistrationAeneidChain({
    authority,
    rpc,
    signerAddress: "0x2222222222222222222222222222222222222222",
    spgNftContract,
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

const LICENSING_MODULE = "0x04fbd8a2e56dd85CFD5500A4A4DfA955B9f1dE6f";
const licenseTermsAttachedEvent = {
  type: "event",
  name: "LicenseTermsAttached",
  inputs: [
    { name: "caller", type: "address", indexed: true },
    { name: "ipId", type: "address", indexed: true },
    { name: "licenseTemplate", type: "address", indexed: false },
    { name: "licenseTermsId", type: "uint256", indexed: false },
  ],
} as const;
const derivativeRegisteredEvent = {
  type: "event",
  name: "DerivativeRegistered",
  inputs: [
    { name: "caller", type: "address", indexed: true },
    { name: "childIpId", type: "address", indexed: true },
    { name: "licenseTokenIds", type: "uint256[]", indexed: false },
    { name: "parentIpIds", type: "address[]", indexed: false },
    { name: "licenseTermsIds", type: "uint256[]", indexed: false },
    { name: "licenseTemplate", type: "address", indexed: false },
  ],
} as const;

const termsAttachedLog = (ipId: `0x${string}`, termsId: bigint, logIndex: string) => ({
  address: LICENSING_MODULE,
  logIndex,
  topics: encodeEventTopics({
    abi: [licenseTermsAttachedEvent],
    eventName: "LicenseTermsAttached",
    args: { caller: DATA_REGISTRATION_AENEID_TARGETS.license, ipId },
  }),
  data: encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [DATA_REGISTRATION_AENEID_LICENSE_TEMPLATE, termsId],
  ),
});

const ipRegisteredLog = (ipId: `0x${string}`, logIndex: string) => ({
  address: "0x77319B4031e6eF1250907aa00018B8B1c67a244b",
  logIndex,
  topics: encodeEventTopics({
    abi: [ipRegisteredEvent],
    eventName: "IPRegistered",
    args: {
      chainId: 1315n,
      tokenContract: "0x3333333333333333333333333333333333333333",
      tokenId: 1n,
    },
  }),
  data: encodeAbiParameters(
    [{ type: "address" }, { type: "string" }, { type: "string" }, { type: "uint256" }],
    [ipId, "Pirate video", "ipfs://metadata", 1n],
  ),
});

const PARENT_IP = "0x5555555555555555555555555555555555555555";
const CHILD_IP = "0x6666666666666666666666666666666666666666";

const derivativeVideoAuthority: DataRegistrationArtifactAuthority = {
  postId: "post-1",
  projectedAt: "2026-09-11T00:00:00.000Z",
  contentRating: "general",
  mediaKind: "video",
  rightsBasis: "derivative",
  licensePreset: null,
  caption: "A video to a song",
  master: {
    objectKey: "song-video-masters/song-video-plan:submission-1/g1",
    objectVersion: "v1",
    mediaType: "video/mp4",
    byteLength: 4n,
    sha256: "b".repeat(64),
  },
  posterArtifactRef: "media://derived/poster.jpg",
  posterSha256: "c".repeat(64),
  parent: {
    assetId: "song-post-1",
    registrationOperationId: "data-registration:1315:song-post-1:1",
    relationship: "references_song",
    ipId: PARENT_IP,
    licenseTemplate: DATA_REGISTRATION_AENEID_LICENSE_TEMPLATE.toLowerCase(),
    licenseTermsId: "1894",
    preset: "commercial-remix",
    commercialRevShareBps: 500,
  },
  ownerPolicy: { revision: 1n, hash: "f".repeat(64) },
  royaltyAllocations: [
    {
      recipientId: "persona-1",
      address: "0x1111111111111111111111111111111111111111",
      shareBps: 10_000,
    },
  ],
  creatorAddress: "0x1111111111111111111111111111111111111111",
};

const derivativeOperation: DataRegistrationOperation = {
  ...operation,
  mediaKind: "video",
  rightsBasis: "derivative",
};

const derivativeAttempt = {
  ...attempt,
  targetAddress: DATA_REGISTRATION_AENEID_TARGETS.derivative,
  methodSelector: DATA_REGISTRATION_AENEID_SELECTORS.derivative,
};

/** A mined, final receipt carrying the given logs. */
const finalReceipt = (logs: readonly unknown[]) => async (method: string) => {
  if (method === "eth_blockNumber") return "0xc";
  if (method === "eth_getTransactionReceipt") {
    return {
      transactionHash,
      blockNumber: "0xa",
      blockHash: `0x${"f".repeat(64)}`,
      status: "0x1",
      logs,
    };
  }
  throw new Error("unexpected RPC method");
};

const derivativeLink = (
  overrides: Partial<{
    childIpId: `0x${string}`;
    parentIpIds: readonly `0x${string}`[];
    licenseTermsIds: readonly bigint[];
  }> = {},
) => ({
  address: LICENSING_MODULE,
  logIndex: "0x5",
  topics: encodeEventTopics({
    abi: [derivativeRegisteredEvent],
    eventName: "DerivativeRegistered",
    args: { caller: CHILD_IP, childIpId: overrides.childIpId ?? CHILD_IP },
  }),
  data: encodeAbiParameters(
    [{ type: "uint256[]" }, { type: "address[]" }, { type: "uint256[]" }, { type: "address" }],
    [
      [],
      overrides.parentIpIds ?? [PARENT_IP],
      overrides.licenseTermsIds ?? [1894n],
      DATA_REGISTRATION_AENEID_LICENSE_TEMPLATE,
    ],
  ),
});

describe("Aeneid DATA registration of a song-reference video", () => {
  test("plans one derivative call against the resolved parent's terms", async () => {
    const plan = await chain(derivativeVideoAuthority).plan(derivativeOperation, 1);
    expect(plan.reservation).toMatchObject({
      targetAddress: DATA_REGISTRATION_AENEID_TARGETS.derivative.toLowerCase(),
      methodSelector: DATA_REGISTRATION_AENEID_SELECTORS.derivative,
      valueWei: 0n,
    });
    const calldata = bytesToHex(plan.calldata);
    const decoded = decodeFunctionData({ abi: DERIVATIVE_WORKFLOW_ABI, data: calldata });
    expect(decoded.functionName).toBe("mintAndRegisterIpAndMakeDerivative");
    expect(decoded.args).toEqual([
      "0x3333333333333333333333333333333333333333",
      {
        parentIpIds: [PARENT_IP],
        licenseTemplate: DATA_REGISTRATION_AENEID_LICENSE_TEMPLATE,
        licenseTermsIds: [1894n],
        royaltyContext: "0x",
        maxMintingFee: 1n,
        maxRts: 100_000_000,
        maxRevenueShare: 5_000_000,
      },
      {
        ipMetadataURI: "ipfs://bafyip_metadata",
        ipMetadataHash: `0x${"b".repeat(64)}`,
        nftMetadataURI: "ipfs://bafynft_metadata",
        nftMetadataHash: `0x${"c".repeat(64)}`,
      },
      "0x1111111111111111111111111111111111111111",
      false,
    ]);
    // It attaches no terms of its own: it is none of the attaching workflows.
    expect(() => decodeFunctionData({ abi: LICENSE_WORKFLOW_ABI, data: calldata })).toThrow();
    expect(() => decodeFunctionData({ abi: ROYALTY_WORKFLOW_ABI, data: calldata })).toThrow();
  });

  test("refuses to plan against terms that forbid derivatives or another template", async () => {
    const refused = [
      {
        ...derivativeVideoAuthority,
        parent: {
          ...derivativeVideoAuthority.parent,
          preset: "commercial-use",
          commercialRevShareBps: null,
        },
      },
      {
        ...derivativeVideoAuthority,
        parent: { ...derivativeVideoAuthority.parent, licenseTemplate: `0x${"9".repeat(40)}` },
      },
      { ...derivativeVideoAuthority, parent: undefined },
    ] as unknown as readonly DataRegistrationArtifactAuthority[];
    for (const authority of refused) {
      await expect(chain(authority).plan(derivativeOperation, 1)).rejects.toThrow(
        "unsupported DATA registration intent",
      );
    }
  });

  test("confirms from the derivative link to exactly the resolved parent", async () => {
    const confirmed = await chain(
      derivativeVideoAuthority,
      finalReceipt([ipRegisteredLog(CHILD_IP, "0x2"), derivativeLink()]),
    ).observeReceipt(derivativeOperation, derivativeAttempt);
    expect(confirmed).toMatchObject({
      status: "confirmed",
      observation: { registeredIpId: CHILD_IP, logIndex: 2, attachedLicense: null },
    });
  });

  test.each([
    ["no derivative link", [ipRegisteredLog(CHILD_IP, "0x2")]],
    [
      "a link to another parent",
      [ipRegisteredLog(CHILD_IP, "0x2"), derivativeLink({ parentIpIds: [`0x${"7".repeat(40)}`] })],
    ],
    [
      "a link under other terms",
      [ipRegisteredLog(CHILD_IP, "0x2"), derivativeLink({ licenseTermsIds: [1314n] })],
    ],
    [
      "a second parent",
      [
        ipRegisteredLog(CHILD_IP, "0x2"),
        derivativeLink({ parentIpIds: [PARENT_IP, `0x${"7".repeat(40)}`] }),
      ],
    ],
    [
      "terms attached to the video",
      [ipRegisteredLog(CHILD_IP, "0x2"), derivativeLink(), termsAttachedLog(CHILD_IP, 9n, "0x6")],
    ],
  ])("reconciles a final receipt with %s", async (_case, logs) => {
    const result = await chain(derivativeVideoAuthority, finalReceipt(logs)).observeReceipt(
      derivativeOperation,
      derivativeAttempt,
    );
    expect(result).toMatchObject({ status: "invalid" });
  });

  test("reconciles an original video whose receipt attached terms", async () => {
    const result = await chain(
      originalVideoAuthority,
      finalReceipt([ipRegisteredLog(CHILD_IP, "0x2"), termsAttachedLog(CHILD_IP, 9n, "0x3")]),
    ).observeReceipt({ ...operation, mediaKind: "video" }, attempt);
    expect(result).toMatchObject({ status: "invalid" });
  });
});

/**
 * A public Aeneid receipt, read-only from https://aeneid.storyrpc.io on
 * 2026-09-11: transaction 0x38edba4e...35c3 in block 23425318 called
 * RoyaltyTokenDistributionWorkflows with the same selector this adapter uses,
 * registering one IP and attaching two sets of PIL terms to it (logs 7 and 8).
 * Only the three logs that matter here are kept; the rest are unrelated.
 */
const AENEID_TERMS_RECEIPT = {
  transactionHash: "0x38edba4e4fdfe2da4e7f1203785eaa826a69bf6681e827f666ed665e67b035c3",
  blockNumber: "0x1657126",
  blockHash: "0xa487ae50db02e4800abcd649ed37887872c423e9d7219d868c653d5942e9e977",
  status: "0x1",
  logs: [
    {
      address: "0x77319b4031e6ef1250907aa00018b8b1c67a244b",
      logIndex: "0x4",
      topics: [
        "0x02ad3a2e0356b65fdfe4a73c825b78071ae469db35162978518b8c258abb3767",
        "0x0000000000000000000000000000000000000000000000000000000000000523",
        "0x000000000000000000000000538048a26dbcc7a1dd446762098b0bfafa3a1472",
        "0x0000000000000000000000000000000000000000000000000000000000000023",
      ],
      data: "0x0000000000000000000000001653b905597e0f778c0e9c2d8a9d5c003ee56614000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000006aa24b41000000000000000000000000000000000000000000000000000000000000001c313331353a20417572656d495020436f6c6c656374696f6e2023333500000000000000000000000000000000000000000000000000000000000000000000005068747470733a2f2f676174657761792e70696e6174612e636c6f75642f697066732f516d5074635854786f48436962346239757967514245653171645a41735177714c746d635a42745150465933504300000000000000000000000000000000",
    },
    {
      address: "0x04fbd8a2e56dd85cfd5500a4a4dfa955b9f1de6f",
      logIndex: "0x7",
      topics: [
        "0xb8d0577f110d8cf9f2c63ba14b0511362a85865bf03ea4f1c8a10ddc490244c7",
        "0x000000000000000000000000a38f42b8d33809917f23997b8423054aab97322c",
        "0x0000000000000000000000001653b905597e0f778c0e9c2d8a9d5c003ee56614",
      ],
      data: "0x0000000000000000000000002e896b0b2fdb7457499b56aaaa4ae55bcb4cd3160000000000000000000000000000000000000000000000000000000000000766",
    },
    {
      address: "0x04fbd8a2e56dd85cfd5500a4a4dfa955b9f1de6f",
      logIndex: "0x8",
      topics: [
        "0xb8d0577f110d8cf9f2c63ba14b0511362a85865bf03ea4f1c8a10ddc490244c7",
        "0x000000000000000000000000a38f42b8d33809917f23997b8423054aab97322c",
        "0x0000000000000000000000001653b905597e0f778c0e9c2d8a9d5c003ee56614",
      ],
      data: "0x0000000000000000000000002e896b0b2fdb7457499b56aaaa4ae55bcb4cd3160000000000000000000000000000000000000000000000000000000000000522",
    },
  ],
} as const;

describe("song terms evidence against a real Aeneid receipt", () => {
  const realAttempt = {
    ...attempt,
    targetAddress: DATA_REGISTRATION_AENEID_TARGETS.royalty,
    methodSelector: DATA_REGISTRATION_AENEID_SELECTORS.royalty,
    transactionHash: AENEID_TERMS_RECEIPT.transactionHash,
    signedTransactionHash: AENEID_TERMS_RECEIPT.transactionHash,
  };
  const observe = (logs: readonly unknown[], terms: string = pilTerms("commercial-remix", 1_000)) =>
    chain(
      { ...baseAuthority, licensePreset: "commercial-remix", commercialRemixShareBps: 1_000 },
      async (method: string) => {
        if (method === "eth_blockNumber") return `0x${(23_425_318 + 2).toString(16)}`;
        if (method === "eth_getTransactionReceipt") return { ...AENEID_TERMS_RECEIPT, logs };
        if (method === "eth_call") return terms;
        throw new Error("unexpected RPC method");
      },
      { getLatestMinedReceipt: async () => null },
      "0x538048a26dbcc7a1dd446762098b0bfafa3a1472",
    ).observeReceipt(operation, realAttempt);

  test("refuses to choose between two attached terms", async () => {
    expect(await observe(AENEID_TERMS_RECEIPT.logs)).toMatchObject({ status: "invalid" });
  });

  test("keeps the one attachment of a single-terms registration with its coordinates", async () => {
    const [registered, first] = AENEID_TERMS_RECEIPT.logs;
    expect(await observe([registered, first])).toMatchObject({
      status: "confirmed",
      observation: {
        registeredIpId: "0x1653b905597e0f778c0e9c2d8a9d5c003ee56614",
        logIndex: 4,
        attachedLicense: {
          licenseTemplate: "0x2e896b0b2fdb7457499b56aaaa4ae55bcb4cd316",
          licenseTermsId: "1894",
          preset: "commercial-remix",
          commercialRevShareBps: 1_000,
          attachment: {
            transactionHash: AENEID_TERMS_RECEIPT.transactionHash,
            blockNumber: 23_425_318n,
            blockHash: AENEID_TERMS_RECEIPT.blockHash,
            logIndex: 7,
          },
        },
      },
    });
  });

  test("reconciles a song registration that attached no terms", async () => {
    const [registered] = AENEID_TERMS_RECEIPT.logs;
    expect(await observe([registered])).toMatchObject({ status: "invalid" });
  });

  test("records the template's actual derivative permission, not the publication license", async () => {
    const [registered, first] = AENEID_TERMS_RECEIPT.logs;
    expect(await observe([registered, first], pilTerms("commercial-use"))).toMatchObject({
      status: "confirmed",
      observation: { attachedLicense: { preset: "commercial-use", commercialRevShareBps: null } },
    });
  });

  test("records the template's actual revenue share, not the publication license", async () => {
    const [registered, first] = AENEID_TERMS_RECEIPT.logs;
    expect(await observe([registered, first], pilTerms("commercial-remix", 500))).toMatchObject({
      status: "confirmed",
      observation: { attachedLicense: { preset: "commercial-remix", commercialRevShareBps: 500 } },
    });
  });

  test("reconciles a song whose attached terms map to no representable preset", async () => {
    const [registered, first] = AENEID_TERMS_RECEIPT.logs;
    expect(
      await observe(
        [registered, first],
        pilTerms("non-commercial", null, { derivativesAllowed: false }),
      ),
    ).toMatchObject({ status: "invalid" });
  });

  test("reconciles terms that require separate derivative approval", async () => {
    const [registered, first] = AENEID_TERMS_RECEIPT.logs;
    expect(
      await observe(
        [registered, first],
        pilTerms("commercial-remix", 1_000, { derivativesApproval: true }),
      ),
    ).toMatchObject({
      status: "invalid",
    });
  });
});

describe("attached-license backfill from a legacy confirmation", () => {
  const registeredParent: DataRegistrationOperation = {
    ...operation,
    state: "registered",
    registeredIpId: "0x1653b905597e0f778c0e9c2d8a9d5c003ee56614",
    confirmedTransactionHash: AENEID_TERMS_RECEIPT.transactionHash,
    confirmedBlockNumber: 23_425_318n,
    confirmedBlockHash: AENEID_TERMS_RECEIPT.blockHash,
    confirmedLogIndex: 4,
  };
  const read = (rpcMethod: (method: string) => Promise<unknown>) =>
    chain(
      { ...baseAuthority, licensePreset: "commercial-remix", commercialRemixShareBps: 1_000 },
      rpcMethod,
      { getLatestMinedReceipt: async () => null },
      "0x538048a26dbcc7a1dd446762098b0bfafa3a1472",
    ).readAttachedLicense(registeredParent);

  test("records the single attachment of the confirming transaction, with its coordinates", async () => {
    const [registered, first] = AENEID_TERMS_RECEIPT.logs;
    expect(
      await read(async (method) => {
        if (method === "eth_getTransactionReceipt") {
          return { ...AENEID_TERMS_RECEIPT, logs: [registered, first] };
        }
        if (method === "eth_call") return pilTerms("commercial-remix", 1_000);
        throw new Error("unexpected RPC method");
      }),
    ).toEqual({
      status: "recorded",
      attachedLicense: {
        licenseTemplate: "0x2e896b0b2fdb7457499b56aaaa4ae55bcb4cd316",
        licenseTermsId: "1894",
        preset: "commercial-remix",
        commercialRevShareBps: 1_000,
        attachment: {
          transactionHash: AENEID_TERMS_RECEIPT.transactionHash,
          blockNumber: 23_425_318n,
          blockHash: AENEID_TERMS_RECEIPT.blockHash,
          logIndex: 7,
        },
      },
    });
  });

  test("records the template's actual terms, never the publication license", async () => {
    const [registered, first] = AENEID_TERMS_RECEIPT.logs;
    expect(
      await read(async (method) => {
        if (method === "eth_getTransactionReceipt") {
          return { ...AENEID_TERMS_RECEIPT, logs: [registered, first] };
        }
        if (method === "eth_call") {
          return pilTerms("commercial-use");
        }
        throw new Error("unexpected RPC method");
      }),
    ).toMatchObject({
      status: "recorded",
      attachedLicense: { preset: "commercial-use", commercialRevShareBps: null },
    });
  });

  test("stays resumable on a mismatched receipt and ends only on a verified absence", async () => {
    expect(
      await read(async () => {
        throw new Error("RPC down");
      }),
    ).toEqual({ status: "unavailable" });
    expect(
      await read(async () => ({ ...AENEID_TERMS_RECEIPT, blockHash: `0x${"0".repeat(64)}` })),
    ).toEqual({ status: "unavailable" });
    expect(
      await read(async () => ({ ...AENEID_TERMS_RECEIPT, transactionHash: `0x${"1".repeat(64)}` })),
    ).toEqual({ status: "unavailable" });
    const [registered, first, second] = AENEID_TERMS_RECEIPT.logs;
    expect(
      await read(async () => ({
        ...AENEID_TERMS_RECEIPT,
        logs: [registered, first, second],
      })),
    ).toMatchObject({ status: "unrecorded" });
  });

  test("stays resumable when the terms cannot be read, and reports terms outside the preset as unsupported", async () => {
    const [registered, first] = AENEID_TERMS_RECEIPT.logs;
    const receiptFor = (method: string) => {
      if (method === "eth_getTransactionReceipt") {
        return Promise.resolve({ ...AENEID_TERMS_RECEIPT, logs: [registered, first] });
      }
      return Promise.reject(new Error("terms unavailable"));
    };
    expect(await read(receiptFor)).toEqual({ status: "unavailable" });
    const unsupported = async (method: string) =>
      method === "eth_getTransactionReceipt"
        ? { ...AENEID_TERMS_RECEIPT, logs: [registered, first] }
        : pilTerms("commercial-remix", 1_000, { derivativesApproval: true });
    expect(await read(unsupported)).toMatchObject({
      status: "unsupported",
      evidenceRef: "data-registration://aeneid/attached-license/terms-unsupported/1894",
    });
  });

  test("reads nothing for a song that is not fully confirmed", async () => {
    expect(
      await chain(baseAuthority).readAttachedLicense({ ...registeredParent, state: "pending" }),
    ).toMatchObject({ status: "unrecorded" });
  });
});

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

  test("plans an original-video register_ip with no license attachment", async () => {
    const plan = await chain(originalVideoAuthority).plan(operation, 1);
    expect(plan.reservation).toMatchObject({
      chainId: 1315n,
      signerNamespace: "data_registration",
      targetAddress: DATA_REGISTRATION_AENEID_TARGETS.original.toLowerCase(),
      methodSelector: DATA_REGISTRATION_AENEID_SELECTORS.original,
      valueWei: 0n,
    });
    const calldata = bytesToHex(plan.calldata);
    const decoded = decodeFunctionData({ abi: REGISTRATION_WORKFLOW_ABI, data: calldata });
    expect(decoded.functionName).toBe("mintAndRegisterIp");
    expect(decoded.args).toEqual([
      "0x3333333333333333333333333333333333333333",
      "0x1111111111111111111111111111111111111111",
      {
        ipMetadataURI: "ipfs://bafyip_metadata",
        ipMetadataHash: `0x${"b".repeat(64)}`,
        nftMetadataURI: "ipfs://bafynft_metadata",
        nftMetadataHash: `0x${"c".repeat(64)}`,
      },
      false,
    ]);
    // The calldata is structurally not a license-attachment invocation: it
    // does not decode as either attaching workflow.
    expect(() => decodeFunctionData({ abi: LICENSE_WORKFLOW_ABI, data: calldata })).toThrow();
    expect(() => decodeFunctionData({ abi: ROYALTY_WORKFLOW_ABI, data: calldata })).toThrow();
  });

  test("rejects intent and offered-license combinations outside the closed matrix", async () => {
    const invalid = [
      { ...baseAuthority, licensePreset: null },
      { ...baseAuthority, rightsBasis: "derivative" },
      { ...baseAuthority, mediaKind: "video", rightsBasis: "original" },
      {
        ...originalVideoAuthority,
        rightsBasis: "derivative",
      },
      {
        ...originalVideoAuthority,
        mediaKind: "song",
      },
    ] as unknown as readonly DataRegistrationArtifactAuthority[];
    for (const authority of invalid) {
      await expect(chain(authority).plan(operation, 1)).rejects.toThrow(
        "unsupported DATA registration intent",
      );
    }
  });

  test("confirms an original-video registration from its IPRegistered log", async () => {
    const originalAttempt = {
      ...attempt,
      targetAddress: DATA_REGISTRATION_AENEID_TARGETS.original,
      methodSelector: DATA_REGISTRATION_AENEID_SELECTORS.original,
    };
    const tokenContract = "0x3333333333333333333333333333333333333333";
    let head = "0xa";
    const rpc = async (method: string): Promise<unknown> => {
      if (method === "eth_blockNumber") return head;
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
                [
                  "0x4444444444444444444444444444444444444444",
                  "Original video",
                  "ipfs://metadata",
                  1n,
                ],
              ),
            },
          ],
        };
      }
      throw new Error("unexpected RPC method");
    };
    const videoOperation = { ...operation, mediaKind: "video" as const };
    const result = await chain(originalVideoAuthority, rpc).observeReceipt(
      videoOperation,
      originalAttempt,
    );
    expect(result).toMatchObject({ status: "mined" });
    head = "0xc";
    const confirmed = await chain(originalVideoAuthority, rpc).observeReceipt(
      videoOperation,
      originalAttempt,
    );
    expect(confirmed).toMatchObject({
      status: "confirmed",
      observation: {
        outcome: "confirmed",
        registeredIpId: "0x4444444444444444444444444444444444444444",
        ipMetadataHash: `0x${"b".repeat(64)}`,
        nftMetadataHash: `0x${"c".repeat(64)}`,
        attachedLicense: null,
      },
    });
  });

  test("recovers an original-video attempt from its persisted mined receipt", async () => {
    const originalAttempt = {
      ...attempt,
      targetAddress: DATA_REGISTRATION_AENEID_TARGETS.original,
      methodSelector: DATA_REGISTRATION_AENEID_SELECTORS.original,
      state: "mined" as const,
    };
    const result = await chain(originalVideoAuthority, async () => null, {
      getLatestMinedReceipt: async () => ({
        receiptObservationId: `${originalAttempt.submissionAttemptId}:receipt:1`,
        registrationOperationId: operation.registrationOperationId,
        submissionAttemptId: originalAttempt.submissionAttemptId,
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
    }).observeReceipt(operation, originalAttempt);
    expect(result).toMatchObject({
      status: "orphaned",
      observation: {
        outcome: "orphaned",
        blockNumber: 10n,
        blockHash: `0x${"f".repeat(64)}`,
      },
    });
  });

  test("rejects non-HTTPS RPC configuration before any request", () => {
    expect(() => makeJsonRpcTransport("http://aeneid.invalid")).toThrow("must use HTTPS");
  });

  test("uses Workers manual redirect mode and rejects redirect responses", async () => {
    let redirect: string | undefined;
    const rpc = makeJsonRpcTransport("https://aeneid.invalid", (async (_input, init) => {
      redirect = init?.redirect;
      return new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.invalid" },
      });
    }) as typeof fetch);
    await expect(rpc("eth_blockNumber", [])).rejects.toThrow("Aeneid RPC unavailable");
    expect(redirect).toBe("manual");
  });

  test("cancels an oversized chunked RPC response before buffering it", async () => {
    const chunk = new Uint8Array(600_000);
    const rpc = makeJsonRpcTransport(
      "https://aeneid.invalid",
      (async (_input, _init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(chunk);
              controller.enqueue(chunk);
              controller.close();
            },
          }),
          { status: 200 },
        )) as typeof fetch,
    );

    await expect(rpc("eth_getBalance", [`0x${"1".repeat(40)}`, "latest"])).rejects.toThrow(
      "Aeneid RPC response too large",
    );
  });

  test("keeps mined evidence schema-safe until final confirmations arrive", async () => {
    const tokenContract = "0x3333333333333333333333333333333333333333";
    let head = "0xa";
    const rpc = async (method: string): Promise<unknown> => {
      if (method === "eth_blockNumber") return head;
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
            termsAttachedLog("0x4444444444444444444444444444444444444444", 7n, "0x3"),
          ],
        };
      }
      if (method === "eth_call") {
        return pilTerms("non-commercial");
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
    head = "0xc";
    const confirmed = await chain(baseAuthority, rpc).observeReceipt(operation, attempt);
    expect(confirmed).toMatchObject({
      status: "confirmed",
      observation: {
        outcome: "confirmed",
        confirmations: 3,
        ipMetadataHash: `0x${"b".repeat(64)}`,
        nftMetadataHash: `0x${"c".repeat(64)}`,
        attachedLicense: {
          licenseTemplate: DATA_REGISTRATION_AENEID_LICENSE_TEMPLATE.toLowerCase(),
          licenseTermsId: "7",
          preset: "non-commercial",
          commercialRevShareBps: null,
          attachment: {
            transactionHash,
            blockNumber: 10n,
            blockHash: `0x${"f".repeat(64)}`,
            logIndex: 3,
          },
        },
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

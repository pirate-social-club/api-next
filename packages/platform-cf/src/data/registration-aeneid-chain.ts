import {
  type DataRegistrationOperation,
  type DataRegistrationPinVerification,
  type DataRegistrationReceiptInput,
  type DataRegistrationSigningAttempt,
  deterministicDataRegistrationAttemptId,
  deterministicDataRegistrationReceiptId,
  deterministicDataRegistrationSigningIntentId,
} from "@pirate/application/data/registration-persistence";
import type {
  DataRegistrationChainPipeline,
  DataRegistrationReceiptResult,
} from "@pirate/application/data/registration-workflow";
import { Predicate } from "effect";
import {
  type Address,
  bytesToHex,
  decodeEventLog,
  encodeFunctionData,
  type Hex,
  hexToBytes,
  isAddress,
  keccak256,
  stringToHex,
  toFunctionSelector,
  zeroAddress,
  zeroHash,
} from "viem";
import type {
  DataRegistrationArtifactAuthority,
  DataRegistrationArtifactAuthorityReader,
} from "./registration-artifact-pipeline";

const ROYALTY_WORKFLOW = "0xa38f42B8d33809917f23997B8423054aAB97322C";
const LICENSE_WORKFLOW = "0xcC2E862bCee5B6036Db0de6E06Ae87e524a79fd8";
const IP_ASSET_REGISTRY = "0x77319B4031e6eF1250907aa00018B8B1c67a244b";
const ROYALTY_POLICY_LAP = "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E";
const WIP_TOKEN = "0x1514000000000000000000000000000000000000";

const IP_REGISTERED_EVENT = {
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

const IP_METADATA_COMPONENTS = [
  { name: "ipMetadataURI", type: "string" },
  { name: "ipMetadataHash", type: "bytes32" },
  { name: "nftMetadataURI", type: "string" },
  { name: "nftMetadataHash", type: "bytes32" },
] as const;

const PIL_TERMS_COMPONENTS = [
  { name: "transferable", type: "bool" },
  { name: "royaltyPolicy", type: "address" },
  { name: "defaultMintingFee", type: "uint256" },
  { name: "expiration", type: "uint256" },
  { name: "commercialUse", type: "bool" },
  { name: "commercialAttribution", type: "bool" },
  { name: "commercializerChecker", type: "address" },
  { name: "commercializerCheckerData", type: "bytes" },
  { name: "commercialRevShare", type: "uint32" },
  { name: "commercialRevCeiling", type: "uint256" },
  { name: "derivativesAllowed", type: "bool" },
  { name: "derivativesAttribution", type: "bool" },
  { name: "derivativesApproval", type: "bool" },
  { name: "derivativesReciprocal", type: "bool" },
  { name: "derivativeRevCeiling", type: "uint256" },
  { name: "currency", type: "address" },
  { name: "uri", type: "string" },
] as const;

const LICENSING_CONFIG_COMPONENTS = [
  { name: "isSet", type: "bool" },
  { name: "mintingFee", type: "uint256" },
  { name: "licensingHook", type: "address" },
  { name: "hookData", type: "bytes" },
  { name: "commercialRevShare", type: "uint32" },
  { name: "disabled", type: "bool" },
  { name: "expectMinimumGroupRewardShare", type: "uint32" },
  { name: "expectGroupRewardPool", type: "address" },
] as const;

const LICENSE_TERMS_COMPONENTS = [
  { name: "terms", type: "tuple", components: PIL_TERMS_COMPONENTS },
  { name: "licensingConfig", type: "tuple", components: LICENSING_CONFIG_COMPONENTS },
] as const;

const LICENSE_WORKFLOW_ABI = [
  {
    type: "function",
    name: "mintAndRegisterIpAndAttachPILTerms",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spgNftContract", type: "address" },
      { name: "recipient", type: "address" },
      { name: "ipMetadata", type: "tuple", components: IP_METADATA_COMPONENTS },
      { name: "licenseTermsData", type: "tuple[]", components: LICENSE_TERMS_COMPONENTS },
      { name: "allowDuplicates", type: "bool" },
    ],
    outputs: [
      { name: "ipId", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "licenseTermsIds", type: "uint256[]" },
    ],
  },
] as const;

const ROYALTY_WORKFLOW_ABI = [
  {
    type: "function",
    name: "mintAndRegisterIpAndAttachPILTermsAndDistributeRoyaltyTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spgNftContract", type: "address" },
      { name: "recipient", type: "address" },
      { name: "ipMetadata", type: "tuple", components: IP_METADATA_COMPONENTS },
      { name: "licenseTermsData", type: "tuple[]", components: LICENSE_TERMS_COMPONENTS },
      {
        name: "royaltyShares",
        type: "tuple[]",
        components: [
          { name: "recipient", type: "address" },
          { name: "percentage", type: "uint32" },
        ],
      },
      { name: "allowDuplicates", type: "bool" },
    ],
    outputs: [
      { name: "ipId", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "licenseTermsIds", type: "uint256[]" },
    ],
  },
] as const;

const PIL_URIS = {
  "non-commercial":
    "https://github.com/piplabs/pil-document/blob/998c13e6ee1d04eb817aefd1fe16dfe8be3cd7a2/off-chain-terms/NCSR.json",
  "commercial-use":
    "https://github.com/piplabs/pil-document/blob/9a1f803fcf8101a8a78f1dcc929e6014e144ab56/off-chain-terms/CommercialUse.json",
  "commercial-remix":
    "https://github.com/piplabs/pil-document/blob/ad67bb632a310d2557f8abcccd428e4c9c798db1/off-chain-terms/CommercialRemix.json",
} as const;

type JsonRpc = (method: string, params: readonly unknown[]) => Promise<unknown>;

export type DataRegistrationAeneidChainOptions = Readonly<{
  authority: DataRegistrationArtifactAuthorityReader;
  rpc: JsonRpc;
  signerAddress: Address;
  spgNftContract: Address;
  requiredConfirmations: number;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  receiptReader: Readonly<{
    getLatestMinedReceipt: (
      submissionAttemptId: string,
    ) => Promise<DataRegistrationReceiptInput | null>;
  }>;
  signingWindowSeconds?: number;
}>;

export const DATA_REGISTRATION_AENEID_TARGETS = Object.freeze({
  license: LICENSE_WORKFLOW,
  royalty: ROYALTY_WORKFLOW,
});

export const DATA_REGISTRATION_AENEID_SELECTORS = Object.freeze({
  license: toFunctionSelector(LICENSE_WORKFLOW_ABI[0]),
  royalty: toFunctionSelector(ROYALTY_WORKFLOW_ABI[0]),
});

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const hexQuantity = (value: unknown): bigint => {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/u.test(value)) {
    throw new Error("invalid Aeneid quantity");
  }
  return BigInt(value);
};

const verifiedPin = (
  pins: readonly DataRegistrationPinVerification[],
  kind: DataRegistrationPinVerification["artifactKind"],
): DataRegistrationPinVerification => {
  const pin = pins.find(
    (candidate) =>
      candidate.artifactKind === kind &&
      candidate.role === "primary" &&
      candidate.providerId === "filebase" &&
      candidate.outcome === "verified" &&
      candidate.cid !== null &&
      candidate.canonicalSha256 !== null &&
      candidate.byteLength !== null,
  );
  if (pin === undefined) throw new Error(`missing ${kind} pin`);
  return pin;
};

const licenseTerms = (authority: DataRegistrationArtifactAuthority) => {
  const commercial = authority.licensePreset !== "non-commercial";
  const remix = authority.licensePreset === "commercial-remix";
  return {
    terms: {
      transferable: true,
      royaltyPolicy: commercial ? ROYALTY_POLICY_LAP : zeroAddress,
      defaultMintingFee: 0n,
      expiration: 0n,
      commercialUse: commercial,
      commercialAttribution: commercial,
      commercializerChecker: zeroAddress,
      commercializerCheckerData: zeroAddress,
      commercialRevShare: remix ? authority.commercialRemixShareBps * 10_000 : 0,
      commercialRevCeiling: 0n,
      derivativesAllowed: authority.licensePreset !== "commercial-use",
      derivativesAttribution: authority.licensePreset !== "commercial-use",
      derivativesApproval: false,
      derivativesReciprocal: authority.licensePreset !== "commercial-use",
      derivativeRevCeiling: 0n,
      currency: commercial ? WIP_TOKEN : zeroAddress,
      uri: PIL_URIS[authority.licensePreset],
    },
    licensingConfig: {
      isSet: false,
      mintingFee: 0n,
      licensingHook: zeroAddress,
      hookData: zeroHash,
      commercialRevShare: 0,
      disabled: false,
      expectMinimumGroupRewardShare: 0,
      expectGroupRewardPool: zeroAddress,
    },
  } as const;
};

const planCalldata = async (
  operation: DataRegistrationOperation,
  options: DataRegistrationAeneidChainOptions,
): Promise<
  Readonly<{ target: Address; calldata: Uint8Array; authority: DataRegistrationArtifactAuthority }>
> => {
  const authority = await options.authority.read(operation);
  const pins = await options.authority.listPins(operation.registrationOperationId);
  const ipMetadata = verifiedPin(pins, "ip_metadata");
  const nftMetadata = verifiedPin(pins, "nft_metadata");
  const metadata = {
    ipMetadataURI: `ipfs://${ipMetadata.cid}`,
    ipMetadataHash: `0x${ipMetadata.canonicalSha256}` as Hex,
    nftMetadataURI: `ipfs://${nftMetadata.cid}`,
    nftMetadataHash: `0x${nftMetadata.canonicalSha256}` as Hex,
  };
  const terms = [licenseTerms(authority)];
  const distributes = authority.licensePreset !== "non-commercial";
  const encoded = distributes
    ? encodeFunctionData({
        abi: ROYALTY_WORKFLOW_ABI,
        functionName: "mintAndRegisterIpAndAttachPILTermsAndDistributeRoyaltyTokens",
        args: [
          options.spgNftContract,
          authority.creatorAddress as Address,
          metadata,
          terms,
          authority.royaltyAllocations.map((allocation) => ({
            recipient: allocation.address as Address,
            percentage: allocation.shareBps * 10_000,
          })),
          false,
        ],
      })
    : encodeFunctionData({
        abi: LICENSE_WORKFLOW_ABI,
        functionName: "mintAndRegisterIpAndAttachPILTerms",
        args: [options.spgNftContract, authority.creatorAddress as Address, metadata, terms, false],
      });
  return {
    target: distributes ? ROYALTY_WORKFLOW : LICENSE_WORKFLOW,
    calldata: hexToBytes(encoded),
    authority,
  };
};

const receiptObservation = <Outcome extends "mined" | "confirmed" | "reverted" | "orphaned">(
  operation: DataRegistrationOperation,
  attempt: DataRegistrationSigningAttempt,
  receipt: Readonly<Record<string, unknown>>,
  blockNumber: bigint,
  registeredIpId: string | null,
  outcome: Outcome,
) => {
  const transactionHash = String(receipt.transactionHash ?? attempt.transactionHash ?? "");
  const blockHash = String(receipt.blockHash ?? "");
  const sequence = outcome === "confirmed" || outcome === "orphaned" ? 2n : 1n;
  return {
    receiptObservationId: deterministicDataRegistrationReceiptId(
      attempt.submissionAttemptId,
      sequence,
    ),
    registrationOperationId: operation.registrationOperationId,
    submissionAttemptId: attempt.submissionAttemptId,
    observationSequence: sequence,
    transactionHash,
    outcome,
    blockNumber,
    blockHash,
    logIndex: registeredIpId === null ? null : 0,
    confirmations: 0,
    registeredIpId,
    ipMetadataUri: null,
    ipMetadataHash: null,
    nftMetadataUri: null,
    nftMetadataHash: null,
    evidenceRef: `data-registration://aeneid/receipt/${attempt.submissionAttemptId}/${sequence}`,
    observedAt: new Date().toISOString(),
  } as const;
};

export function makeDataRegistrationAeneidChain(
  options: DataRegistrationAeneidChainOptions,
): DataRegistrationChainPipeline {
  if (
    !isAddress(options.signerAddress, { strict: true }) ||
    !isAddress(options.spgNftContract, { strict: true }) ||
    !Number.isSafeInteger(options.requiredConfirmations) ||
    options.requiredConfirmations < 1 ||
    options.gasLimit < 1n ||
    options.maxFeePerGas < 1n ||
    options.maxPriorityFeePerGas < 0n ||
    options.maxPriorityFeePerGas > options.maxFeePerGas
  ) {
    throw new TypeError("invalid Aeneid DATA configuration");
  }
  const signingWindowSeconds = options.signingWindowSeconds ?? 2_592_000;
  return {
    plan: async (operation, attemptNumber) => {
      if (operation.chainId !== 1315n || attemptNumber !== 1) {
        throw new Error("unsupported DATA registration plan");
      }
      const planned = await planCalldata(operation, options);
      const attemptId = deterministicDataRegistrationAttemptId(
        operation.registrationOperationId,
        attemptNumber,
      );
      const projectedAt = Date.parse(planned.authority.projectedAt);
      if (!Number.isFinite(projectedAt)) throw new Error("invalid publication time");
      const signingDeadline = new Date(projectedAt + signingWindowSeconds * 1_000).toISOString();
      const calldataHash = await sha256(planned.calldata);
      return {
        reservation: {
          registrationOperationId: operation.registrationOperationId,
          submissionAttemptId: attemptId,
          chainId: 1315n,
          attemptNumber,
          signerNamespace: "data_registration",
          signerAddress: options.signerAddress.toLowerCase(),
          signingIntentId: deterministicDataRegistrationSigningIntentId(attemptId),
          targetAddress: planned.target.toLowerCase(),
          methodSelector: bytesToHex(planned.calldata.slice(0, 4)),
          calldataHash,
          signingDeadline,
          valueWei: 0n,
          gasLimit: options.gasLimit,
          maxFeePerGas: options.maxFeePerGas,
          maxPriorityFeePerGas: options.maxPriorityFeePerGas,
          supersedesSubmissionAttemptId: null,
          evidenceRef: `data-registration://aeneid/plan/${attemptId}`,
        },
        calldata: planned.calldata,
      };
    },
    readNonce: async (_operation, attempt) => {
      const value = await options.rpc("eth_getTransactionCount", [
        attempt.signerAddress,
        "pending",
      ]);
      return {
        nonce: hexQuantity(value),
        evidenceRef: `data-registration://aeneid/nonce/${attempt.submissionAttemptId}`,
      };
    },
    broadcast: async (_operation, attempt) => {
      if (attempt.signedTransaction === null || attempt.signedTransactionHash === null) {
        return { status: "rejected", evidenceRef: "data-registration://prepared-bytes-missing" };
      }
      try {
        const result = await options.rpc("eth_sendRawTransaction", [
          bytesToHex(attempt.signedTransaction),
        ]);
        return typeof result === "string" && /^0x[0-9a-f]{64}$/u.test(result)
          ? {
              status: "broadcast",
              transactionHash: result,
              evidenceRef: `data-registration://aeneid/broadcast/${attempt.submissionAttemptId}`,
            }
          : {
              status: "rejected",
              evidenceRef: "data-registration://aeneid/broadcast-invalid",
            };
      } catch {
        return { status: "retryable" };
      }
    },
    observeReceipt: async (operation, attempt): Promise<DataRegistrationReceiptResult> => {
      if (attempt.transactionHash === null) return { status: "retryable" };
      let raw: unknown;
      try {
        raw = await options.rpc("eth_getTransactionReceipt", [attempt.transactionHash]);
      } catch {
        return { status: "retryable" };
      }
      if (raw === null) {
        if (attempt.state !== "mined") return { status: "pending" };
        const prior = await options.receiptReader.getLatestMinedReceipt(
          attempt.submissionAttemptId,
        );
        if (
          prior === null ||
          prior.blockNumber === null ||
          prior.blockHash === null ||
          !/^0x[0-9a-f]{64}$/u.test(prior.blockHash)
        ) {
          return { status: "retryable" };
        }
        const orphaned = receiptObservation(
          operation,
          attempt,
          { blockHash: prior.blockHash },
          prior.blockNumber,
          null,
          "orphaned",
        );
        return { status: "orphaned", observation: orphaned };
      }
      if (!Predicate.isObject(raw)) return { status: "retryable" };
      const receipt = raw as Readonly<Record<string, unknown>>;
      const blockNumber = hexQuantity(receipt.blockNumber);
      const status = hexQuantity(receipt.status);
      const transactionHash = String(receipt.transactionHash ?? "");
      const blockHash = String(receipt.blockHash ?? "");
      if (
        transactionHash !== attempt.transactionHash ||
        !/^0x[0-9a-f]{64}$/u.test(blockHash) ||
        (status !== 0n && status !== 1n)
      ) {
        return { status: "retryable" };
      }
      let registeredIpId: string | null = null;
      let registeredLogIndex: number | null = null;
      if (Array.isArray(receipt.logs)) {
        for (const candidate of receipt.logs) {
          if (!Predicate.isObject(candidate)) continue;
          try {
            const decoded = decodeEventLog({
              abi: [IP_REGISTERED_EVENT],
              data: String(candidate.data) as Hex,
              topics: candidate.topics as [Hex, ...Hex[]],
            });
            const args = decoded.args as Readonly<{
              ipId: Address;
              chainId: bigint;
              tokenContract: Address;
            }>;
            if (
              args.chainId === 1315n &&
              args.tokenContract.toLowerCase() === options.spgNftContract.toLowerCase() &&
              String(candidate.address).toLowerCase() === IP_ASSET_REGISTRY.toLowerCase()
            ) {
              registeredIpId = args.ipId.toLowerCase();
              const logIndex = Number(hexQuantity(candidate.logIndex));
              if (!Number.isSafeInteger(logIndex) || logIndex < 0) continue;
              registeredLogIndex = logIndex;
              break;
            }
          } catch {
            // Other receipt logs are unrelated to IP registration.
          }
        }
      }
      if (status === 0n) {
        return {
          status: "reverted",
          observation: receiptObservation(
            operation,
            attempt,
            receipt,
            blockNumber,
            null,
            "reverted",
          ),
        };
      }
      if (registeredIpId === null) return { status: "retryable" };
      let head: bigint;
      try {
        head = hexQuantity(await options.rpc("eth_blockNumber", []));
      } catch {
        return { status: "retryable" };
      }
      const confirmations = head >= blockNumber ? Number(head - blockNumber + 1n) : 0;
      if (confirmations >= options.requiredConfirmations) {
        const pins = await options.authority.listPins(operation.registrationOperationId);
        const ipMetadata = verifiedPin(pins, "ip_metadata");
        const nftMetadata = verifiedPin(pins, "nft_metadata");
        const ipCid = ipMetadata.cid;
        const ipHash = ipMetadata.canonicalSha256;
        const nftCid = nftMetadata.cid;
        const nftHash = nftMetadata.canonicalSha256;
        if (ipCid === null || ipHash === null || nftCid === null || nftHash === null) {
          return { status: "retryable" };
        }
        return {
          status: "confirmed",
          observation: {
            ...receiptObservation(
              operation,
              attempt,
              receipt,
              blockNumber,
              registeredIpId,
              "confirmed",
            ),
            registeredIpId,
            confirmations,
            logIndex: registeredLogIndex ?? 0,
            ipMetadataUri: `ipfs://${ipCid}`,
            ipMetadataHash: ipHash,
            nftMetadataUri: `ipfs://${nftCid}`,
            nftMetadataHash: nftHash,
          },
        };
      }
      const prior = await options.receiptReader.getLatestMinedReceipt(attempt.submissionAttemptId);
      if (
        prior !== null &&
        prior.transactionHash === transactionHash &&
        prior.blockNumber === blockNumber &&
        prior.blockHash === blockHash
      ) {
        return { status: "mined", observation: prior };
      }
      return {
        status: "mined",
        observation: {
          ...receiptObservation(operation, attempt, receipt, blockNumber, null, "mined"),
          confirmations,
        },
      };
    },
  };
}

export function makeJsonRpcTransport(
  rpcUrl: string,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): JsonRpc {
  const url = new URL(rpcUrl);
  if (url.protocol !== "https:") throw new TypeError("Aeneid RPC URL must use HTTPS");
  let sequence = 0;
  return async (method, params) => {
    sequence += 1;
    const response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: sequence, method, params }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Aeneid RPC unavailable");
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > 1_048_576) {
      await response.body?.cancel("response_too_large");
      throw new Error("Aeneid RPC response too large");
    }
    const responseText = await response.text();
    if (responseText.length > 1_048_576) throw new Error("Aeneid RPC response too large");
    let body: unknown;
    try {
      body = JSON.parse(responseText);
    } catch {
      throw new Error("Aeneid RPC invalid response");
    }
    if (!Predicate.isObject(body) || "error" in body || !("result" in body)) {
      throw new Error("Aeneid RPC invalid response");
    }
    return body.result;
  };
}

export const DATA_REGISTRATION_IP_REGISTERED_TOPIC = keccak256(
  stringToHex("IPRegistered(address,uint256,address,uint256,string,string,uint256)"),
);

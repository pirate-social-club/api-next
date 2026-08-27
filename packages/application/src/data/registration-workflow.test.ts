import { describe, expect, test } from "bun:test";
import type {
  DataRegistrationArtifact,
  DataRegistrationOperation,
  DataRegistrationOutbox,
  DataRegistrationPinVerification,
  DataRegistrationSigningAttempt,
  DataRegistrationStore,
  ReserveDataRegistrationAttemptInput,
} from "./registration-persistence";
import {
  deterministicDataRegistrationArtifactId,
  deterministicDataRegistrationAttemptId,
  deterministicDataRegistrationSigningIntentId,
  deterministicDataRegistrationWorkflowId,
} from "./registration-persistence";
import {
  advanceDataRegistrationWorkflow,
  type DataRegistrationPreparedArtifact,
  type DataRegistrationWorkflowDependencies,
  type DataRegistrationWorkflowPayload,
} from "./registration-workflow";

const OPERATION_ID = "data-registration:1315:asset-1:1";
const ATTEMPT_ID = deterministicDataRegistrationAttemptId(OPERATION_ID, 1);
const WORKFLOW_ID = deterministicDataRegistrationWorkflowId(OPERATION_ID, 1n);
const TRANSACTION_HASH = `0x${"b".repeat(64)}`;
const CALLDATA = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0xaa]);
const CALLDATA_HASH = "80a14a107e4724bab764e13dc3b98e044961bea9c078973e3b2956a35a098811";

const operation = (): DataRegistrationOperation => ({
  registrationOperationId: OPERATION_ID,
  communityId: "community-1",
  actorUserId: "user-1",
  submissionId: "submission-1",
  mediaOperationId: "media-operation-1",
  postId: "post-1",
  assetId: "asset-1",
  chainId: 1315n,
  registrationRevision: 1n,
  publicationCreationRevision: 1n,
  publicationAudioRevision: 1n,
  publicationAnalysisRevision: 1n,
  publicationDecisionRevision: 1n,
  canonicalAudioSha256: "a".repeat(64),
  state: "pending",
  workflowRevision: 1n,
  workflowInstanceId: WORKFLOW_ID,
  currentAttemptId: null,
  registeredIpId: null,
  confirmedTransactionHash: null,
  confirmedBlockNumber: null,
  confirmedBlockHash: null,
  confirmedLogIndex: null,
  confirmedAt: null,
  failureCode: null,
  failureEvidenceRef: null,
});

const reservation = (): ReserveDataRegistrationAttemptInput => ({
  registrationOperationId: OPERATION_ID,
  submissionAttemptId: ATTEMPT_ID,
  chainId: 1315n,
  attemptNumber: 1,
  signerNamespace: "data-registration-staging",
  signerAddress: `0x${"1".repeat(40)}`,
  signingIntentId: deterministicDataRegistrationSigningIntentId(ATTEMPT_ID),
  targetAddress: `0x${"2".repeat(40)}`,
  methodSelector: "0x12345678",
  calldataHash: CALLDATA_HASH,
  signingDeadline: "2026-08-27T01:00:00.000Z",
  valueWei: 0n,
  gasLimit: 1_500_000n,
  maxFeePerGas: 5_000_000_000n,
  maxPriorityFeePerGas: 2_000_000_000n,
  supersedesSubmissionAttemptId: null,
  evidenceRef: "evidence://plan/1",
});

const signingAttempt = (
  input: ReserveDataRegistrationAttemptInput,
): DataRegistrationSigningAttempt => ({
  ...input,
  nonce: null,
  signedTransaction: null,
  signedTransactionHash: null,
  transactionHash: null,
  state: "signing_intent",
  failureCode: null,
  failureEvidenceRef: null,
});

const artifact = (
  kind: DataRegistrationArtifact["artifactKind"],
  hashByte: string,
): DataRegistrationPreparedArtifact => ({
  artifact: {
    artifactId: deterministicDataRegistrationArtifactId(OPERATION_ID, kind),
    registrationOperationId: OPERATION_ID,
    artifactKind: kind,
    sourceRef: `source://${kind}`,
    mediaType: kind.endsWith("metadata") ? "application/json" : "audio/mpeg",
    byteLength: 1n,
    canonicalSha256: hashByte.repeat(64),
    canonicalizationRevision: kind.endsWith("metadata") ? "rfc8785-jcs-v1" : null,
  },
  filename: `${kind}.bin`,
  contentType: kind.endsWith("metadata") ? "application/json" : "audio/mpeg",
  open: async function* () {
    yield new Uint8Array([1]);
  },
});

const ARTIFACTS = [
  artifact("canonical_audio", "a"),
  artifact("ip_metadata", "b"),
  artifact("nft_metadata", "c"),
];

function harness(
  receipt: "confirmed" | "orphaned" = "confirmed",
  stagedArtifacts = false,
  gatewayRetryAfterPrimary = false,
) {
  let currentOperation = operation();
  let currentAttempt: DataRegistrationSigningAttempt | null = null;
  const artifacts = new Map<string, DataRegistrationArtifact>();
  const pins = new Map<string, DataRegistrationPinVerification>();
  const calls: string[] = [];
  const outbox: DataRegistrationOutbox = {
    outboxId: payload.outboxId,
    registrationOperationId: OPERATION_ID,
    workflowRevision: 1n,
    workflowInstanceId: WORKFLOW_ID,
    eventType: "registration_launch",
    effectIdentity: "effect-1",
    state: "delivered",
    deliveryAttempts: 1,
    claimOwner: null,
    claimFence: 1n,
    leaseExpiresAt: null,
    nextEligibleAt: null,
    failureCode: null,
  };

  const store = {
    getOperation: async () => currentOperation,
    pinsReady: async () =>
      ARTIFACTS.every(({ artifact: value }) =>
        ["primary", "independent_gateway"].every((role) =>
          [...pins.values()].some(
            (pin) => pin.artifactId === value.artifactId && pin.role === role,
          ),
        ),
      ),
    recordArtifact: async (value: DataRegistrationArtifact) => {
      calls.push(`artifact:${value.artifactKind}`);
      artifacts.set(value.artifactId, value);
      return "created" as const;
    },
    recordPinVerification: async (value: DataRegistrationPinVerification) => {
      calls.push(`pin:${value.role}:${value.artifactKind}`);
      pins.set(value.pinVerificationId, value);
      return "created" as const;
    },
    reserveSigningAttempt: async (input: ReserveDataRegistrationAttemptInput) => {
      calls.push("reserve-attempt");
      currentAttempt ??= signingAttempt(input);
      currentOperation = { ...currentOperation, state: "signing", currentAttemptId: ATTEMPT_ID };
      return { kind: "created" as const, attempt: currentAttempt };
    },
    reserveNonce: async (_attemptId: string, nonce: bigint) => {
      calls.push("reserve-nonce");
      if (currentAttempt === null) throw new Error("attempt missing");
      currentAttempt = { ...currentAttempt, nonce, state: "nonce_reserved" };
      return currentAttempt;
    },
    markBroadcast: async (_attemptId: string, transactionHash: string) => {
      calls.push("mark-broadcast");
      if (currentAttempt === null) throw new Error("attempt missing");
      currentAttempt = { ...currentAttempt, transactionHash, state: "broadcast" };
      currentOperation = { ...currentOperation, state: "broadcast" };
      return currentAttempt;
    },
    recordReceipt: async () => {
      calls.push("record-receipt");
      return "created" as const;
    },
    markMined: async () => {
      calls.push("mark-mined");
      if (currentAttempt === null) throw new Error("attempt missing");
      currentAttempt = { ...currentAttempt, state: "mined" };
      currentOperation = { ...currentOperation, state: "confirming" };
      return currentAttempt;
    },
    confirmRegistration: async (observation: {
      registeredIpId: string;
      transactionHash: string;
    }) => {
      calls.push("confirm");
      if (currentAttempt !== null) currentAttempt = { ...currentAttempt, state: "confirmed" };
      currentOperation = {
        ...currentOperation,
        state: "registered",
        registeredIpId: observation.registeredIpId,
        confirmedTransactionHash: observation.transactionHash,
      };
      return currentOperation;
    },
    failRegistration: async (input: {
      operationState: "failed" | "reconciliation_required";
      operationFailureCode: DataRegistrationOperation["failureCode"];
      evidenceRef: string;
    }) => {
      calls.push(`fail:${input.operationState}`);
      currentOperation = {
        ...currentOperation,
        state: input.operationState,
        failureCode: input.operationFailureCode,
        failureEvidenceRef: input.evidenceRef,
      };
      return currentOperation;
    },
    getOutbox: async (outboxId: string) => (outboxId === outbox.outboxId ? outbox : null),
  } as unknown as DataRegistrationStore;

  const dependencies: DataRegistrationWorkflowDependencies = {
    store,
    signingReader: { getSigningAttempt: async () => currentAttempt },
    pinReader: { listPinVerifications: async () => [...pins.values()] },
    artifacts: {
      prepare: async () =>
        stagedArtifacts &&
        ![...pins.values()].some(
          (pin) =>
            pin.artifactKind === "canonical_audio" &&
            pin.role === "primary" &&
            pin.outcome === "verified",
        )
          ? ARTIFACTS.slice(0, 1)
          : ARTIFACTS,
      pinAndVerify: async (_operation, prepared) => {
        calls.push(`provider-pin:${prepared.artifact.artifactKind}`);
        if (gatewayRetryAfterPrimary) {
          return {
            status: "primary_verified" as const,
            cid: "bafycanonicalaudio",
            byteLength: prepared.artifact.byteLength,
            canonicalSha256: prepared.artifact.canonicalSha256,
            primaryEvidenceRef: "evidence://filebase/canonical_audio",
            gatewayEvidenceRef: "evidence://ipfs.io/canonical_audio/not-found",
            verifiedAt: "2026-08-27T00:00:00.000Z",
            gatewayRetryable: true,
          };
        }
        return {
          status: "verified" as const,
          cid: `bafy${prepared.artifact.artifactKind}`,
          byteLength: prepared.artifact.byteLength,
          canonicalSha256: prepared.artifact.canonicalSha256,
          primaryEvidenceRef: `evidence://filebase/${prepared.artifact.artifactKind}`,
          gatewayEvidenceRef: `evidence://ipfs.io/${prepared.artifact.artifactKind}`,
          verifiedAt: "2026-08-27T00:00:00.000Z",
        };
      },
    },
    chain: {
      plan: async () => ({ reservation: reservation(), calldata: CALLDATA }),
      readNonce: async () => {
        calls.push("read-nonce");
        return { nonce: 7n, evidenceRef: "evidence://nonce/7" };
      },
      broadcast: async () => {
        calls.push("broadcast");
        return {
          status: "broadcast" as const,
          transactionHash: TRANSACTION_HASH,
          evidenceRef: "evidence://broadcast/1",
        };
      },
      observeReceipt: async (_operation, attempt) => {
        calls.push("receipt");
        const common = {
          receiptObservationId: `${ATTEMPT_ID}:receipt:1`,
          registrationOperationId: OPERATION_ID,
          submissionAttemptId: ATTEMPT_ID,
          observationSequence: 1n,
          transactionHash: attempt.transactionHash ?? TRANSACTION_HASH,
          blockNumber: 10n,
          blockHash: `0x${"d".repeat(64)}`,
          logIndex: 0,
          confirmations: 3,
          registeredIpId: "ip-1",
          ipMetadataUri: "ipfs://ip-metadata",
          ipMetadataHash: `0x${"b".repeat(64)}`,
          nftMetadataUri: "ipfs://nft-metadata",
          nftMetadataHash: `0x${"c".repeat(64)}`,
          evidenceRef: `evidence://receipt/${receipt}`,
          observedAt: "2026-08-27T00:00:00.000Z",
        };
        return receipt === "confirmed"
          ? {
              status: "confirmed" as const,
              observation: { ...common, outcome: "confirmed" as const },
            }
          : {
              status: "orphaned" as const,
              observation: { ...common, outcome: "orphaned" as const },
            };
      },
    },
    signer: {
      sign: async () => {
        calls.push("sign");
        if (currentAttempt === null) throw new Error("attempt missing");
        currentAttempt = {
          ...currentAttempt,
          state: "prepared",
          signedTransaction: new Uint8Array([1, 2, 3]),
          signedTransactionHash: TRANSACTION_HASH,
        };
        return {
          kind: "signed",
          submissionAttemptId: ATTEMPT_ID,
          signedTransactionHash: TRANSACTION_HASH,
          state: "prepared",
        };
      },
    },
    options: { enabled: true },
  };

  return {
    calls,
    dependencies,
    operation: () => currentOperation,
    attempt: () => currentAttempt,
    pins: () => [...pins.values()],
  };
}

const payload: DataRegistrationWorkflowPayload = {
  outboxId: `${OPERATION_ID}:outbox:r1`,
  registrationOperationId: OPERATION_ID,
  workflowRevision: 1n,
};

describe("DATA registration Workflow interpreter", () => {
  test("converges the fake transport through retained pins to registered", async () => {
    const state = harness();
    let outcome = await advanceDataRegistrationWorkflow(payload, state.dependencies);
    expect(outcome).toEqual({ outcome: "progress" });
    expect(state.calls).not.toContain("sign");

    for (let index = 0; index < 8 && outcome.outcome !== "registered"; index += 1) {
      outcome = await advanceDataRegistrationWorkflow(payload, state.dependencies);
    }
    expect(outcome).toEqual({ outcome: "registered" });
    expect(state.operation().state).toBe("registered");
    expect(state.calls.indexOf("sign")).toBeGreaterThan(
      state.calls.lastIndexOf("pin:independent_gateway:nft_metadata"),
    );
    expect(state.calls).toContain("broadcast");
    expect(state.calls).toContain("confirm");
  });

  test("pins audio before preparing metadata that depends on its CID", async () => {
    const state = harness("confirmed", true);
    expect(await advanceDataRegistrationWorkflow(payload, state.dependencies)).toEqual({
      outcome: "progress",
    });
    expect(state.calls).toContain("provider-pin:canonical_audio");
    expect(state.calls).not.toContain("artifact:ip_metadata");

    expect(await advanceDataRegistrationWorkflow(payload, state.dependencies)).toEqual({
      outcome: "progress",
    });
    expect(state.calls).toContain("artifact:ip_metadata");
    expect(state.calls).toContain("artifact:nft_metadata");
  });

  test("persists a successful Filebase pin before retrying gateway propagation", async () => {
    const state = harness("confirmed", true, true);

    expect(await advanceDataRegistrationWorkflow(payload, state.dependencies)).toEqual({
      outcome: "waiting",
    });
    expect(state.pins()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "primary", outcome: "verified" }),
        expect.objectContaining({ role: "independent_gateway", outcome: "failed" }),
      ]),
    );
  });

  test("converges a fast-confirmed broadcast through the mined fence", async () => {
    const state = harness();
    await advanceDataRegistrationWorkflow(payload, state.dependencies);
    await advanceDataRegistrationWorkflow(payload, state.dependencies);
    await advanceDataRegistrationWorkflow(payload, state.dependencies);
    await advanceDataRegistrationWorkflow(payload, state.dependencies);
    expect(state.attempt()?.state).toBe("prepared");

    await advanceDataRegistrationWorkflow(payload, state.dependencies);
    expect(state.attempt()?.state).toBe("broadcast");
    state.calls.length = 0;
    expect(await advanceDataRegistrationWorkflow(payload, state.dependencies)).toEqual({
      outcome: "registered",
    });
    expect(state.calls).toEqual(["receipt", "record-receipt", "mark-mined", "confirm"]);
  });

  test("does not repeat the mined transition when confirming a mined attempt", async () => {
    const state = harness();
    await advanceDataRegistrationWorkflow(payload, state.dependencies);
    await advanceDataRegistrationWorkflow(payload, state.dependencies);
    await advanceDataRegistrationWorkflow(payload, state.dependencies);
    await advanceDataRegistrationWorkflow(payload, state.dependencies);
    await advanceDataRegistrationWorkflow(payload, state.dependencies);
    expect(state.attempt()?.state).toBe("broadcast");

    await state.dependencies.store.markMined(ATTEMPT_ID, "evidence://receipt/mined");
    state.calls.length = 0;
    expect(await advanceDataRegistrationWorkflow(payload, state.dependencies)).toEqual({
      outcome: "registered",
    });
    expect(state.calls).toEqual(["receipt", "record-receipt", "confirm"]);
  });

  test("preserves a durable primary pin while completing its missing gateway", async () => {
    const state = harness();
    const canonical = ARTIFACTS[0];
    if (canonical === undefined) throw new Error("canonical fixture missing");
    await state.dependencies.store.recordArtifact(canonical.artifact);
    await state.dependencies.store.recordPinVerification({
      pinVerificationId: `${canonical.artifact.artifactId}:pin:filebase:1`,
      registrationOperationId: OPERATION_ID,
      artifactId: canonical.artifact.artifactId,
      artifactKind: canonical.artifact.artifactKind,
      role: "primary",
      providerId: "filebase",
      attemptNumber: 1,
      outcome: "verified",
      cid: `bafy${canonical.artifact.artifactKind}`,
      canonicalSha256: canonical.artifact.canonicalSha256,
      byteLength: canonical.artifact.byteLength,
      evidenceRef: "evidence://filebase/canonical_audio",
      verifiedAt: "2026-08-27T00:00:00.000Z",
    });
    await state.dependencies.store.recordPinVerification({
      pinVerificationId: `${canonical.artifact.artifactId}:gateway:ipfs.io:1`,
      registrationOperationId: OPERATION_ID,
      artifactId: canonical.artifact.artifactId,
      artifactKind: canonical.artifact.artifactKind,
      role: "independent_gateway",
      providerId: "ipfs.io",
      attemptNumber: 1,
      outcome: "failed",
      cid: null,
      canonicalSha256: null,
      byteLength: null,
      evidenceRef: "evidence://ipfs.io/canonical_audio/unavailable",
      verifiedAt: null,
    });
    state.calls.length = 0;

    expect(await advanceDataRegistrationWorkflow(payload, state.dependencies)).toEqual({
      outcome: "progress",
    });
    expect(state.calls.filter((call) => call === "pin:primary:canonical_audio")).toHaveLength(0);
    expect(state.calls).toContain("pin:independent_gateway:canonical_audio");
    expect(
      state
        .pins()
        .find(
          (pin) =>
            pin.artifactId === canonical.artifact.artifactId &&
            pin.role === "independent_gateway" &&
            pin.outcome === "verified",
        )?.attemptNumber,
    ).toBe(2);
    expect(state.calls).not.toContain("sign");
  });

  test("fails visibly on an orphaned receipt instead of hiding a reorg", async () => {
    const state = harness("orphaned");
    let result = await advanceDataRegistrationWorkflow(payload, state.dependencies);
    for (let index = 0; index < 8 && result.outcome !== "failed"; index += 1) {
      result = await advanceDataRegistrationWorkflow(payload, state.dependencies);
    }
    expect(result).toEqual({ outcome: "failed" });
    expect(state.operation()).toMatchObject({
      state: "reconciliation_required",
      failureCode: "chain_reorganization",
    });
  });

  test("is inert while disabled and performs no provider effect", async () => {
    const state = harness();
    const disabled = {
      ...state.dependencies,
      options: { enabled: false },
    };
    expect(await advanceDataRegistrationWorkflow(payload, disabled)).toEqual({ outcome: "inert" });
    expect(state.calls).toEqual([]);
  });

  test("rejects an operation payload that is not fenced to its persisted outbox", async () => {
    const state = harness();
    expect(
      await advanceDataRegistrationWorkflow(
        { ...payload, outboxId: `${OPERATION_ID}:outbox:hostile` },
        state.dependencies,
      ),
    ).toEqual({ outcome: "failed" });
    expect(state.calls).toEqual([]);
  });
});

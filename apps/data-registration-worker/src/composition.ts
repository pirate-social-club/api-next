import type {
  DataRegistrationSigningService,
  DataRegistrationWorkflowDependencies,
} from "@pirate/application/data/registration-workflow";
import {
  type DataRegistrationSigningPolicy,
  makeDataRegistrationSigningCoordinator,
} from "@pirate/application/data/signing-coordinator";
import {
  type FilebaseIpfsTransport,
  makeFilebaseIpfsPinningAdapter,
} from "@pirate/platform-cf/data/filebase-ipfs-pinning";
import { makeIpfsIoGatewayVerifier } from "@pirate/platform-cf/data/ipfs-live-gateway";
import {
  DATA_REGISTRATION_AENEID_SELECTORS,
  DATA_REGISTRATION_AENEID_TARGETS,
  makeDataRegistrationAeneidChain,
  makeJsonRpcTransport,
} from "@pirate/platform-cf/data/registration-aeneid-chain";
import {
  makeDataRegistrationArtifactPipeline,
  makePostgresDataRegistrationArtifactAuthorityReader,
} from "@pirate/platform-cf/data/registration-artifact-pipeline";
import { makeDataRegistrationStagingSignerLayer } from "@pirate/platform-cf/data/registration-staging-signer";
import {
  type CloudflareDataRegistrationWorkflowBinding,
  makeCloudflareDataRegistrationWorkflowLauncher,
} from "@pirate/platform-cf/data/registration-workflow-cloudflare";
import { makeDataRegistrationWorkflowReaders } from "@pirate/platform-cf/data/registration-workflow-reader";
import { makeDataRegistrationSigningIntentReader } from "@pirate/platform-cf/data/signing-intent-reader";
import { makeDataRegistrationStore } from "@pirate/platform-cf/data-registration-repository";
import { makeHyperdriveControlPlaneLayer } from "@pirate/platform-cf/postgres";
import { Effect } from "effect";
import type { DataRegistrationWorkerComposition, DataRegistrationWorkerEnv } from "./index.ts";
import { isDataRegistrationEnabled } from "./posture.ts";

export type DataRegistrationRuntimeEnv = DataRegistrationWorkerEnv &
  Readonly<{
    CONTROL_PLANE?: Readonly<{ connectionString: string }>;
    API_NEXT_ENV?: string;
    DATA_REGISTRATION_WORKFLOW?: CloudflareDataRegistrationWorkflowBinding;
    MEDIA_IMMUTABLE_ORIGINALS?: R2Bucket;
    DATA_REGISTRATION_CHAIN_ID?: string;
    DATA_REGISTRATION_RPC_URL?: string;
    DATA_REGISTRATION_SIGNER_ADDRESS?: string;
    DATA_REGISTRATION_SPG_NFT_CONTRACT?: string;
    DATA_REGISTRATION_STAGING_PRIVATE_KEY?: string;
    DATA_REGISTRATION_REQUIRED_CONFIRMATIONS?: string;
    DATA_REGISTRATION_PUBLIC_ORIGIN?: string;
    FILEBASE_IPFS_TOKEN?: string;
  }>;

const required = <T>(value: T | undefined, name: string): T => {
  if (value === undefined || (typeof value === "string" && value.trim().length === 0)) {
    throw new Error(`${name} is required when DATA registration is enabled`);
  }
  return value;
};

const positiveInteger = (value: string | undefined, name: string): number => {
  const parsed = Number(required(value, name));
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} is invalid`);
  return parsed;
};

function makeFilebaseFetchTransport(): FilebaseIpfsTransport {
  return async (request) => {
    const iterator = request.body.open(request.signal)[Symbol.asyncIterator]();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await iterator.return?.();
      },
    });
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body,
      redirect: request.redirect,
      signal: request.signal,
    });
    const responseBody = response.body;
    if (responseBody === null) throw new Error("Filebase response body missing");
    return {
      status: response.status,
      headers: response.headers,
      body: {
        open: async function* () {
          const reader = responseBody.getReader();
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) return;
              yield next.value;
            }
          } finally {
            reader.releaseLock();
          }
        },
        cancel: (reason?: unknown) => responseBody.cancel(reason),
      },
    };
  };
}

const workflowIsNeverMissingByThrownError = (): boolean => false;

const disabledWorkflow = (): DataRegistrationWorkflowDependencies =>
  ({ options: { enabled: false } }) as DataRegistrationWorkflowDependencies;

export function makeDataRegistrationComposition(
  env: DataRegistrationRuntimeEnv,
): DataRegistrationWorkerComposition {
  const controlPlane = required(env.CONTROL_PLANE, "CONTROL_PLANE");
  const workflowBinding = required(env.DATA_REGISTRATION_WORKFLOW, "DATA_REGISTRATION_WORKFLOW");
  const runtime = makeHyperdriveControlPlaneLayer(controlPlane);
  const store = makeDataRegistrationStore(runtime);
  const workflow = makeCloudflareDataRegistrationWorkflowLauncher(
    workflowBinding,
    workflowIsNeverMissingByThrownError,
  );
  const queue = {
    store,
    workflow,
    workerId: `data-registration-${crypto.randomUUID()}`,
    leaseSeconds: 60,
  };
  if (!isDataRegistrationEnabled(env.DATA_REGISTRATION_ENABLED)) {
    return { queue, workflow: disabledWorkflow() };
  }

  if (env.API_NEXT_ENV !== "staging") {
    throw new Error("the reviewed DATA registration signer is staging-only");
  }

  const chainId = BigInt(required(env.DATA_REGISTRATION_CHAIN_ID, "DATA_REGISTRATION_CHAIN_ID"));
  if (chainId !== 1315n) throw new Error("only Aeneid DATA registration is authorized");
  const signerAddress = required(
    env.DATA_REGISTRATION_SIGNER_ADDRESS,
    "DATA_REGISTRATION_SIGNER_ADDRESS",
  );
  const spgNftContract = required(
    env.DATA_REGISTRATION_SPG_NFT_CONTRACT,
    "DATA_REGISTRATION_SPG_NFT_CONTRACT",
  );
  const immutableOriginals = required(env.MEDIA_IMMUTABLE_ORIGINALS, "MEDIA_IMMUTABLE_ORIGINALS");
  const authority = makePostgresDataRegistrationArtifactAuthorityReader(runtime);
  const readers = makeDataRegistrationWorkflowReaders(runtime);
  const gasLimit = 1_500_000n;
  const maximumFeePerGas = 5_000_000_000n;
  const maximumPriorityFeePerGas = 2_000_000_000n;
  const chain = makeDataRegistrationAeneidChain({
    authority,
    receiptReader: readers.receiptReader,
    rpc: makeJsonRpcTransport(required(env.DATA_REGISTRATION_RPC_URL, "DATA_REGISTRATION_RPC_URL")),
    signerAddress: signerAddress as `0x${string}`,
    spgNftContract: spgNftContract as `0x${string}`,
    requiredConfirmations: positiveInteger(
      env.DATA_REGISTRATION_REQUIRED_CONFIRMATIONS,
      "DATA_REGISTRATION_REQUIRED_CONFIRMATIONS",
    ),
    gasLimit,
    maxFeePerGas: maximumFeePerGas,
    maxPriorityFeePerGas: maximumPriorityFeePerGas,
  });
  const artifacts = makeDataRegistrationArtifactPipeline({
    authority,
    immutableOriginals,
    pinning: makeFilebaseIpfsPinningAdapter({
      enabled: true,
      token: required(env.FILEBASE_IPFS_TOKEN, "FILEBASE_IPFS_TOKEN"),
      transport: makeFilebaseFetchTransport(),
      limits: {
        max_source_bytes: 64 * 1024 * 1024,
        max_response_bytes: 2 * 1024 * 1024,
        timeout_ms: 120_000,
        pin_convergence_attempts: 8,
        pin_convergence_delay_ms: 5_000,
      },
    }),
    gateway: makeIpfsIoGatewayVerifier(),
    publicOrigin: required(env.DATA_REGISTRATION_PUBLIC_ORIGIN, "DATA_REGISTRATION_PUBLIC_ORIGIN"),
  });
  const signerLayer = makeDataRegistrationStagingSignerLayer({
    privateKey: required(
      env.DATA_REGISTRATION_STAGING_PRIVATE_KEY,
      "DATA_REGISTRATION_STAGING_PRIVATE_KEY",
    ),
    expectedAddress: signerAddress,
    chainId,
    signerNamespace: "data_registration",
  });
  const intentReader = makeDataRegistrationSigningIntentReader();
  const signingService: DataRegistrationSigningService = {
    sign: async (input) => {
      const attempt = await readers.signingReader.getSigningAttempt(input.submissionAttemptId);
      if (attempt === null) throw new Error("DATA signing attempt missing");
      const operationKind =
        attempt.targetAddress.toLowerCase() ===
          DATA_REGISTRATION_AENEID_TARGETS.license.toLowerCase() &&
        attempt.methodSelector === DATA_REGISTRATION_AENEID_SELECTORS.license
          ? "license"
          : attempt.targetAddress.toLowerCase() ===
                DATA_REGISTRATION_AENEID_TARGETS.royalty.toLowerCase() &&
              attempt.methodSelector === DATA_REGISTRATION_AENEID_SELECTORS.royalty
            ? "royalty"
            : null;
      if (operationKind === null) throw new Error("DATA signing policy mismatch");
      const policy: DataRegistrationSigningPolicy = {
        chainId,
        signerNamespace: "data_registration",
        signerAddress,
        targetAddress: DATA_REGISTRATION_AENEID_TARGETS[operationKind],
        methodSelector: DATA_REGISTRATION_AENEID_SELECTORS[operationKind],
        valueWei: 0n,
        maximumDeadlineSeconds: 31 * 24 * 60 * 60,
        maximumGasLimit: gasLimit,
        maximumFeePerGas,
        maximumPriorityFeePerGas,
      };
      const coordinator = makeDataRegistrationSigningCoordinator({
        policy,
        reader: intentReader,
        store,
        now: Date.now,
      });
      return Effect.runPromise(
        coordinator.sign(input).pipe(Effect.provide(signerLayer), Effect.provide(runtime)),
      );
    },
  };

  return {
    queue,
    workflow: {
      store,
      signingReader: readers.signingReader,
      pinReader: readers.pinReader,
      artifacts,
      chain,
      signer: signingService,
      options: { enabled: true },
    },
  };
}

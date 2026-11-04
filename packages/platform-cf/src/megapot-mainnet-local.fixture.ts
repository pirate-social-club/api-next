/** Disposable loopback fixtures only. No operational signer or provider configuration. */
import { type Hex, keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  isMegapotLocalForkClient,
  makeMegapotLocalForkRpcClient,
  megapotLocalForkUrl,
} from "./megapot-local-fork.ts";
import { decodeMegapotMainnetCoreCandidate } from "./megapot-mainnet-core-preflight.ts";
import { encodeMegapotUsdcTransfer, type MegapotV2DeploymentAttestation } from "./megapot-v2.ts";
import type { MegapotV2TransactionSigner } from "./megapot-v2-signer.ts";

const HOLDER = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const REFERRER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

export async function openMainnetLocalFixture() {
  const url = megapotLocalForkUrl(process.env.MEGAPOT_BASE_FORK_RPC_URL ?? "");
  // This resource was handed to this source session; never use preserved8548.
  if (new URL(url).port !== "8549") throw new Error("assigned_mainnet_fork_required");
  const account = privateKeyToAccount(generatePrivateKey());
  const candidate = decodeMegapotMainnetCoreCandidate(
    await Bun.file(
      new URL("../../../infra/megapot/base-mainnet-v2-deployment-candidate.json", import.meta.url),
    ).json(),
  );
  const deployment: MegapotV2DeploymentAttestation = {
    environment: "production",
    chainId: 8453,
    attestationId: "local-mainnet-persisted",
    jackpotAddress: candidate.jackpot_address,
    ticketNftAddress: candidate.ticket_nft_address,
    usdcAddress: candidate.usdc_address,
    custodyAddress: account.address.toLowerCase(),
    referrerAddress: REFERRER,
    jackpotCodeHash: candidate.jackpot_code_hash,
    ticketNftCodeHash: candidate.ticket_nft_code_hash,
    usdcCodeHash: candidate.usdc_code_hash,
    usdcImplementationAddress: candidate.usdc_implementation_address,
    usdcImplementationCodeHash: candidate.usdc_implementation_code_hash,
  };
  let id = 0;
  let sends = 0;
  let signatures = 0;
  let loseAck = false;
  const timedFetch = async (target: string, init?: RequestInit) => {
    if (megapotLocalForkUrl(target) !== url) throw new Error("local_transport_changed");
    const method = (JSON.parse(String(init?.body)) as { method: string }).method;
    const started = performance.now();
    try {
      const response = await fetch(url, {
        ...init,
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (method === "eth_sendRawTransaction") {
        sends += 1;
        if (loseAck) {
          loseAck = false;
          // The real loopback node received the stored bytes; inject only loss
          // of its acknowledgement. No receipt or chain result is fabricated.
          await response.arrayBuffer();
          throw new Error("injected_local_ack_loss");
        }
      }
      return response;
    } finally {
      console.info("local_fixture_method_ms", method, Math.round(performance.now() - started));
    }
  };
  const rpc = async (method: string, params: readonly unknown[], coldRead = false) => {
    if (coldRead && method !== "eth_estimateGas" && method !== "eth_call")
      throw new Error("read_only_cold_probe_required");
    const requestId = ++id;
    const response = await timedFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(coldRead ? 60_000 : 10_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
    });
    const body = (await response.json()) as {
      jsonrpc?: string;
      id?: number;
      result?: unknown;
      error?: unknown;
    };
    if (!response.ok || body.jsonrpc !== "2.0" || body.id !== requestId || body.error !== undefined)
      throw new Error(`local_fixture_rpc_failed:${method}`);
    return body.result;
  };
  const newClient = (attestation: MegapotV2DeploymentAttestation = deployment) =>
    makeMegapotLocalForkRpcClient({ rpcUrl: url, attestation, fetcher: timedFetch });
  const client = await newClient();
  await client.attestDeployment();
  const head = await client.readHead();
  if (
    head.blockNumber !== 51_684_323n ||
    head.blockHash !== "0x970d4d23b2ebd87f4be71feea6fabe0945cccb3a38bb2d78310cb3840b88232f"
  )
    throw new Error("fresh_assigned_fork_required");
  const snapshot = await rpc("evm_snapshot", []);
  const signer: MegapotV2TransactionSigner = {
    address: deployment.custodyAddress,
    sign: async (request) => {
      if (
        !isMegapotLocalForkClient(client, deployment) ||
        request.chainId !== 8453 ||
        request.signerAddress.toLowerCase() !== deployment.custodyAddress ||
        request.nonce < 0n ||
        request.nonce > BigInt(Number.MAX_SAFE_INTEGER)
      )
        throw new Error("test_signer_scope_mismatch");
      signatures += 1;
      const signedTransaction = await account.signTransaction({
        type: "eip1559",
        chainId: 8453,
        nonce: Number(request.nonce),
        to: request.targetAddress as Hex,
        data: request.data,
        value: request.valueWei,
        gas: request.gas,
        maxFeePerGas: request.maxFeePerGas,
        maxPriorityFeePerGas: request.maxPriorityFeePerGas,
      });
      return { signedTransaction, signedTransactionHash: keccak256(signedTransaction) };
    },
  };
  return {
    probeCall:async(to:Hex,data:Hex)=>{
      const requestId=++id;
      const response=await timedFetch(url,{method:"POST",headers:{"content-type":"application/json"},signal:AbortSignal.timeout(10000),body:JSON.stringify({jsonrpc:"2.0",id:requestId,method:"eth_call",params:[{from:account.address,to,data},"latest"]})});
      const body=await response.json() as {jsonrpc?:string;id?:number;result?:unknown;error?:{data?:unknown}};
      if(!response.ok || body.jsonrpc!=="2.0" || body.id!==requestId) throw new Error("local_call_probe_invalid");
      const bytes=body.error===undefined ? body.result : body.error.data;
      if(typeof bytes!=="string" || !/^0x(?:[0-9a-f]{2})*$/i.test(bytes)) throw new Error("local_call_probe_data_missing");
      return {reverted:body.error!==undefined,data:bytes.toLowerCase() as Hex};
    },
    testAccount: account,
    rpc,
    client,
    newClient,
    deployment,
    signer,
    counts: () => ({ sends, signatures }),
    loseNextAcknowledgement: () => {
      loseAck = true;
    },
    setupTransaction: async (data: Hex, to?: Hex, value = 0n) => {
      const fee = await client.readFeeQuote();
      const nonce = await client.readPendingNonce(account.address);
      const signed = await account.signTransaction({
        type: "eip1559",
        chainId: 8453,
        to,
        data,
        value,
        nonce: Number(nonce),
        gas: 12_000_000n,
        maxFeePerGas: fee.maxFeePerGas,
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
      });
      const hash = await client.sendRawTransaction(signed);
      for (let i = 0; i < 20; i += 1) {
        const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as {
          status: string;
          contractAddress: Hex | null;
          logs: readonly { address: Hex; topics: readonly Hex[]; data: Hex }[];
        } | null;
        if (receipt !== null) return { hash, receipt };
        await Bun.sleep(100);
      }
      throw new Error("local_setup_receipt_pending");
    },
    provision: async (amountAtomic: bigint) => {
      await rpc("anvil_setBalance", [deployment.custodyAddress, "0x3635c9adc5dea00000"]);
      if (amountAtomic === 0n) return;
      await rpc("anvil_impersonateAccount", [HOLDER]);
      try {
        await rpc("anvil_setBalance", [HOLDER, "0x3635c9adc5dea00000"]);
        const tx = await rpc("eth_sendTransaction", [
          {
            from: HOLDER,
            to: deployment.usdcAddress,
            gas: "0x30d40",
            data: encodeMegapotUsdcTransfer(deployment.custodyAddress, amountAtomic),
          },
        ]);
        let receipt = await client.readReceipt(String(tx));
        for (let attempt = 0; receipt === null && attempt < 20; attempt += 1) {
          await Bun.sleep(100);
          receipt = await client.readReceipt(String(tx));
        }
        if (receipt?.status !== "success")
          throw new Error(`local_fixture_funding_not_confirmed:${receipt?.status ?? "pending"}`);
      } finally {
        await rpc("anvil_stopImpersonatingAccount", [HOLDER]);
      }
    },
    close: async () => {
      if ((await rpc("evm_revert", [snapshot])) !== true)
        throw new Error("local_snapshot_restore_failed");
      const restored = await client.readHead();
      const pool = (await rpc("txpool_status", [])) as { pending?: string; queued?: string };
      if (
        restored.blockNumber !== 51_684_323n ||
        restored.blockHash !==
          "0x970d4d23b2ebd87f4be71feea6fabe0945cccb3a38bb2d78310cb3840b88232f" ||
        pool.pending !== "0x0" ||
        pool.queued !== "0x0"
      )
        throw new Error("local_fork_restore_not_clean");
    },
  };
}

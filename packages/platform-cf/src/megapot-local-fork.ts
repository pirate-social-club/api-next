import { toFunctionSelector } from "viem";
import {
  type MegapotV2DeploymentAttestation,
  validateMegapotV2DeploymentAttestation,
} from "./megapot-v2.ts";
import { type MegapotV2RpcClient, makeMegapotV2RpcClient } from "./megapot-v2-rpc.ts";

export const MEGAPOT_LOCAL_FORK_BLOCK = 51_684_323;
export const MEGAPOT_LOCAL_FORK_HASH =
  "0x970d4d23b2ebd87f4be71feea6fabe0945cccb3a38bb2d78310cb3840b88232f";

// Only clients constructed here acquire simulation authority. Copying fields,
// adding a flag to an ordinary client, or configuring a mainnet URL cannot do so.
const localClients = new WeakMap<object, MegapotV2DeploymentAttestation>();
const localReaders = new WeakMap<
  object,
  (method: string, params: readonly unknown[]) => Promise<unknown>
>();

/** Separate local-only Safe interpreter intake; callers cannot substitute a transport. */
export async function readMegapotLocalSafeIdentity(
  rpc: object,
  input: { safe: string; module: string; block: bigint; singleton: string },
) {
  const read = localReaders.get(rpc);
  if (read === undefined) throw new Error("megapot_local_fork_capability_required");
  const tag = `0x${input.block.toString(16)}`;
  const [safeCode, moduleCode, singletonCode, singletonSlot, enabled, ...configuration] =
    await Promise.all([
      read("eth_getCode", [input.safe, tag]),
      read("eth_getCode", [input.module, tag]),
      read("eth_getCode", [input.singleton, tag]),
      read("eth_getStorageAt", [input.safe, "0x0", tag]),
      read("eth_call", [
        { to: input.safe, data: `0x2d9ad53d${input.module.slice(2).padStart(64, "0")}` },
        tag,
      ]),
      ...["safeRoot()", "token()", "independentCreditAuthority()", "aggregateCapAtomic()"].map(
        (signature) =>
          read("eth_call", [{ to: input.module, data: toFunctionSelector(signature) }, tag]),
      ),
    ]);
  return {
    safeCode: String(safeCode),
    moduleCode: String(moduleCode),
    singletonCode: String(singletonCode),
    singletonSlot: String(singletonSlot),
    enabled: String(enabled),
    configuration: configuration.map(String),
  };
}
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export function megapotLocalForkUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error("megapot_local_fork_url_required");
  return url.href;
}

/** This is a local simulation capability, never production activation. */
export function isMegapotLocalForkClient(
  rpc: unknown,
  expected?: MegapotV2DeploymentAttestation,
): boolean {
  if (typeof rpc !== "object" || rpc === null) return false;
  const bound = localClients.get(rpc);
  if (bound === undefined) return false;
  if (expected === undefined) return true;
  try {
    const candidate = validateMegapotV2DeploymentAttestation(expected);
    return (Object.keys(bound) as (keyof MegapotV2DeploymentAttestation)[]).every(
      (key) => bound[key] === candidate[key],
    );
  } catch {
    return false;
  }
}

/** No live signer or upstream transport is accepted. All calls stay on loopback. */
export async function makeMegapotLocalForkRpcClient(input: {
  readonly rpcUrl: string;
  readonly attestation: MegapotV2DeploymentAttestation;
  /** Deterministic HTTP-boundary double for unit tests. */
  readonly fetcher?: Fetcher;
}): Promise<MegapotV2RpcClient> {
  const url = megapotLocalForkUrl(input.rpcUrl);
  if (input.attestation.environment !== "production" || input.attestation.chainId !== 8453) {
    throw new Error("megapot_local_fork_chain_required");
  }
  const fetcher: Fetcher = input.fetcher ?? ((target, init) => fetch(target, init));
  let sequence = 0;
  const read = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const id = ++sequence;
    const response = await fetcher(url, {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(2000),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!response.ok) throw new Error("megapot_local_fork_unavailable");
    const body = (await response.json()) as {
      jsonrpc?: string;
      id?: number;
      result?: unknown;
      error?: unknown;
    };
    if (body.jsonrpc !== "2.0" || body.id !== id || body.error !== undefined) {
      throw new Error("megapot_local_fork_invalid_response");
    }
    return body.result;
  };
  const verify = async () => {
    const [info, chain, block] = await Promise.all([
      read("anvil_nodeInfo", []),
      read("eth_chainId", []),
      read("eth_getBlockByNumber", [`0x${MEGAPOT_LOCAL_FORK_BLOCK.toString(16)}`, false]),
    ]);
    const fork = (info as { forkConfig?: { forkBlockNumber?: number; forkUrl?: string } })
      ?.forkConfig;
    if (
      chain !== "0x2105" ||
      fork?.forkBlockNumber !== MEGAPOT_LOCAL_FORK_BLOCK ||
      typeof fork.forkUrl !== "string" ||
      new URL(fork.forkUrl).protocol !== "https:" ||
      (block as { hash?: string })?.hash?.toLowerCase() !== MEGAPOT_LOCAL_FORK_HASH
    )
      throw new Error("megapot_local_fork_identity_changed");
  };
  await verify();
  const client = makeMegapotV2RpcClient({
    rpcUrl: url,
    attestation: input.attestation,
    fetcher: async (target, init) => {
      if (megapotLocalForkUrl(target) !== url)
        throw new Error("megapot_local_fork_transport_changed");
      const request = JSON.parse(String(init?.body)) as { method?: string };
      // Recheck node identity immediately before every transaction, including
      // recovery sends. Redirects cannot move a write to an upstream RPC.
      if (request.method === "eth_sendRawTransaction") await verify();
      return fetcher(url, {
        ...init,
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    },
  });
  const bound = Object.freeze(validateMegapotV2DeploymentAttestation(input.attestation));
  Object.freeze(client.deployment);
  const local: MegapotV2RpcClient = Object.freeze({
    ...client,
    attestDeployment: async () => {
      await verify();
      return client.attestDeployment();
    },
  });
  localClients.set(local, bound);
  localReaders.set(local, read);
  return local;
}

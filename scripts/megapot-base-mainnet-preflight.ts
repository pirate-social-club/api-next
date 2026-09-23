import { readFile } from "node:fs/promises";
import {
  decodeMegapotMainnetCoreCandidate,
  inspectMegapotMainnetCore,
  MegapotMainnetCorePreflightFailed,
  makeMegapotMainnetCoreReader,
} from "../packages/platform-cf/src/megapot-mainnet-core-preflight.ts";

const manifestUrl = new URL(
  "../infra/megapot/base-mainnet-v2-deployment-candidate.json",
  import.meta.url,
);

export async function runMegapotBaseMainnetPreflight(input: {
  readonly firstRpcUrl: string;
  readonly secondRpcUrl: string;
}): Promise<void> {
  const first = new URL(input.firstRpcUrl);
  const second = new URL(input.secondRpcUrl);
  if (first.origin === second.origin) {
    throw new MegapotMainnetCorePreflightFailed("invalid-rpc-url");
  }
  const candidate = decodeMegapotMainnetCoreCandidate(
    JSON.parse(await readFile(manifestUrl, "utf8")) as unknown,
  );
  const proof = await inspectMegapotMainnetCore({
    candidate,
    readers: [
      makeMegapotMainnetCoreReader(input.firstRpcUrl),
      makeMegapotMainnetCoreReader(input.secondRpcUrl),
    ],
  });
  console.log(
    JSON.stringify({
      kind: "megapot-mainnet-core-candidate-verified",
      chain_id: proof.chainId,
      block_number: proof.blockNumber.toString(),
      block_hash: proof.blockHash,
      jackpot_code_hash: proof.jackpotCodeHash,
      ticket_nft_code_hash: proof.ticketNftCodeHash,
      usdc_code_hash: proof.usdcCodeHash,
      usdc_implementation_address: proof.usdcImplementationAddress,
      usdc_implementation_code_hash: proof.usdcImplementationCodeHash,
    }),
  );
}

if (import.meta.main) {
  const firstRpcUrl = process.env.MEGAPOT_MAINNET_RPC_URL_A;
  const secondRpcUrl = process.env.MEGAPOT_MAINNET_RPC_URL_B;
  if (!firstRpcUrl || !secondRpcUrl) {
    console.error("megapot mainnet preflight requires two RPC URLs");
    process.exitCode = 1;
  } else {
    try {
      await runMegapotBaseMainnetPreflight({ firstRpcUrl, secondRpcUrl });
    } catch (error) {
      const reason =
        error instanceof MegapotMainnetCorePreflightFailed ? error.reason : "unavailable";
      console.error(`megapot mainnet preflight failed: ${reason}`);
      process.exitCode = 1;
    }
  }
}

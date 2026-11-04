import { decodeFunctionResult, encodeFunctionData, type Hex, keccak256, parseAbi } from "viem";
import { loadMainnetArtifact } from "./megapot-mainnet-artifacts.fixture.ts";
import type { openMainnetLocalFixture } from "./megapot-mainnet-local.fixture.ts";
import { deployLocalArtifact, readLocalContract } from "./reward-safe-local.fixture.ts";

export async function createControlledMainnet(
  f: Awaited<ReturnType<typeof openMainnetLocalFixture>>,
) {
  const artifact = await loadMainnetArtifact("ControlledMainnetMegapot");
  const jackpot = await deployLocalArtifact(f, artifact, [
    f.deployment.usdcAddress,
    f.testAccount.address,
    10000n,
    100000000000000000n,
  ]);
  const nft = (await readLocalContract(f, jackpot, artifact.abi, "jackpotNFT")) as Hex;
  const deployment = {
    ...f.deployment,
    attestationId: "local-controlled-mainnet-v1",
    jackpotAddress: jackpot,
    ticketNftAddress: nft.toLowerCase(),
    jackpotCodeHash: keccak256((await f.rpc("eth_getCode", [jackpot, "latest"])) as Hex),
    ticketNftCodeHash: keccak256((await f.rpc("eth_getCode", [nft, "latest"])) as Hex),
  };
  return {
    deployment,
    client: await f.newClient(deployment),
    artifact,
    arm: async (at: bigint, gross: bigint, losing: boolean) =>
      f.setupTransaction(
        encodeFunctionData({
          abi: artifact.abi,
          functionName: "armDrawingWithOutcome",
          args: [at, gross, losing],
        }),
        jackpot,
      ),
    settle: async (drawing: bigint, ticket: bigint) =>
      f.setupTransaction(
        encodeFunctionData({
          abi: artifact.abi,
          functionName: "settlePurchasedDrawing",
          args: [drawing, ticket],
        }),
        jackpot,
      ),
    readOwner: async (ticket: bigint) =>
      String(
        decodeFunctionResult({
          abi: parseAbi(["function ownerOf(uint256) view returns(address)"]),
          functionName: "ownerOf",
          data: (await f.rpc("eth_call", [
            {
              to: nft,
              data: encodeFunctionData({
                abi: parseAbi(["function ownerOf(uint256) view returns(address)"]),
                functionName: "ownerOf",
                args: [ticket],
              }),
            },
            "latest",
          ])) as Hex,
        }),
      ).toLowerCase(),
  };
}

import { createHash } from "node:crypto";
import type { Abi, Hex } from "viem";

const artifacts = {
  AdversarialCreditToken:[
    "mainnet-foundry/out/AdversarialCreditToken.sol/AdversarialCreditToken.json",
    "3fb9b5a5d8c02d7adb59801d165e93335daeed98e4cd74a5bcebec6a98500673",
  ],
  ControlledMainnetMegapot: [
    "mainnet-foundry/out/ControlledMainnetMegapot.sol/ControlledMainnetMegapot.json",
    "a2f38881b779f95acef31eea3dc5cc0f3b888d7b00ac8fe424bc076569c043e2",
  ],
  RewardCreditSettlement: [
    "mainnet-foundry/out/RewardCreditSettlement.sol/RewardCreditSettlement.json",
    "6da06720bd97ea78116ac751f47af511cfe7fe6271b6dff9d6494ce25c7690b6",
  ],
  LocalToken: [
    "mainnet-foundry/out/RewardCreditSettlement.t.sol/LocalToken.json",
    "18ab6fa83ea91e4f82c8bd3f1b3922008e093ea500b6a434bcbc6e29d107bc48",
  ],
  Safe: [
    "artifact-intake/safe-1.4.1/Safe.json",
    "c36a5e99bc3f25c2d75ac5f7920b679200b3ce617c0d26e674b1321dbc6b0bdf",
  ],
  SafeL2: [
    "artifact-intake/safe-1.4.1/SafeL2.json",
    "a57d54c0d757ca7fb86693480797de69c880878690b67061f6f9624e11def8bd",
  ],
  SafeProxyFactory: [
    "artifact-intake/safe-1.4.1/SafeProxyFactory.json",
    "f77ccb60e95345e6583216e82feb5430098679d62aa4aeda7388df3831476997",
  ],
} as const;

/** Exact parent-compiled/released local-test inputs; no serving runtime import. */
export async function loadMainnetArtifact(name: keyof typeof artifacts) {
  const [path, expected] = artifacts[name];
  const bytes = await Bun.file(
    new URL(`../../../.wrangler/rewards-source-agent/${path}`, import.meta.url),
  ).bytes();
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error("local_artifact_hash_mismatch");
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
    abi: Abi;
    bytecode: Hex | { object: Hex };
  };
  return {
    abi: parsed.abi,
    bytecode: typeof parsed.bytecode === "string" ? parsed.bytecode : parsed.bytecode.object,
  };
}

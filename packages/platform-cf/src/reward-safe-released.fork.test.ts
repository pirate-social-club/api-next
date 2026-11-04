import { expect, test } from "bun:test";
import {
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  keccak256,
  parseAbiParameters,
  toBytes,
} from "viem";
import { readMegapotFinalizedHead } from "./megapot-finality.ts";
import { loadMainnetArtifact } from "./megapot-mainnet-artifacts.fixture.ts";
import { openMainnetLocalFixture } from "./megapot-mainnet-local.fixture.ts";
import { encodeMegapotUsdcTransfer } from "./megapot-v2.ts";
import {
  encodeRewardSafeSettlementV1,
  rewardSafeCreditDigestV1,
  rewardSafeTypedDataV1,
  validateRewardSafeReceiptV1,
  verifyRewardSafeAuthorizationV1,
} from "./reward-safe-credit-v1.ts";
import {
  createLocalSafeSettlement,
  deployLocalArtifact,
  readLocalContract,
} from "./reward-safe-local.fixture.ts";

const forkTest = process.env.MEGAPOT_LOCAL_PERSISTENCE_TEST === "1" ? test : test.skip;
forkTest(
  "released Safe1.4.1 executes independently signed module credits and preserves admission, domain, cap and rollback boundaries",
  async () => {
    const f = await openMainnetLocalFixture();
    try {
      await f.provision(0n);
      const tokenArtifact = await loadMainnetArtifact("LocalToken");
      const token = await deployLocalArtifact(f, tokenArtifact, []);
      const setup = await createLocalSafeSettlement(f, 1000n, token);
      const recipient = "0x0000000000000000000000000000000000000b0b" as Hex;
      await f.setupTransaction(
        encodeFunctionData({
          abi: tokenArtifact.abi,
          functionName: "mint",
          args: [setup.safe, 2000n],
        }),
        token,
      );
      const head = await f.client.readHead();
      if (head.blockTimestamp === undefined) throw new Error("fork_clock_missing");
      const credit = {
        creditId: keccak256(toBytes("released-safe-credit")),
        safeRoot: setup.safe,
        token,
        recipient,
        amount: 600n,
        validUntil: head.blockTimestamp + 3600n,
        module: setup.module,
      };
      // Independent vector: encode both EIP712 hashes directly, without the
      // contract digest or the typed-data helper as the source of expected truth.
      const domain = keccak256(
        encodeAbiParameters(parseAbiParameters("bytes32,bytes32,bytes32,uint256,address"), [
          keccak256(
            toBytes(
              "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
            ),
          ),
          keccak256(toBytes("Pirate Reward Credit")),
          keccak256(toBytes("1")),
          8453n,
          setup.module,
        ]),
      );
      const body = keccak256(
        encodeAbiParameters(
          parseAbiParameters("bytes32,bytes32,address,address,address,uint256,uint256"),
          [
            keccak256(
              toBytes(
                "RewardCredit(bytes32 creditId,address safeRoot,address token,address recipient,uint256 amount,uint256 validUntil)",
              ),
            ),
            credit.creditId,
            setup.safe,
            token,
            recipient,
            600n,
            credit.validUntil,
          ],
        ),
      );
      expect(rewardSafeCreditDigestV1(credit)).toBe(
        keccak256(`0x1901${domain.slice(2)}${body.slice(2)}`),
      );
      expect(
        await readLocalContract(f, setup.module, setup.moduleAbi, "creditDigest", [
          credit.creditId,
          recipient,
          600n,
          credit.validUntil,
        ]),
      ).toBe(rewardSafeCreditDigestV1(credit));
      const signature = await setup.issuer.signTypedData(rewardSafeTypedDataV1(credit));
      await verifyRewardSafeAuthorizationV1(credit, signature, setup.issuer.address);
      const calldata = encodeRewardSafeSettlementV1(credit, signature);
      expect(await setup.enabled()).toBe(false);
      expect((await f.setupTransaction(calldata, setup.module)).receipt.status).toBe("0x0");
      expect(
        await readLocalContract(f, setup.module, setup.moduleAbi, "consumed", [credit.creditId]),
      ).toBe(false);
      await setup.enable();
      expect(await setup.enabled()).toBe(true);
      for (const changed of [
        { ...credit, amount: 601n },
        { ...credit, recipient: setup.safe },
        { ...credit, creditId: keccak256(toBytes("other")) },
        { ...credit, validUntil: credit.validUntil + 1n },
      ]) {
        expect(
          (await f.setupTransaction(encodeRewardSafeSettlementV1(changed, signature), setup.module))
            .receipt.status,
        ).toBe("0x0");
      }
      const paid = await f.setupTransaction(calldata, setup.module);
      expect(paid.receipt.status).toBe("0x1");
      const receipt = await f.client.readReceipt(paid.hash);
      if (receipt === null) throw new Error("actual_safe_receipt_missing");
      expect(receipt.from).toBe(f.testAccount.address.toLowerCase());
      expect(receipt.to).toBe(setup.module);
      expect(await readLocalContract(f, token, tokenArtifact.abi, "balanceOf", [setup.safe])).toBe(
        1400n,
      );
      expect(await readLocalContract(f, token, tokenArtifact.abi, "balanceOf", [recipient])).toBe(
        600n,
      );
      expect((await f.setupTransaction(calldata, setup.module)).receipt.status).toBe("0x0");
      const second = { ...credit, creditId: keccak256(toBytes("second")), amount: 401n };
      const secondSignature = await setup.issuer.signTypedData(rewardSafeTypedDataV1(second));
      expect(
        (
          await f.setupTransaction(
            encodeRewardSafeSettlementV1(second, secondSignature),
            setup.module,
          )
        ).receipt.status,
      ).toBe("0x0");
      const finalCredit = { ...second, amount: 400n };
      const finalSignature = await setup.issuer.signTypedData(rewardSafeTypedDataV1(finalCredit));
      await f.setupTransaction(
        encodeFunctionData({ abi: tokenArtifact.abi, functionName: "setFail", args: [true] }),
        token,
      );
      expect(
        (
          await f.setupTransaction(
            encodeRewardSafeSettlementV1(finalCredit, finalSignature),
            setup.module,
          )
        ).receipt.status,
      ).toBe("0x0");
      expect(await readLocalContract(f, setup.module, setup.moduleAbi, "spentAtomic")).toBe(600n);
      expect(
        await readLocalContract(f, setup.module, setup.moduleAbi, "consumed", [
          finalCredit.creditId,
        ]),
      ).toBe(false);
      await f.setupTransaction(
        encodeFunctionData({ abi: tokenArtifact.abi, functionName: "setFail", args: [false] }),
        token,
      );
      await setup.disable();
      expect(await setup.enabled()).toBe(false);
      expect(
        (
          await f.setupTransaction(
            encodeRewardSafeSettlementV1(finalCredit, finalSignature),
            setup.module,
          )
        ).receipt.status,
      ).toBe("0x0");
      await setup.enable();
      expect(
        (
          await f.setupTransaction(
            encodeRewardSafeSettlementV1(finalCredit, finalSignature),
            setup.module,
          )
        ).receipt.status,
      ).toBe("0x1");
      expect(await readLocalContract(f, setup.module, setup.moduleAbi, "spentAtomic")).toBe(1000n);
      expect(await readLocalContract(f, token, tokenArtifact.abi, "balanceOf", [recipient])).toBe(
        1000n,
      );
    } finally {
      await f.close();
    }
  },
  180_000,
);

forkTest(
  "released Safe settles actual Circle USDC with canonical finalized outer and inner evidence",
  async () => {
    const f = await openMainnetLocalFixture();
    try {
      await f.provision(5000n);
      const setup = await createLocalSafeSettlement(f, 1000n);
      expect(await setup.enabled()).toBe(false);
      await setup.enable();
      expect(await setup.enabled()).toBe(true);
      await f.setupTransaction(encodeMegapotUsdcTransfer(setup.safe, 2000n), setup.token);
      const recipient = "0x0000000000000000000000000000000000000b0b" as Hex;
      const head = await f.client.readHead();
      if (head.blockTimestamp === undefined) throw new Error("fork_clock_missing");
      const credit = {
        creditId: keccak256(toBytes("released-safe-circle-credit")),
        safeRoot: setup.safe,
        token: setup.token,
        recipient,
        amount: 600n,
        validUntil: head.blockTimestamp + 3600n,
        module: setup.module,
      };
      const signature = await setup.issuer.signTypedData(rewardSafeTypedDataV1(credit));
      const before = await f.client.readUsdcBalance(setup.safe);
      const recipientBefore = await f.client.readUsdcBalance(recipient);
      const result = await f.setupTransaction(
        encodeRewardSafeSettlementV1(credit, signature),
        setup.module,
      );
      expect(result.receipt.status).toBe("0x1");
      const receipt = await f.client.readReceipt(result.hash);
      if (receipt === null) throw new Error("actual_safe_receipt_missing");
      await f.rpc("anvil_mine", ["0x80"]);
      const finalized = await readMegapotFinalizedHead(f.client);
      expect(finalized.blockNumber >= receipt.blockNumber).toBe(true);
      expect((await f.client.readBlock(receipt.blockNumber)).blockHash).toBe(receipt.blockHash);
      const evidence = validateRewardSafeReceiptV1({
        credit,
        relayer: f.testAccount.address,
        transactionHash: result.hash,
        receipt,
      });
      expect(evidence.moduleLogIndex !== evidence.transferLogIndex).toBe(true);
      expect(before - (await f.client.readUsdcBalance(setup.safe))).toBe(600n);
      expect((await f.client.readUsdcBalance(recipient)) - recipientBefore).toBe(600n);
      for (const changed of [
        { ...credit, amount: 601n },
        { ...credit, token: f.deployment.jackpotAddress as Hex },
        { ...credit, safeRoot: f.testAccount.address },
      ]) {
        expect(() =>
          validateRewardSafeReceiptV1({
            credit: changed,
            relayer: f.testAccount.address,
            transactionHash: result.hash,
            receipt,
          }),
        ).toThrow();
      }
    } finally {
      await f.close();
    }
  },
  180_000,
);

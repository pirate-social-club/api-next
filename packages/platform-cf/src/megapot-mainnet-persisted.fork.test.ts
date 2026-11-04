import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { keccak256, toBytes } from "viem";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import {
  deriveMegapotApprovalEffectId,
  makeMegapotApprovalCoordinator,
} from "./megapot-approval-coordinator.ts";
import { makeControlPlaneMegapotApprovalStore } from "./megapot-approval-repository.ts";
import { MEGAPOT_LOCAL_FORK_BLOCK, MEGAPOT_LOCAL_FORK_HASH } from "./megapot-local-fork.ts";
import { openMainnetLocalFixture } from "./megapot-mainnet-local.fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneRewardRunAuthority } from "./reward-operations-control.ts";

const enabled = process.env.MEGAPOT_LOCAL_PERSISTENCE_TEST === "1";
const localTest = enabled ? test : test.skip;

localTest(
  "mainnet approval survives rejected signer and lost broadcast acknowledgement in PostgreSQL and the actual local fork",
  async () => {
    const url = new URL(process.env.CONTROL_PLANE_POSTGRES_TEST_URL ?? "");
    if (
      url.hostname !== "127.0.0.1" ||
      url.port !== "54387" ||
      url.pathname !== "/rewards_source_test"
    )
      throw new Error("assigned_disposable_postgres_required");
    const schema = `rewards_mainnet_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString: url.href });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(url);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    let acquired: Awaited<ReturnType<typeof openMainnetLocalFixture>> | undefined;
    try {
      const fixture = await openMainnetLocalFixture();
      acquired = fixture;
      await applyPostgresTestBaselineConnection({
        connectionString: scoped.href,
        rewardsRunning: true,
      });
      await admin.query(`SET search_path TO "${schema}"`);
      const d = fixture.deployment;
      await admin.query(
        `INSERT INTO megapot_deployment_attestations (
      attestation_id,environment,chain_id,jackpot_address,usdc_address,ticket_nft_address,
      custody_address,referrer_address,source_tag,jackpot_code_hash,usdc_code_hash,ticket_nft_code_hash,
      usdc_implementation_address,usdc_implementation_code_hash,attestation_block_number,
      attestation_block_hash,abi_version,status,verified_at
    ) VALUES ($1,'production',8453,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'megapot_v2','active',clock_timestamp())`,
        [
          d.attestationId,
          d.jackpotAddress,
          d.usdcAddress,
          d.ticketNftAddress,
          d.custodyAddress,
          d.referrerAddress,
          keccak256(toBytes("local-mainnet-persisted")),
          d.jackpotCodeHash,
          d.usdcCodeHash,
          d.ticketNftCodeHash,
          d.usdcImplementationAddress,
          d.usdcImplementationCodeHash,
          MEGAPOT_LOCAL_FORK_BLOCK,
          MEGAPOT_LOCAL_FORK_HASH,
        ],
      );
      await fixture.provision(0n);
      const layer = makeDirectPostgresControlPlaneLayer(scoped.href);
      const make = async (rejectSigner: boolean) =>
        makeMegapotApprovalCoordinator({
          store: makeControlPlaneMegapotApprovalStore(layer),
          rpc: await fixture.newClient(),
          signer: rejectSigner
            ? {
                address: d.custodyAddress,
                sign: async () => {
                  throw new Error("injected_test_signer_rejection");
                },
              }
            : fixture.signer,
          authority: makeControlPlaneRewardRunAuthority(layer),
          requiredConfirmations: 1,
          gasLimitMultiplierBps: 12_000,
          nativeGasReserveFloorWei: 0n,
        });
      const command = {
        attestationId: d.attestationId,
        minimumAllowanceAtomic: 2_000_000n,
        approvedAmountAtomic: 2_000_000n,
      };
      const effectId = deriveMegapotApprovalEffectId(d.attestationId, command.approvedAmountAtomic);
      await expect(Effect.runPromise((await make(true)).approve(command))).rejects.toMatchObject({
        reason: "signer_mismatch",
      });
      const store = makeControlPlaneMegapotApprovalStore(layer);
      expect(await Effect.runPromise(store.findProgress(effectId))).toMatchObject({
        state: "nonce_reserved",
        reservation: { nonce: 0n, chainId: 8453 },
      });
      fixture.loseNextAcknowledgement();
      expect(await Effect.runPromise((await make(false)).reconcile(effectId))).toMatchObject({
        kind: "reconciliation_required",
      });
      const persisted = await Effect.runPromise(store.findProgress(effectId));
      expect(persisted).toMatchObject({ state: "reconciliation_required", nonce: 0n });
      if (persisted === null || !("signedTransaction" in persisted))
        throw new Error("stored bytes missing");
      expect(persisted.signedTransactionHash).toBe(
        keccak256(persisted.signedTransaction as `0x${string}`),
      );
      const restarted = await make(false);
      expect(await Effect.runPromise(restarted.reconcile(effectId))).toMatchObject({
        kind: "submitted",
      });
      // Real Anvil finalized-tag progression: an included receipt alone cannot
      // confirm the journal. Mine local blocks, never replace the RPC result.
      await fixture.rpc("anvil_mine", ["0x80"]);
      const result = await Effect.runPromise(restarted.reconcile(effectId));
      expect(result).toMatchObject({ kind: "confirmed", approvedAmountAtomic: 2_000_000n });
      expect(await Effect.runPromise(restarted.reconcile(effectId))).toEqual(result);
      expect(await Effect.runPromise(restarted.approve(command))).toEqual(result);
      expect(fixture.counts()).toEqual({ sends: 1, signatures: 1 });
      expect(await fixture.client.readUsdcAllowance(d.custodyAddress, d.jackpotAddress)).toBe(
        2_000_000n,
      );
      expect((await admin.query("SELECT next_nonce::text FROM reward_signer_nonces")).rows).toEqual(
        [{ next_nonce: "1" }],
      );
      expect(
        (await admin.query("SELECT count(*)::int AS effects FROM reward_chain_effects")).rows,
      ).toEqual([{ effects: 1 }]);
    } finally {
      try {
        await acquired?.close();
      } finally {
        await admin.query("SET search_path TO public");
        try {
          await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await admin.end();
        }
      }
    }
  },
  120_000,
);

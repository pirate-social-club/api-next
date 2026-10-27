import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneDb, type ControlPlaneStatement } from "@pirate/application";
import { deriveMegapotTicket } from "@pirate/domain";
import { Effect, Layer } from "effect";
import { Client } from "pg";
import { hexToBytes } from "viem";
import { exportSafePoolCalls } from "../../../scripts/safe-pool-export-calls.ts";
import { withDanceServingPermissionFixture } from "./dance-serving-permissions.pg-fixture.ts";
import { deriveMegapotPurchaseEffectId } from "./megapot-purchase-coordinator.ts";
import {
  encodeMegapotBuyTickets,
  MEGAPOT_REFERRAL_SPLIT_SCALE,
  type MegapotV2DeploymentAttestation,
  megapotKeccak256,
} from "./megapot-v2.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { fakeSafeChain } from "./reward-safe-chain.pg-fixture.ts";
import { makeRewardSafePurchaseCoordinator } from "./reward-safe-purchase-coordinator.ts";
import { makeControlPlaneRewardSafePurchaseStore } from "./reward-safe-purchase-repository.ts";
import { makeReleaseRuntimeLogin } from "./reward-safe-runtime-role.pg-fixture.ts";
import { sha256Hex } from "./reward-safe-settlement.ts";
import { loadFrozenSharedSongDrawing } from "./shared-song-frozen-plan.ts";
import { verifyPreparedSafeCall } from "./shared-song-prepared-purchase.ts";
import { proveProspectiveSongFunding } from "./song-funding-prospective.pg-proof.ts";
import { seedSongContributionFixture } from "./song-megapot-contribution.pg-fixture.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const pgTest = url ? test : test.skip;
const h = `0x${"a".repeat(64)}`;
const custody = `0x${"33".repeat(20)}`;

pgTest(
  "shared-song purchases bind the original real contribution and roll back every drift refusal",
  async () => {
    if (!url) throw Error("Disposable PostgreSQL URL required");
    await withDanceServingPermissionFixture(url, async (f) => {
      const http = await f.makeRole(),
        jobs = await f.makeRole();
      await f.owner.query(
        "SELECT bind_reward_contribution_purpose_v2($1,'http_commands'),grant_shared_song_funding_runtime_v2($1,'account')",
        [http.role],
      );
      await f.owner.query(
        "SELECT bind_reward_contribution_purpose_v2($1,'incoming_observer'),grant_shared_song_funding_runtime_v2($1,'context_worker')",
        [jobs.role],
      );
      await f.owner.query(
        `GRANT EXECUTE ON FUNCTION require_reward_run_authority_v1() TO ${f.quote(jobs.role)}`,
      );
      await f.admin.query(`SET search_path TO ${f.quote(f.schema)},pg_catalog`);
      await seedSongContributionFixture(f.admin);
      await f.admin.query(
        `INSERT INTO reward_signer_nonces(chain_id,signer_address,next_nonce,observed_pending_nonce,observed_block_number,observed_block_hash,observed_at,nonce_authority)
      VALUES(84532,$1,0,0,1,$2,clock_timestamp(),'safe_owner_v1')`,
        [custody, h],
      );
      const funded = await proveProspectiveSongFunding({
        admin: f.admin,
        owner: f.owner,
        http: http.url,
        jobs: jobs.url,
      });
      const legId = funded.receipt.target.pool_leg_id;
      const row = funded.context.schedule.rows[0];
      if (!row) throw Error("Original planned drawing required");
      const drawId = BigInt(row.drawing_id),
        originalTime = BigInt(Date.parse(row.drawing_time) / 1000);
      const deployment: MegapotV2DeploymentAttestation = {
        attestationId: "attestation",
        environment: "test",
        chainId: 84532,
        jackpotAddress: `0x${"55".repeat(20)}`,
        ticketNftAddress: `0x${"66".repeat(20)}`,
        usdcAddress: `0x${"22".repeat(20)}`,
        custodyAddress: custody,
        referrerAddress: `0x${"77".repeat(20)}`,
        jackpotCodeHash: h,
        ticketNftCodeHash: h,
        usdcCodeHash: h,
      };
      const observation = async (id: string, time: bigint, price: bigint, age = 0) =>
        f.admin.query(
          `
      INSERT INTO megapot_drawing_observations(observation_id,attestation_id,chain_id,drawing_id,
        ticket_price_atomic,drawing_time,ball_max,bonusball_max,drawing_locked,referral_fee_wei,
        referral_win_share_wei,block_number,block_hash,block_timestamp,confirmations,observed_at,expires_at,raw_state_hash)
      VALUES($1,'attestation',84532,$2,$3,to_timestamp($4::double precision),30,10,false,0,0,995,$5,
        clock_timestamp()-make_interval(secs=>$6),3,clock_timestamp()-make_interval(secs=>$6),clock_timestamp()+interval '1 hour',$7)`,
          [
            id,
            drawId.toString(),
            price.toString(),
            time.toString(),
            id === "frozen-good" ? h : `0x${"b".repeat(64)}`,
            age,
            "a".repeat(64),
          ],
        );
      await observation("frozen-good", originalTime, 1_000_000n);
      await observation("frozen-drift", originalTime - 1n, 999_999n, 60);
      const runtime = await makeReleaseRuntimeLogin(f.admin, url, f.schema);
      try {
        const layer = makeDirectPostgresControlPlaneLayer(runtime.url);
        const original = await Effect.runPromise(
          Effect.gen(function* () {
            return yield* loadFrozenSharedSongDrawing(yield* ControlPlaneDb, legId, drawId);
          }).pipe(Effect.provide(layer)),
        );
        expect(original?.drawingTimeMs).toBe(Number(originalTime) * 1000);
        const denied = new Client({ connectionString: runtime.url });
        await denied.connect();
        try {
          await expect(
            denied.query("SELECT * FROM reward_funding_leg_snapshots_v2"),
          ).rejects.toMatchObject({ code: "42501" });
        } finally {
          await denied.end();
        }
        let currentId = drawId,
          time = originalTime,
          price = 1_000_000n,
          drift = false,
          age = 0;
        const base = fakeSafeChain().rpc;
        const pinnedSeconds = BigInt(Math.floor(Date.now() / 1000));
        const head = () => ({
          blockNumber: 1000n,
          blockHash: h,
          blockTimestamp: pinnedSeconds - BigInt(age),
        });
        const rpc = {
          ...base,
          deployment,
          attestDeploymentAt: async (block: bigint) => {
            expect(block).toBe(1000n);
          },
          readHead: async () => head(),
          readBlock: async (blockNumber: bigint) => ({
            ...head(),
            blockNumber,
            blockHash: drift ? `0x${"b".repeat(64)}` : h,
          }),
          readCurrentDrawingId: async (block?: bigint) => {
            expect(block).toBe(1000n);
            return currentId;
          },
          readDrawing: async () => ({
            ...(await base.readDrawing(drawId)),
            drawingTime: time,
            ticketPrice: price,
          }),
        };
        const options = {
          layer,
          rpc,
          runtimeEnvironment: "development" as const,
          productionEnabled: false,
          requiredConfirmations: 3,
          maximumScanBlocks: 200,
          maximumScanLogs: 50,
          minimumEntrySeconds: 600,
        };
        const counts = async () =>
          (
            await f.owner.query(
              `SELECT
        (SELECT count(*) FROM reward_chain_effects WHERE execution_mode='safe_owner_v1')::int effects,
        (SELECT count(*) FROM megapot_pool_drawings WHERE pool_leg_id=$1)::int drawings,
        (SELECT reserved_atomic::text FROM song_reward_offer_legs WHERE leg_id=$1) reserved`,
              [legId],
            )
          ).rows[0];
        const before = await counts();
        for (const mutation of [
          "id",
          "early",
          "late",
          "cheaper",
          "dearer",
          "reorg",
          "stale",
        ] as const) {
          currentId = mutation === "id" ? drawId + 1n : drawId;
          time = originalTime + (mutation === "early" ? -1n : mutation === "late" ? 1n : 0n);
          price = 1_000_000n + (mutation === "cheaper" ? -1n : mutation === "dearer" ? 1n : 0n);
          drift = mutation === "reorg";
          age = mutation === "stale" ? 121 : 0;
          const attempt = Effect.runPromise(
            makeRewardSafePurchaseCoordinator(options).prepare(legId),
          );
          if (drift || age)
            await expect(attempt).rejects.toMatchObject({ _tag: "RewardSafeSettlementFailed" });
          else expect(await attempt).toEqual({ kind: "drawing_changed" });
          expect(await counts()).toEqual(before);
        }
        currentId = drawId;
        time = originalTime;
        price = 1_000_000n;
        drift = false;
        age = 0;
        // A hostile/raw insertion that substitutes a different observation must
        // still fail at the SQL guard and roll back its already-created effect.
        const substituted = Layer.effect(
          ControlPlaneDb,
          Effect.gen(function* () {
            const db = yield* ControlPlaneDb;
            return ControlPlaneDb.of({
              ...db,
              withTransaction: (use) =>
                db.withTransaction((tx) =>
                  use({
                    ...tx,
                    execute: <Row>(s: ControlPlaneStatement) =>
                      tx.execute<Row>(
                        s.label === "reward-safe-purchase.drawing.create"
                          ? { ...s, values: [s.values[0], "frozen-drift", ...s.values.slice(2)] }
                          : s,
                      ),
                  }),
                ),
            });
          }),
        ).pipe(Layer.provide(layer));
        await expect(
          Effect.runPromise(
            makeRewardSafePurchaseCoordinator({ ...options, layer: substituted }).prepare(legId),
          ),
        ).rejects.toMatchObject({ _tag: "RewardSafePurchaseStoreFailed" });
        expect(await counts()).toEqual(before);
        // A real row-lock wait must not consume the scan window and then allow
        // effects to be written. The direct store receives a valid heavy-scan budget.
        const store = makeControlPlaneRewardSafePurchaseStore();
        const candidate = await Effect.runPromise(
          store.loadCandidate({ legId, minimumEntrySeconds: 600 }).pipe(Effect.provide(layer)),
        );
        if (candidate === null) throw Error("Expected valid locked candidate");
        const effectId = deriveMegapotPurchaseEffectId(legId, drawId);
        const ticket = deriveMegapotTicket({
          effectId,
          drawingId: drawId,
          ticketIndex: 0,
          ballMax: 30,
          bonusballMax: 10,
          keccak256: megapotKeccak256,
        });
        const calldata = encodeMegapotBuyTickets({
          tickets: [ticket],
          recipient: custody,
          referrers: [deployment.referrerAddress],
          referralSplit: [MEGAPOT_REFERRAL_SPLIT_SCALE],
          source: h,
        });
        await f.owner.query(
          "INSERT INTO reward_safe_execution_cursors(chain_id,safe_address,next_block_number) VALUES(84532,$1,1000)",
          [custody],
        );
        const locker = new Client({ connectionString: url });
        await locker.connect();
        try {
          await locker.query(`SET search_path TO ${f.quote(f.schema)},pg_catalog`);
          await locker.query("BEGIN");
          await locker.query(
            "SELECT 1 FROM reward_safe_execution_cursors WHERE chain_id=84532 AND safe_address=$1 FOR UPDATE",
            [custody],
          );
          const pending = Effect.runPromise(
            store
              .prepare({
                effectId,
                candidate,
                ticket,
                calldata,
                calldataHash: await sha256Hex(hexToBytes(calldata)),
                headBlockNumber: 1000n,
                minimumEntrySeconds: 600,
                scanAllowanceMs: candidate.purchaseDeadlineAtMs - Date.now() - 2000,
              })
              .pipe(Effect.provide(layer)),
          ).then(
            (value) => ({ kind: "returned" as const, value }),
            (error) => ({ kind: "failed" as const, error }),
          );
          let waiting = false;
          for (let attempt = 0; attempt < 40; attempt++) {
            const state = (
              await f.admin.query(
                "SELECT count(*)::int n FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'",
                [runtime.role],
              )
            ).rows[0];
            if (state.n > 0) {
              waiting = true;
              break;
            }
            await Bun.sleep(25);
          }
          expect(waiting).toBe(true);
          await Bun.sleep(2500);
          await locker.query("COMMIT");
          const stopped = await pending;
          expect(stopped.kind).toBe("failed");
          if (stopped.kind === "failed")
            expect(stopped.error).toMatchObject({ _tag: "RewardSafePurchaseStoreFailed" });
          expect(await counts()).toEqual(before);
        } finally {
          await locker.query("ROLLBACK");
          await locker.end();
        }
        const prepared = await Effect.runPromise(
          makeRewardSafePurchaseCoordinator(options).prepare(legId),
        );
        expect(prepared).toMatchObject({ kind: "prepared", drawingId: drawId });
        expect((await counts()).drawings).toBe(1);
        if (prepared.kind !== "prepared") throw Error("Expected prepared call");
        const call = { effectId: prepared.effectId, to: deployment.jackpotAddress, data: calldata };
        const check = (overrides: Partial<Parameters<typeof verifyPreparedSafeCall>[0]> = {}) =>
          Effect.runPromise(
            verifyPreparedSafeCall({
              attestationId: "attestation",
              call,
              rpcFor: () => rpc,
              minimumEntrySeconds: 600,
              ...overrides,
            }).pipe(Effect.provide(layer)),
          );
        expect(await check()).toEqual({ executeBeforeMs: candidate.purchaseDeadlineAtMs });
        expect(await check({ call: { ...call, data: "0x" } })).toBeNull();
        expect(await check({ rpcFor: undefined })).toBeNull();
        currentId = drawId + 1n;
        expect(await check()).toBeNull();
        currentId = drawId;
        const deadline = candidate.purchaseDeadlineAtMs;
        const lateHead = {
          blockNumber: 2000n,
          blockHash: `0x${"c".repeat(64)}`,
          blockTimestamp: BigInt(deadline / 1000),
        };
        const lateRpc = {
          ...rpc,
          attestDeploymentAt: async () => {},
          readCurrentDrawingId: async () => drawId,
          readHead: async () => lateHead,
          readBlock: async () => lateHead,
        };
        expect(await check({ rpcFor: () => lateRpc, now: () => deadline })).toBeNull();
        const directory = await mkdtemp(join(tmpdir(), "shared-frozen-export-"));
        try {
          const files = await exportSafePoolCalls({
            attestationId: "attestation",
            outDirectory: join(directory, "valid"),
            layer,
            rpcFor: () => rpc,
            minimumEntrySeconds: 600,
          });
          expect(files).toHaveLength(1);
          await expect(
            exportSafePoolCalls({
              attestationId: "attestation",
              outDirectory: join(directory, "missing-proof"),
              layer,
            }),
          ).rejects.toMatchObject({ reason: "prepared_call_not_current" });
          await expect(
            exportSafePoolCalls({
              attestationId: "attestation",
              outDirectory: join(directory, "expired"),
              layer,
              rpcFor: () => lateRpc,
              minimumEntrySeconds: 600,
              now: () => deadline,
            }),
          ).rejects.toMatchObject({ reason: "prepared_call_not_current" });
          let heldDuringRpc = false;
          const holdingRpc = {
            ...rpc,
            readCurrentDrawingId: async () => {
              await Effect.runPromise(
                store
                  .holdDrawing({ effectId: prepared.effectId, reason: "fixture_operational_hold" })
                  .pipe(Effect.provide(layer)),
              );
              heldDuringRpc = true;
              return drawId;
            },
          };
          expect(await check({ rpcFor: () => holdingRpc })).toBeNull();
          expect(heldDuringRpc).toBe(true);
          expect(
            (
              await f.owner.query("SELECT state FROM reward_chain_effects WHERE effect_id=$1", [
                prepared.effectId,
              ])
            ).rows[0].state,
          ).toBe("prepared");
          expect(await check()).toBeNull();
          await expect(
            exportSafePoolCalls({
              attestationId: "attestation",
              outDirectory: join(directory, "held"),
              layer,
              rpcFor: () => rpc,
              minimumEntrySeconds: 600,
            }),
          ).rejects.toMatchObject({ reason: "prepared_call_not_current" });
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
        expect((await counts()).drawings).toBe(1);
      } finally {
        await runtime.drop();
      }
    });
  },
  60000,
);

pgTest(
  "frozen-plan migration strips hostile defaults and grants only its explicit read purpose",
  async () => {
    if (!url) throw Error("Disposable PostgreSQL URL required");
    await withDanceServingPermissionFixture(
      url,
      async (f) => {
        const role = await f.makeRole();
        await f.owner.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${f.quote(f.schema)} GRANT EXECUTE ON FUNCTIONS TO ${f.quote(role.role)}`,
        );
        await f.upgrade();
        for (const signature of [
          "load_shared_song_frozen_plan_v2(text)",
          "guard_shared_song_frozen_purchase_v2()",
          "grant_shared_song_funding_runtime_v2(text,text)",
        ])
          expect(
            (
              await f.owner.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [
                role.role,
                signature,
              ])
            ).rows[0].allowed,
          ).toBe(false);
        await f.owner.query("SELECT grant_shared_song_funding_runtime_v2($1,'safe_purchase')", [
          role.role,
        ]);
        expect(
          (
            await f.owner.query(
              "SELECT has_function_privilege($1,'load_shared_song_frozen_plan_v2(text)','EXECUTE') allowed,has_table_privilege($1,'reward_funding_leg_snapshots_v2','SELECT') raw",
              [role.role],
            )
          ).rows[0],
        ).toEqual({ allowed: true, raw: false });
        const functions = (
          await f.owner.query(
            "SELECT proname,prosecdef,proconfig FROM pg_proc WHERE oid=ANY($1::text[]::regprocedure[])",
            [["load_shared_song_frozen_plan_v2(text)", "guard_shared_song_frozen_purchase_v2()"]],
          )
        ).rows;
        expect(functions).toHaveLength(2);
        expect(functions.every((r) => r.prosecdef && r.proconfig?.[0]?.includes(f.schema))).toBe(
          true,
        );
      },
      321,
    );
  },
  60000,
);

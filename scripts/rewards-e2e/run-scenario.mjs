import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { parseAbi } from "viem";
import { createReviewedBoost, enterKaraoke, reviewBoost } from "./browser-activities.mjs";
import { browserApi } from "./browser-api.mjs";
import { confirmWalletFunding, reviewWalletFunding } from "./browser-funding.mjs";
import { prepareFixtureBrowsers } from "./browser-host.mjs";
import { verifyBackingAudio } from "./browser-media.mjs";
import { completeStudy } from "./browser-study.mjs";
import { buildBrowserWalletDriver } from "./browser-wallet-build.mjs";
import { sendPaidCredit } from "./browser-winner-send.mjs";
import {
  assertNothingOwed,
  assertShutdownInventory,
  fundingQuery,
  readRunInventory,
  readShutdownInventory,
} from "./database-evidence.mjs";
import { assertDrawingAdvanceReady } from "./drawing-advance.mjs";
import {
  advancePurchasedDrawing,
  armFixtureDrawing,
  canonicalFixtureTransaction,
  fixtureChain,
  fixtureJackpot,
  fixtureToken,
  fundFixturePrize,
} from "./fixture-chain.mjs";
import { verifyConfirmedFunding } from "./funding-evidence.mjs";
import { claimParticipantCredit } from "./participant-claims.mjs";
import { singleParticipantCredit } from "./participant-policy.mjs";
import { firstJobsReceiptRead } from "./receipt-evidence.mjs";
import { subscribeJobsReceipts } from "./receipt-observer.mjs";
import {
  assertActivityShares,
  expectedTicketLogs,
  fixtureAttestation,
  fixtureCommunity,
  fixtureCustody,
  fixturePersonas,
  fixturePost,
  fixtureSponsorWallet,
  saveRunEvidence,
  waitForEvidence,
} from "./run-evidence.mjs";
import { disableIsolatedRewards, setIsolatedRewardsFlag } from "./runtime-flags.mjs";
import { verifySettlementReceipts } from "./settlement-evidence.mjs";
import { executeOnce } from "./single-use.mjs";
import { reserveSpending } from "./spending-ledger.mjs";

const fixtureAbi = parseAbi(["function currentDrawingId() view returns(uint256)"]);
export async function runScenario(options) {
  const run = {
    ...options,
    runId: `${options.outcome}-${Date.now()}`,
    deadline: Date.now() + 25 * 60000,
    ledgerDirectory: `${options.evidenceRoot}/spending-ledger`,
  };
  run.directory = `${options.directory}/${run.outcome}`;
  mkdirSync(run.directory, { mode: 0o700 });
  let stage = "preparation",
    host,
    observer,
    legId,
    controlRevision,
    flagsEnabled = false,
    passed = false,
    failure;
  let failureStage;
  const stageSave = (name, data) => {
    stage = name;
    saveRunEvidence(run, name, data);
    console.log(JSON.stringify({ runId: run.runId, stage: name, ...data }));
  };
  const check = async () => {
    if (Date.now() >= run.deadline) throw Error("Isolated run deadline expired");
    const control = (
      await options.db.read(
        "SELECT paused,revision::text FROM reward_operations_control WHERE singleton",
      )
    )[0];
    if (controlRevision !== undefined && (control.paused || control.revision !== controlRevision))
      throw Error("Brake changed during run");
    if (
      observer &&
      (observer.capture.outcome !== "subscribed" ||
        observer.capture.subscriptionGaps ||
        observer.capture.parseFailures)
    )
      throw Error("Receipt observer incomplete");
  };
  const once = (id, prerequisites, submit) =>
    executeOnce(run.directory, id, prerequisites, submit, {
      recheck: check,
      deadline: run.deadline,
    });
  try {
    const microphonePath = `${run.directory}/study-answer-microphone.wav`;
    execFileSync("ffmpeg", [
      "-nostdin",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=mono",
      "-t",
      "1",
      microphonePath,
    ]);
    host = await prepareFixtureBrowsers(
      run.directory,
      {
        study: microphonePath,
        sponsor: microphonePath,
        karaoke: process.env.REWARDS_E2E_KARAOKE_WAV,
      },
      check,
    );
    const route = await browserApi(
      host.pages.study,
      `/api/public/posts/by-id/${fixturePost}/canonical-route`,
    );
    if (!route.route?.activity_paths?.study || !route.route?.activity_paths?.karaoke)
      throw Error("Fresh activity routes missing");
    stage = "backing-audio-preflight";
    const backingAudio = await verifyBackingAudio(host.pages.karaoke);
    run.chain = fixtureChain();
    const driver = await buildBrowserWalletDriver(process.env.REWARDS_E2E_SOLID_ROOT);
    observer = await subscribeJobsReceipts(run.directory);
    stageSave("prepared", {
      accounts: host.report.accounts,
      routes: route.route.activity_paths,
      walletDriverSha256: driver.sha256,
      backingAudio,
    });
    // The whole managed ETH float is a conservative ceiling for automatic sends.
    // Reserve it once; all USDC transfers are separately accounted for below.
    if (run.outcome === "win") {
      const addresses = [
        fixtureCustody,
        fixtureSponsorWallet,
        "0x85ea2bce79f4cf8489457577ce75f98c47c90c6a",
      ];
      const balances = await Promise.all(
        addresses.map((address) => run.chain.publicClient.getBalance({ address })),
      );
      await reserveSpending(run.ledgerDirectory, {
        authoritySha256: run.authoritySha256,
        chainId: 84532,
        runId: run.runId,
        actionId: "worker-gas-float",
        kind: "gas",
        usdcAtomic: "0",
        ethWei: balances.reduce((sum, value) => sum + value, 0n).toString(),
      });
    }
    await reserveSpending(run.ledgerDirectory, {
      authoritySha256: run.authoritySha256,
      chainId: 84532,
      runId: run.runId,
      actionId: "automatic-obligations",
      kind: "payout",
      usdcAtomic: run.outcome === "win" ? "3000000" : "1000000",
      ethWei: "0",
    });
    const prize = await fundFixturePrize(run.chain, run, check);
    const end = Math.ceil((Date.now() + 12 * 60000) / 60000) * 60000;
    const drawingTime = end / 1000 + 240;
    const arm = await armFixtureDrawing(run.chain, run, drawingTime, run.outcome === "loss", check);
    const drawingId = (
      await run.chain.publicClient.readContract({
        address: fixtureJackpot,
        abi: fixtureAbi,
        functionName: "currentDrawingId",
      })
    ).toString();
    stageSave("drawing-armed", {
      prize,
      arm,
      drawingId,
      endsAt: new Date(end).toISOString(),
      drawingTime,
    });
    const initial = (
      await options.db.read(
        "SELECT paused,revision::text FROM reward_operations_control WHERE singleton",
      )
    )[0];
    if (initial.paused !== true) throw Error("Initial brake changed");
    // Flag changes create versions. Resume only after both verified writes finish.
    await setIsolatedRewardsFlag("http", "true", run.apiSource);
    flagsEnabled = true;
    const jobs = await setIsolatedRewardsFlag("jobs", "true", run.apiSource);
    const resumed = await options.db.control(false, initial.revision, `Isolated ${run.runId}`);
    controlRevision = resumed.control.revision;
    const startedAt = Date.now();
    stage = "boost-creation";
    const reviewed = await reviewBoost(host.pages.sponsor, {
      communityPath: `/c/${fixtureCommunity}`,
      postId: fixturePost,
      personaId: fixturePersonas.sponsor,
      endsAt: new Date(end).toISOString(),
    });
    const legResponse = host.pages.sponsor.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/reward-offers\/[^/]+\/megapot-pool-legs$/.test(new URL(response.url()).pathname),
      { timeout: 45000 },
    );
    await createReviewedBoost(reviewed.dialog, () => once("create-offer", check, async () => {}));
    const response = await legResponse;
    if (response.status() !== 201) throw Error("Fresh Boost leg was not created");
    const created = await response.json();
    const { leg, funding } = created;
    if (
      created.replayed ||
      leg.participation_starts_drawing_id !== drawingId ||
      leg.offer_id === undefined
    )
      throw Error("Created leg drawing differs");
    legId = leg.leg_id;
    run.inventory = () => readRunInventory(options.db, legId);
    stageSave("offer-created", { leg, funding, renderedTerms: reviewed.renderedTerms });
    const transfer = {
      chainId: 84532,
      sender: fixtureSponsorWallet,
      recipient: fixtureCustody,
      token: fixtureToken,
      amountAtomic: "1000000",
      maximumExecutionFeeWei: "5000000000000000",
    };
    stage = "funding-confirmation";
    const transferReview = await reviewWalletFunding(host.pages.sponsor, reviewed.dialog, transfer);
    await confirmWalletFunding(host.pages.sponsor, reviewed.dialog, (recheck, click) =>
      once(
        "fund-offer",
        async () => {
          await check();
          await recheck();
          await reserveSpending(run.ledgerDirectory, {
            authoritySha256: run.authoritySha256,
            chainId: 84532,
            runId: run.runId,
            actionId: "fund-offer",
            kind: "principal",
            usdcAtomic: "1000000",
            ethWei: transfer.maximumExecutionFeeWei,
          });
        },
        click,
      ),
    );
    const fundedRows = await waitForEvidence(
      "funding confirmation",
      end - 60000,
      () => options.db.read(fundingQuery, [leg.offer_id, legId, new Date(startedAt).toISOString()]),
      (rows) => rows.length === 1 && rows[0].state === "confirmed",
      check,
    );
    const expected = {
      ...transfer,
      custody: fixtureCustody,
      accountId: host.report.accounts[0].accountId,
      transactionHash: fundedRows[0].transaction_hash,
      offerId: leg.offer_id,
      legId,
      effectId: funding.funding_effect_id,
      communityId: fixtureCommunity,
      postId: fixturePost,
      attestationId: fixtureAttestation,
      drawingId,
      controlRevision,
      startedAt,
      deadline: end - 60000,
    };
    const fundingCheck = async () => {
      await check();
      const receipt = await run.chain.publicClient.request({
        method: "eth_getTransactionReceipt",
        params: [expected.transactionHash],
      });
      const [block, head, chainId] = await Promise.all([
        run.chain.publicClient.request({
          method: "eth_getBlockByNumber",
          params: [receipt.blockNumber, false],
        }),
        run.chain.publicClient.request({
          method: "eth_getBlockByNumber",
          params: ["latest", false],
        }),
        run.chain.publicClient.request({ method: "eth_chainId" }),
      ]);
      return verifyConfirmedFunding(
        await options.db.read(fundingQuery, [
          leg.offer_id,
          legId,
          new Date(startedAt).toISOString(),
        ]),
        { receipt, block, head, chainId },
        expected,
      );
    };
    stageSave("funding-confirmed", { ...(await fundingCheck()), review: transferReview });
    stage = "activity-qualification";
    const activities = await Promise.all([
      (async () => {
        const page = host.pages.study;
        const pending = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname.endsWith("/study/v2/sessions"),
          { timeout: 45000 },
        );
        await page.goto(route.route.activity_paths.study, { waitUntil: "domcontentloaded" });
        const response = await pending;
        if (response.status() !== 201) throw Error("Study start refused");
        const session = await response.json();
        return completeStudy(page, {
          communityId: fixtureCommunity,
          sessionId: session.session_id,
          directory: run.directory,
          microphonePath,
          deadline: end - 60000,
          firstCapture: (recheck, capture) =>
            once(
              "study-first-capture",
              async () => {
                await fundingCheck();
                await recheck();
              },
              capture,
            ),
        });
      })(),
      (async () => {
        const page = host.pages.karaoke;
        await page.goto(route.route.activity_paths.karaoke, { waitUntil: "domcontentloaded" });
        await enterKaraoke(page, () => once("karaoke-start", fundingCheck, async () => {}));
        return { started: true };
      })(),
    ]);
    const shares = await waitForEvidence(
      "both qualifying activity shares",
      end - 60000,
      () => run.inventory(),
      (inventory) => inventory.shares.length >= 2,
      check,
    );
    assertActivityShares(shares.shares);
    stageSave("activities-qualified", { activities, shares: shares.shares });
    stage = "ticket-purchase-and-first-read";
    const purchased = await waitForEvidence(
      "confirmed jobs ticket",
      run.deadline,
      () => run.inventory(),
      (inventory) =>
        inventory.purchases.length === 1 &&
        inventory.purchases[0].state === "confirmed" &&
        inventory.purchases[0].ticket_id !== null,
      check,
    );
    const purchase = purchased.purchases[0];
    await observer.flush();
    const identity = {
      chainId: 84532,
      drawingId,
      ticketId: purchase.ticket_id,
      transactionHash: purchase.transaction_hash,
      jobsVersionId: jobs.versionId,
      effectId: purchase.effect_id,
      attestationId: fixtureAttestation,
    };
    const firstRead = firstJobsReceiptRead(observer.capture, identity);
    const receipt = await canonicalFixtureTransaction(
      run.chain,
      identity.transactionHash,
      run.deadline,
    );
    const head = await run.chain.publicClient.getBlockNumber();
    const publicProof = {
      chainId: 84532,
      transactionHash: receipt.transactionHash,
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      canonicalBlockHash: receipt.blockHash,
      confirmations: Number(head - receipt.blockNumber + 1n),
      expectedPurchaseLogCount: expectedTicketLogs(receipt, identity),
    };
    const confirmed = {
      status: purchase.state,
      effectId: purchase.effect_id,
      drawingId: purchase.drawing_id,
      ticketId: purchase.ticket_id,
      transactionHash: purchase.transaction_hash,
    };
    assertDrawingAdvanceReady({
      purchase: confirmed,
      firstRead,
      receipt: publicProof,
      expected: identity,
    });
    stageSave("purchase-first-read", { purchase: confirmed, firstRead, receipt: publicProof });
    stage = "drawing-advancement";
    await advancePurchasedDrawing(run.chain, run, drawingId, identity.ticketId, async () => {
      await check();
      assertDrawingAdvanceReady({
        purchase: confirmed,
        firstRead,
        receipt: publicProof,
        expected: identity,
      });
    });
    if (run.outcome === "win") {
      stage = "participant-claims-and-onward-sends";
      const allocated = await waitForEvidence(
        "two participant credits",
        run.deadline,
        () => run.inventory(),
        (inventory) => inventory.credits.length === 2,
        check,
      );
      const sends = [];
      for (const role of ["study", "karaoke"]) {
        const paid = await claimParticipantCredit(host.pages[role], role, allocated, run, check);
        sends.push(
          await sendPaidCredit(
            host.pages[role],
            role,
            singleParticipantCredit(paid.credits, role),
            run,
            driver,
            check,
          ),
        );
      }
      await waitForEvidence(
        "both onward sends confirmed",
        run.deadline,
        () =>
          options.db.read(
            "SELECT send.status FROM reward_winner_sends send JOIN megapot_allocations allocation USING(credit_id) JOIN megapot_allocation_batches batch USING(allocation_batch_id) WHERE batch.pool_leg_id=$1",
            [legId],
          ),
        (rows) => rows.length === 2 && rows.every((row) => row.status === "confirmed"),
        check,
      );
      stageSave("onward-sends-confirmed", { sends });
    }
    stage = "settlement-and-zero-obligations";
    const settled = await waitForEvidence(
      "zero obligations",
      run.deadline,
      () => run.inventory(),
      (inventory) => {
        try {
          assertNothingOwed(inventory);
          return inventory.refunds.length === 1 && inventory.refunds[0].amount_atomic === "990000";
        } catch {
          return false;
        }
      },
      check,
    );
    if (run.outcome === "loss" && settled.credits.length !== 0)
      throw Error("Forced loss unexpectedly credited");
    const receipts = await verifySettlementReceipts({ ...run, db: options.db, legId }, settled);
    stageSave("settlement-complete", { inventory: settled, receipts, nothingOwed: true });
    passed = true;
  } catch (error) {
    failure = error;
    failureStage = stage;
  } finally {
    const errors = [];
    let brake;
    try {
      const current = (
        await options.db.read(
          "SELECT paused,revision::text FROM reward_operations_control WHERE singleton",
        )
      )[0];
      if (!current.paused)
        await options.db.control(
          true,
          current.revision,
          `Isolated ${run.runId} closeout at ${stage}`,
        );
      brake = (
        await options.db.read(
          "SELECT paused,revision::text FROM reward_operations_control WHERE singleton",
        )
      )[0];
      if (brake?.paused !== true) errors.push("brake pause not verified");
    } catch {
      errors.push("brake pause refused");
    }
    const disabled = await disableIsolatedRewards(run.apiSource);
    if (!disabled.flagsOff) errors.push("flags disable uncertain");
    if (observer) {
      try {
        const capture = await observer.close();
        if (capture.outcome !== "capture-ended") errors.push("receipt capture incomplete");
      } catch {
        errors.push("receipt capture cleanup failed");
      }
    }
    try {
      await host?.close();
    } catch {
      errors.push("browser closeout failed");
    }
    const inventory = legId ? await run.inventory().catch(() => null) : null;
    let shutdownInventory;
    try {
      shutdownInventory = await readShutdownInventory(options.db);
      assertShutdownInventory(shutdownInventory);
    } catch {
      errors.push("global obligations inventory refused");
    }
    if (passed) {
      try {
        assertNothingOwed(inventory);
      } catch {
        errors.push("final obligations inventory refused");
      }
    }
    stageSave("closeout", {
      passed: passed && errors.length === 0,
      lastStage: stage,
      failureStage,
      failureReason: failure?.message,
      brake,
      browsersClosed: host?.report.browsersClosed,
      shutdownInventory,
      flagsEnabled,
      disabled,
      inventory,
      errors,
    });
    if (errors.length)
      failure = new Error(`Closeout failed: ${errors.join(", ")}`, { cause: failure });
  }
  if (failure)
    throw new Error(`Run failed at ${failureStage ?? stage}: ${failure.message}`, {
      cause: failure,
    });
  return {
    runId: run.runId,
    outcome: run.outcome,
    passed,
    apiSource: run.apiSource,
    solidSource: run.solidSource,
    nothingOwed: passed,
    flagsOff: true,
    brakePaused: true,
  };
}

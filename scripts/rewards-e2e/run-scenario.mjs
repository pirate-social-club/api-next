import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { parseAbi } from "viem";
import { fixtureAccounts } from "./browser-accounts.mjs";
import { createReviewedBoost, enterKaraoke, reviewBoost } from "./browser-activities.mjs";
import { browserApi } from "./browser-api.mjs";
import { confirmWalletFunding, reviewWalletFunding } from "./browser-funding.mjs";
import { prepareFixtureBrowsers } from "./browser-host.mjs";
import { verifyBackingAudio } from "./browser-media.mjs";
import { completeStudy } from "./browser-study.mjs";
import { buildBrowserWalletDriver } from "./browser-wallet-build.mjs";
import { sendPaidCredit } from "./browser-winner-send.mjs";
import { jobsFundingProof } from "./cycle-evidence.mjs";
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
  clearStaleFixtureDrawing,
  fixtureChain,
  fixtureJackpot,
  fixtureToken,
  fundFixturePrize,
  readManagedFloat,
  settleDueDrawing,
} from "./fixture-chain.mjs";
import { verifyConfirmedFunding } from "./funding-evidence.mjs";
import { claimParticipantCredit } from "./participant-claims.mjs";
import { singleParticipantCredit } from "./participant-policy.mjs";
import { firstJobsReceiptRead } from "./receipt-evidence.mjs";
import { subscribeJobsCycles, subscribeJobsReceipts } from "./receipt-observer.mjs";
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
import { recoverSettlement, recoveryDeadline } from "./settlement-recovery.mjs";
import { executeOnce } from "./single-use.mjs";
import { feeCeilings, reserveSpending } from "./spending-ledger.mjs";

const fixtureAbi = parseAbi(["function currentDrawingId() view returns(uint256)"]);
const controlQuery = "SELECT paused,revision::text FROM reward_operations_control WHERE singleton";
export async function runScenario(options) {
  const run = {
    ...options,
    runId: `${options.outcome}-${Date.now()}`,
    deadline: Date.now() + 25 * 60000,
    ledgerDirectory: `${options.evidenceRoot}/spending-ledger`,
    // What a passing run still does not establish; reported with its result.
    unproven: [],
  };
  run.directory = `${options.directory}/${run.outcome}`;
  mkdirSync(run.directory, { mode: 0o700 });
  let stage = "preparation",
    host,
    observer,
    legId,
    drawingId,
    drawingTime,
    controlRevision,
    flagsEnabled = false,
    passed = false,
    failure;
  let failureStage;
  let jobsVersionId;
  let cycleObserver;
  /**
   * The one gate for settling a purchased drawing, in the run and in recovery:
   * the pinned jobs Worker's first receipt read and an independently canonical
   * purchase receipt. Missing or uncertain evidence throws and nothing is sent.
   */
  const proveAdvanceReady = async (purchase, deadline) => {
    if (!observer || jobsVersionId === undefined) throw Error("Receipt evidence unavailable");
    await observer.flush();
    const identity = {
      chainId: 84532,
      drawingId,
      ticketId: purchase.ticket_id,
      transactionHash: purchase.transaction_hash,
      jobsVersionId,
      effectId: purchase.effect_id,
      attestationId: fixtureAttestation,
    };
    const firstRead = firstJobsReceiptRead(observer.capture, identity);
    const receipt = await canonicalFixtureTransaction(
      run.chain,
      identity.transactionHash,
      deadline,
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
    const assertReady = () =>
      assertDrawingAdvanceReady({
        purchase: confirmed,
        firstRead,
        receipt: publicProof,
        expected: identity,
      });
    assertReady();
    return { identity, firstRead, publicProof, confirmed, assertReady };
  };
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
    // Losing this second capture never stops a run; it only leaves jobs funding
    // confirmation unproven.
    cycleObserver = await subscribeJobsCycles(run.directory).catch(() => undefined);
    stageSave("prepared", {
      accounts: host.report.accounts,
      routes: route.route.activity_paths,
      walletDriverSha256: driver.sha256,
      backingAudio,
    });
    // The managed ETH float is a ceiling for automatic sends. It is one exposure,
    // so it is reserved once for the authorization and not again per run.
    const managedFloat = await readManagedFloat(run.chain);
    try {
      await reserveSpending(run.ledgerDirectory, {
        authoritySha256: run.authoritySha256,
        chainId: 84532,
        runId: "managed-float",
        actionId: "worker-gas-float",
        kind: "gas",
        usdcAtomic: "0",
        ethWei: managedFloat.toString(),
      });
    } catch (error) {
      if (error?.message !== "Spending action already reserved; do not replay") throw error;
    }
    const stale = await clearStaleFixtureDrawing(run.chain, run, check);
    const prize = await fundFixturePrize(run.chain, run, check);
    // The product starts a leg on the drawing after the last observed one, so an
    // empty placeholder is observed first and the outcome drawing is armed later.
    // Four minutes covers the arm, both flag deploys and one jobs tick before it is due.
    const placeholderTime = Math.floor(Date.now() / 1000) + 240;
    const placeholderArm = await armFixtureDrawing(
      run.chain,
      run,
      {
        actionId: "arm-placeholder",
        drawingTime: placeholderTime,
        payoutAtomic: 1n,
        forceLoss: true,
        placeholder: true,
      },
      check,
    );
    const readDrawingId = async () =>
      (
        await run.chain.publicClient.readContract({
          address: fixtureJackpot,
          abi: fixtureAbi,
          functionName: "currentDrawingId",
        })
      ).toString();
    const placeholderId = await readDrawingId();
    drawingId = (BigInt(placeholderId) + 1n).toString();
    stageSave("placeholder-armed", {
      stale,
      prize,
      placeholderArm,
      placeholderId,
      placeholderTime,
    });
    const initial = (await options.db.read(controlQuery))[0];
    if (initial.paused !== true) throw Error("Initial brake changed");
    // Flag changes create versions. Resume only after both verified writes finish.
    await setIsolatedRewardsFlag("http", "true", run.apiSource);
    flagsEnabled = true;
    const jobs = await setIsolatedRewardsFlag("jobs", "true", run.apiSource);
    jobsVersionId = jobs.versionId;
    const resumed = await options.db.control(false, initial.revision, `Isolated ${run.runId}`);
    controlRevision = resumed.control.revision;
    stage = "placeholder-observation";
    await waitForEvidence(
      "jobs observation of the placeholder drawing",
      placeholderTime * 1000,
      () =>
        options.db.read(
          "SELECT observation_id FROM megapot_drawing_observations WHERE attestation_id=$1 AND drawing_id=$2::numeric AND NOT drawing_locked AND expires_at > clock_timestamp()",
          [fixtureAttestation, placeholderId],
        ),
      (rows) => rows.length > 0,
      check,
    );
    // Funding, the placeholder settlement, the outcome arm and one jobs tick precede activities.
    const end = Math.ceil((Date.now() + 18 * 60000) / 60000) * 60000;
    drawingTime = end / 1000 + 240;
    // Purchase, settlement, claims, payouts and the refund all follow the cutoff.
    run.deadline = drawingTime * 1000 + 14 * 60000;
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
      maximumExecutionFeeWei: feeCeilings.fundingWei.toString(),
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
    const readFunding = () =>
      options.db.read(fundingQuery, [leg.offer_id, legId, new Date(startedAt).toISOString()]);
    // The app binds the transfer's hash once, right after the wallet sends it. The
    // sponsor then leaves: the page is unloaded so that nothing in a browser can ask
    // the server to look again, and only the jobs Worker can confirm the payment.
    const boundRows = await waitForEvidence(
      "funding submission",
      Math.min(Date.now() + 120000, end - 60000),
      readFunding,
      (rows) => rows.length === 1 && typeof rows[0].transaction_hash === "string",
      check,
    );
    await host.pages.sponsor.goto("about:blank");
    const sponsorLeft = {
      at: new Date().toISOString(),
      stateWhenSponsorLeft: (await readFunding())[0]?.state,
    };
    stageSave("sponsor-left", { ...sponsorLeft, transactionHash: boundRows[0].transaction_hash });
    // Passive reads only from here: no control is pressed and no API is called.
    const fundedRows = await waitForEvidence(
      "funding confirmation",
      end - 60000,
      readFunding,
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
    // The same read-only proof is repeated briefly: public nodes can lag each other
    // by a block, and one stale read must not end a funded run.
    const fundingCheck = async () => {
      let last;
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt) await Bun.sleep(2000);
        if (Date.now() >= run.deadline) break;
        try {
          const proof = await fundingProof();
          if (Date.now() >= run.deadline) break;
          return proof;
        } catch (error) {
          last = error;
        }
      }
      throw last ?? Error("Isolated run deadline expired");
    };
    const fundingProof = async () => {
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
    // The page leaving shows no browser asked again, but an HTTP observation already
    // in flight can still confirm. Only the jobs Worker's own cycle summary shows
    // that jobs did it, so its summary for the confirming minute is awaited briefly.
    const confirmedAt = new Date(fundedRows[0].confirmed_at).toISOString();
    const cycleCapture = () => cycleObserver?.capture;
    for (let waited = 0; waited < 90000 && Date.now() < end - 60000; waited += 3000) {
      await cycleObserver?.flush();
      if (
        !cycleCapture() ||
        cycleCapture().events.some(
          (cycle) => Date.parse(cycle.emittedAt) >= Date.parse(confirmedAt),
        )
      )
        break;
      await Bun.sleep(3000);
    }
    const jobsConfirmation = jobsFundingProof({
      stateWhenSponsorLeft: sponsorLeft.stateWhenSponsorLeft,
      sponsorLeftAt: sponsorLeft.at,
      confirmedAt,
      jobsVersionId,
      captureComplete:
        cycleCapture()?.outcome === "subscribed" &&
        !cycleCapture().subscriptionGaps &&
        !cycleCapture().parseFailures,
      cycles: cycleCapture()?.events,
    });
    if (!jobsConfirmation.proven) run.unproven.push("jobs funding confirmation");
    stageSave("funding-confirmed", {
      ...(await fundingCheck()),
      review: transferReview,
      sponsorLeftAt: sponsorLeft.at,
      confirmedAt,
      jobsConfirmation,
    });
    stage = "outcome-drawing";
    const placeholderSettled = await settleDueDrawing(
      run.chain,
      run,
      "settle-placeholder",
      placeholderTime * 1000 + 3 * 60000,
      check,
    );
    const arm = await armFixtureDrawing(
      run.chain,
      run,
      {
        actionId: "arm-drawing",
        drawingTime,
        payoutAtomic: 1000000n,
        forceLoss: run.outcome === "loss",
      },
      check,
    );
    if ((await readDrawingId()) !== drawingId) throw Error("Outcome drawing differs from the leg");
    await waitForEvidence(
      "open pool drawing for the outcome drawing",
      end - 9 * 60000,
      () => run.inventory(),
      (inventory) =>
        inventory.drawings.some(
          (drawing) => drawing.drawing_id === drawingId && drawing.status === "entry_open",
        ),
      check,
    );
    stageSave("drawing-armed", {
      placeholderSettled,
      arm,
      drawingId,
      endsAt: new Date(end).toISOString(),
      drawingTime,
    });
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
    const proof = await proveAdvanceReady(purchase, run.deadline);
    stageSave("purchase-first-read", {
      purchase: proof.confirmed,
      firstRead: proof.firstRead,
      receipt: proof.publicProof,
    });
    stage = "drawing-advancement";
    await advancePurchasedDrawing(run.chain, run, drawingId, proof.identity.ticketId, async () => {
      await check();
      proof.assertReady();
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
    let recovery;
    // A funded offer, share or ticket must settle before the stack is shut down.
    if (!passed && controlRevision !== undefined) {
      const recoveryRun = { ...run, deadline: recoveryDeadline(Date.now(), drawingTime) };
      const recoveryCheck = async () => {
        if (Date.now() >= recoveryRun.deadline) throw Error("Settlement recovery deadline expired");
        const control = (await options.db.read(controlQuery))[0];
        if (control.paused || control.revision !== controlRevision)
          throw Error("Brake changed during recovery");
      };
      try {
        recovery = await recoverSettlement({
          deadline: recoveryRun.deadline,
          roles: ["study", "karaoke"].map((name) => ({
            name,
            accountId: fixtureAccounts[name].accountId,
          })),
          expectedRevision: controlRevision,
          readControl: async () => (await options.db.read(controlQuery))[0],
          // The create click can land without its response; then only the stack inventory is known.
          readInventory: () => (legId ? run.inventory() : null),
          readShutdownInventory: () => readShutdownInventory(options.db),
          // Recovery settles a ticket only on the same evidence as the run itself.
          advance: async (purchase) => {
            const proof = await proveAdvanceReady(purchase, recoveryRun.deadline);
            return advancePurchasedDrawing(
              run.chain,
              recoveryRun,
              drawingId,
              proof.identity.ticketId,
              async () => {
                await recoveryCheck();
                proof.assertReady();
              },
              // The contract refuses a second settlement, so a separate marker cannot replay one.
              "recover-advance-purchased-drawing",
            );
          },
          // A failed run may hold one share, so its credit is not the equal split.
          claim: (role, inventory) =>
            claimParticipantCredit(
              host.pages[role],
              role,
              inventory,
              recoveryRun,
              recoveryCheck,
              (credits, name) => {
                const rows = credits.filter(
                  (credit) => credit.account_id === fixtureAccounts[name].accountId,
                );
                if (rows.length !== 1) throw Error("Recovery credit is missing or ambiguous");
                return rows[0];
              },
            ),
        });
      } catch (error) {
        recovery = {
          settled: false,
          reason: error instanceof Error ? error.message : "Settlement recovery refused",
        };
      }
    }
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
    let shutdownInventory;
    let nothingOwedAnywhere = false;
    try {
      shutdownInventory = await readShutdownInventory(options.db);
      assertShutdownInventory(shutdownInventory);
      nothingOwedAnywhere = true;
    } catch {
      errors.push("global obligations inventory refused");
    }
    // Flags stay on while anything is owed, so obligations remain visible and payable.
    let disabled;
    if (nothingOwedAnywhere) {
      disabled = await disableIsolatedRewards(run.apiSource);
      if (!disabled.flagsOff) errors.push("flags disable uncertain");
    } else if (flagsEnabled) {
      errors.push("obligations remain; flags left enabled for recovery");
    }
    // Its outcome was judged when funding confirmed; closing it late is not an error.
    await cycleObserver?.close().catch(() => undefined);
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
      recovery,
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
    // A pass proves the money movement. These it never proves, by construction:
    // claims and sends go through the API and an injected wallet, and claim
    // verification is the isolated build's stub.
    unproven: ["ordinary claim and Wallet screens", "real claim verification", ...run.unproven],
  };
}

/** Genuine retained-v2 source checkpoint only. No enabled owner-money producer. */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Clock, IdGen, prepareActivityPersona, type StudyBatchTranscriber } from "@pirate/application";
import { makeControlledAccountSpokenService } from "@pirate/application/controlled-account-spoken";
import { Effect, Schema } from "effect";
import { loadPostgresMigrations, runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { type Fixture, fixture, hash, pgUrl, q, run } from "./account-study-producer.pg-fixture.ts";
import { makeAccountControlledSpokenProtocol } from "./account-spoken-producer-protocol.ts";
import { makeControlledAccountStudyV2Store } from "./controlled-account-study-store.ts";
import { makeMegapotCommitmentCoordinator } from "./megapot-commitment-coordinator.ts";
import { makeControlPlaneMegapotCommitmentStore } from "./megapot-commitment-repository.ts";
import { makeMegapotCutoffCoordinator } from "./megapot-cutoff-coordinator.ts";
import { makeControlPlaneMegapotCutoffStore } from "./megapot-cutoff-repository.ts";
import { makeControlPlaneMegapotDrawingObservationStore } from "./megapot-drawing-observation-repository.ts";
import { makeOwnedOrdinaryAccountBirthFixture } from "./ordinary-study-account-birth.pg-fixture.ts";
import { makeControlPlanePersonaStore } from "./persona-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneRewardPayoutStore } from "./reward-payout-repository.ts";
import { makeControlPlaneRewardProjectionStore } from "./reward-projection-repository.ts";
import { completeComposedWinningChain } from "./rewards-composed-chain.pg-fixture.ts";
import { bytes32, hash as repeatedHash, seedActivePoolLeg, seedMegapotAuthority } from "./rewards-composed-pool.pg-fixture.ts";
import { confirmWallet, seedVeryRewardEvidence } from "./activity-participation-composed-identity.pg-fixture.ts";

const suite = pgUrl ? describe : describe.skip;
const checkpointVersion = "0264_disabled_owner_financial_history.sql";
const checkpointSha = "96afb781bc957c1fc69c128b715ae079c4db72e6fa1f86162592199509559f55";
const privateTables = ["guest_owner_associations", "participation_eligibility_decisions", "megapot_owner_shares", "megapot_owner_snapshot_leaves", "megapot_owner_allocations", "reward_credit_persona_bindings", "reward_credit_recipient_selections"] as const;
const privateFunctions = ["reject_disabled_owner_financial_dml_v1()", "guard_disabled_beneficiary_dispatch_v1()", "guard_disabled_owner_credit_dispatch_v1()", "require_megapot_beneficiary_version_private_v1(text,numeric,smallint)", "guest_financial_component_has_history_private_v1(text[])", "require_disabled_owner_financial_inventory_private_v1()"] as const;
const retainedTables = ["megapot_pool_drawings", "megapot_pool_shares", "reward_eligibility_decisions", "megapot_pool_beneficiary_snapshots", "megapot_pool_snapshot_private_leaves", "megapot_pool_commitment_effects", "megapot_ticket_purchase_effects", "megapot_purchase_receipt_evidence", "megapot_ticket_inventory", "megapot_drawing_sweeps", "megapot_sweep_ticket_evidence", "megapot_claim_effects", "megapot_claim_receipt_evidence", "megapot_allocation_batches", "megapot_allocations", "reward_ledger_credits", "megapot_participant_claims", "megapot_participant_claim_guards", "reward_payout_effects", "reward_chain_effects", "reward_chain_effect_transitions", "reward_erc20_transfer_receipt_evidence", "study_sessions_v2", "study_spoken_answer_commands", "learner_audio_artifacts", "learner_audio_account_spoken_checkpoints", "learner_audio_upload_terminal_facts", "learner_audio_account_provider_calls"] as const;

async function sourcePacket() {
  const literal = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(JSON.parse(await readFile(new URL("./disabled-owner-accounting.accepted-learning-prefix.json", import.meta.url), "utf8")));
  const all = await loadPostgresMigrations();
  const first = all.slice(0, 264);
  expect(first.map(({ version }) => Number(version.slice(0, 4)))).toEqual(Array.from({ length: 264 }, (_, index) => index + 1));
  expect(Object.keys(literal).sort()).toEqual(first.slice(0, 263).map(({ version }) => version));
  for (const entry of first.slice(0, 263)) {
    const accepted = literal[entry.version];
    if (accepted === undefined) throw new Error("Accepted learning prefix entry is unavailable");
    expect(entry.checksum).toBe(accepted);
  }
  const checkpoint = first[263];
  if (checkpoint === undefined) throw new Error("Adopted264 checkpoint is unavailable");
  expect(checkpoint.version).toBe(checkpointVersion);
  expect(checkpoint.checksum).toBe(checkpointSha);
  return first;
}

async function fingerprint(f: Fixture) {
  const values: Record<string, { count: number; hash: string }> = {};
  for (const table of retainedTables) {
    // Normalize only the five source-owned additive264 version/identity columns.
    // Every old financial ID, salt, commitment, beneficiary and amount stays in
    // the canonical ordered hash; payload/private leaves never reach diagnostics.
    const removed = table === "reward_ledger_credits"
      ? ["identity_version", "participation_owner_id"]
      : ["megapot_pool_drawings", "megapot_pool_shares", "megapot_pool_beneficiary_snapshots", "megapot_allocation_batches"].includes(table)
        ? ["beneficiary_version"] : [];
    const row = (await f.admin.query<{ count: number; hash: string }>(
      `SELECT count(*)::INTEGER AS count,encode(sha256(convert_to(COALESCE(string_agg((to_jsonb(source)-$1::TEXT[])::TEXT,E'\\n' ORDER BY (to_jsonb(source)-$1::TEXT[])::TEXT),''),'UTF8')),'hex') AS hash FROM ${q(table)} source`, [removed],
    )).rows[0];
    if (row === undefined) throw new Error("Retained source fingerprint is unavailable");
    values[table] = row;
  }
  return values;
}

function accountStudy(f: Fixture, accountId: string, personaId: string) {
  // Actual default driver, genuine controlled Account reserve/capture/provider
  // checkpoint/archive/finalizer; no direct qualification or archive row seed.
  const runtime = makeDirectPostgresControlPlaneLayer(f.runtimeUrl, { closeTimeoutMs: 2000 });
  const store = makeControlledAccountStudyV2Store(runtime);
  const tasks: Promise<unknown>[] = [];
  f.registerDrain(() => Promise.all(tasks));
  const transcriber: StudyBatchTranscriber = {
    providerRetention: "stored",
    transcribe: Effect.fn("disabledAccountingFixture.transcribe")(function* (input: Parameters<StudyBatchTranscriber["transcribe"]>[0]) {
      yield* Effect.promise(async () => {
        const row = (await f.admin.query("SELECT c.account_id,c.source_kind,p.state AS provider_state,u.io_state FROM learner_audio_account_producer_captures c JOIN learner_audio_account_provider_calls p USING(upload_attempt_id) JOIN learner_audio_upload_attempts u USING(upload_attempt_id) WHERE c.account_id=$1 AND c.content_digest=$2", [accountId, hash(input.audio)])).rows;
        expect(row).toEqual([{ account_id: accountId, source_kind: "study", provider_state: "started", io_state: "registered" }]);
        expect((await f.admin.query("SELECT count(*)::INTEGER AS count FROM pg_stat_activity WHERE usename=$1 AND xact_start IS NOT NULL", [f.role])).rows).toEqual([{ count: 0 }]);
      });
      return { transcript: new TextDecoder().decode(input.audio), detectedLanguage: "en", detectedLanguageConfidence: 0.99 };
    }),
  };
  const protocol = makeAccountControlledSpokenProtocol(runtime, store.reserve, store.finalize, {
    put: async (key, audio) => {
      expect((await f.admin.query("SELECT count(*)::INTEGER AS count FROM learner_audio_account_spoken_checkpoints cp JOIN learner_audio_account_producer_captures cap USING(upload_attempt_id) WHERE cap.account_id=$1 AND cap.expected_object_ref=$2", [accountId, key])).rows).toEqual([{ count: 1 }]);
      expect((await f.admin.query("SELECT count(*)::INTEGER AS count FROM pg_stat_activity WHERE usename=$1 AND xact_start IS NOT NULL", [f.role])).rows).toEqual([{ count: 0 }]);
      return { size: audio.byteLength };
    },
  }, (task) => tasks.push(task));
  const service = makeControlledAccountSpokenService(store.ordinary, protocol, transcriber, false);
  return async (sessionId: string) => {
    let session = await run(store.ordinary.startSession({ accountId, personaId, communityId: "study-community", postId: "study-post", sessionId, idempotencyKey: `start:${sessionId}`, requestHash: hash(`start:${sessionId}`), createdAt: new Date().toISOString(), targetLanguage: null, learnerBand: null, timezone: "UTC" }));
    expect(session.items).toHaveLength(4);
    for (let index = 0; index < 4; index++) {
      const current = session.lesson.current;
      if (current === null) throw new Error("Genuine current Study item is required");
      const base = { accountId, communityId: "study-community", sessionId: session.session_id, sessionItemId: current.session_item_id, idempotencyKey: `answer:${sessionId}:${index}` };
      const context = await run(store.ordinary.loadSpokenAnswerContext(base));
      const result = await run(service.submitSpokenAnswer({ ...base, attemptNumber: current.presentation_number, audio: new TextEncoder().encode(context.referenceText), audioContentType: "audio/webm", audioDurationMs: 1000 }).pipe(Effect.provideService(Clock, { now: Effect.sync(() => Date.now()) }), Effect.provideService(IdGen, { next: Effect.sync(() => crypto.randomUUID()) })));
      expect(result.outcome).toBe("correct");
      session = result.session;
    }
    expect(session.status).toBe("completed");
    await Promise.all(tasks);
  };
}

async function nativeBoundaries(f: Fixture) {
  for (const table of privateTables) {
    expect((await f.admin.query(`SELECT count(*)::INTEGER AS count FROM ${q(table)}`)).rows).toEqual([{ count: 0 }]);
    expect((await f.admin.query("SELECT c.relowner=o.relowner AS same_owner,c.relnamespace=o.relnamespace AS same_namespace,c.relkind,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c CROSS JOIN pg_class o WHERE c.oid=$1::regclass AND o.oid='participation_owners'::regclass", [table])).rows).toEqual([{ same_owner: true, same_namespace: true, relkind: "r", relrowsecurity: true, relforcerowsecurity: false }]);
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) expect((await f.serving.query("SELECT has_table_privilege(current_user,$1,$2) AS allowed", [table, privilege])).rows).toEqual([{ allowed: false }]);
    await expect(f.serving.query(`SELECT * FROM ${q(table)}`)).rejects.toMatchObject({ code: "42501" });
    for (const statement of [`INSERT INTO ${q(table)} DEFAULT VALUES`, `DELETE FROM ${q(table)}`, `TRUNCATE ${q(table)} CASCADE`]) await expect(f.admin.query(statement)).rejects.toMatchObject({ code: "GP003" });
    const column = (await f.admin.query<{ column: string }>("SELECT attname AS column FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum LIMIT 1", [table])).rows[0]?.column;
    if (column === undefined) throw new Error("Private table identity column is unavailable");
    await expect(f.admin.query(`UPDATE ${q(table)} SET ${q(column)}=${q(column)}`)).rejects.toMatchObject({ code: "GP003" });
  }
  for (const signature of privateFunctions) {
    expect((await f.admin.query("SELECT p.proowner=c.relowner AS same_owner,p.pronamespace=c.relnamespace AS same_namespace,p.prosecdef,p.proconfig,NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner) AS owner_only FROM pg_proc p CROSS JOIN pg_class c WHERE p.oid=$1::regprocedure AND c.oid='participation_owners'::regclass", [signature])).rows).toEqual([{ same_owner: true, same_namespace: true, prosecdef: true, proconfig: [`search_path=pg_catalog, ${f.schema}, pg_temp`], owner_only: true }]);
    expect((await f.serving.query("SELECT has_function_privilege(current_user,$1::regprocedure,'EXECUTE') AS allowed", [signature])).rows).toEqual([{ allowed: false }]);
  }
  await f.admin.query("SELECT require_guest_practice_only_schema_phase_v1(); SELECT require_disabled_owner_financial_inventory_private_v1()");
  expect((await f.serving.query("SELECT has_table_privilege(current_user,'megapot_pool_shares','INSERT') AS table_insert,has_column_privilege(current_user,'megapot_pool_shares','account_id','INSERT') AS column_insert")).rows).toEqual([{ table_insert: false, column_insert: false }]);
}

suite("first disabled owner accounting checkpoint", () => {
  test("preserves genuine populated v2 and held/conflicted credits while restricted Account Study continues through the secured projector", async () => {
    const packet = await sourcePacket();
    await fixture(async (f) => {
      if (!pgUrl) throw new Error("Owned PostgreSQL URL is required");
      const adminUrl = new URL(pgUrl);
      adminUrl.searchParams.set("options", `-c search_path=${f.schema}`);
      const original = packet.slice(0, 263);
      // Existing fixture installed genuine0001..262 and historical source song
      // at247; append real263 through the maintained ledger transaction.
      await runPostgresMigrations({ connectionString: adminUrl.toString(), migrations: original, expectedLedger: original.slice(0, 262) });
      const adminRuntime = makeDirectPostgresControlPlaneLayer(adminUrl.toString());
      await f.admin.query("SELECT set_reward_operations_paused_v1(revision,FALSE,'isolated_test_fixture') FROM reward_operations_control WHERE singleton");
      await seedMegapotAuthority(f.admin);
      const leg = await seedActivePoolLeg(f.admin, { accountId: "study-account", personaId: "study-persona", communityId: "study-community", postId: "study-post" }, { fallback: false, suffix: "disabled-v2-retained" });
      const people = ["retained-account-a", "retained-account-b", "retained-account-open", "retained-account-after"] as const;
      const personas = new Map<string, string>();
      const birth = makeOwnedOrdinaryAccountBirthFixture(adminRuntime);
      const prepare = async (accountId: string) => {
        await birth(accountId);
        const result = await run(prepareActivityPersona({ accountId, communityId: "study-community", body: { idempotency_key: `prepare:${accountId}`, choice: { kind: "create_new" } } }, { store: makeControlPlanePersonaStore(adminRuntime), nextPersonaId: () => Effect.sync(() => `persona_${crypto.randomUUID().replaceAll("-", "")}`), nowIso: () => Effect.sync(() => new Date().toISOString()) }));
        personas.set(accountId, result.persona_id);
        return result.persona_id;
      };
      const person = (accountId: string) => { const value = personas.get(accountId); if (value === undefined) throw new Error("Genuine activity persona is unavailable"); return value; };
      for (const accountId of people.slice(0, 3)) await prepare(accountId);
      await f.admin.query(`GRANT INSERT ON megapot_pool_shares TO ${q(f.role)},PUBLIC; GRANT INSERT(account_id) ON megapot_pool_shares TO ${q(f.role)},PUBLIC; GRANT EXECUTE ON FUNCTION list_guest_practice_participations_v1(jsonb,text,integer) TO ${q(f.role)}`);
      const initialNow = Date.now();
      const observe = async (drawingId: bigint, seconds: number) => {
        const now = Date.now();
        const result = await run(makeControlPlaneMegapotDrawingObservationStore(adminRuntime).recordAndOpen({ observationId: `retained-drawing-${drawingId}`, attestationId: "megapot-base-sepolia-v2", chainId: 84532, drawingId, grossPrizePoolAtomic: 1001n, globalTicketsBought: 1n, ticketPriceAtomic: 10000n, drawingTime: new Date(now + seconds * 1000).toISOString(), ballMax: 25, bonusballMax: 13, drawingLocked: false, referralFeeWei: 100000000000000000n, referralWinShareWei: 100000000000000000n, blockNumber: 1000n + (drawingId - 101n) * 1000n, blockHash: bytes32("a"), blockTimestamp: new Date(now - 1000).toISOString(), confirmations: 3, observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 7200000).toISOString(), rawStateHash: repeatedHash("a"), legacyRawStateHash: repeatedHash("b") }));
        expect(result.openedPoolLegIds).toEqual([leg.legId]);
        const row = (await f.admin.query<{ cutoff: Date }>("SELECT entry_cutoff_at AS cutoff FROM megapot_pool_drawings WHERE pool_leg_id=$1 AND drawing_id=$2", [leg.legId, drawingId.toString()])).rows[0];
        if (row === undefined) throw new Error("Actual original drawing is unavailable");
        return row.cutoff.getTime();
      };
      let freezeAt = initialNow;
      const cutoff = makeMegapotCutoffCoordinator({ store: makeControlPlaneMegapotCutoffStore(adminRuntime), now: () => freezeAt, externalSponsorDailyTicketCeiling: 10, externalSponsorDailySpendCeilingAtomic: 1000000n, sharedSponsorDailyTicketCeiling: 10, sharedSponsorDailySpendCeilingAtomic: 1000000n });
      const firstCutoff = await observe(101n, 600);
      freezeAt = firstCutoff + 1;
      for (const accountId of people.slice(0, 2)) await accountStudy(f, accountId, person(accountId))(`session:${accountId}`);
      expect((await f.admin.query("SELECT count(*)::INTEGER AS count FROM megapot_pool_shares WHERE pool_leg_id=$1 AND drawing_id=101", [leg.legId])).rows).toEqual([{ count: 2 }]);
      const frozen = await run(cutoff.freezeDue());
      expect(frozen).toHaveLength(1);
      expect(frozen[0]).toMatchObject({ status: "cutoff_frozen", frozenShareCount: 2, fallback: false });
      const frozenDrawing = frozen[0];
      if (frozenDrawing === undefined || frozenDrawing.snapshotId === null) throw new Error("Actual frozen snapshot is unavailable");
      const leaves = (await f.admin.query<{ account_id: string }>("SELECT account_id FROM megapot_pool_snapshot_private_leaves WHERE snapshot_id=$1 ORDER BY ordinal", [frozenDrawing.snapshotId])).rows;
      const paidAccount = leaves[0]?.account_id;
      const heldAccount = leaves[1]?.account_id;
      if (paidAccount === undefined || heldAccount === undefined) throw new Error("Original two beneficiaries are required");
      const subjectDigest = hash("retained-v2-original-claim-subject");
      await seedVeryRewardEvidence(f.admin, paidAccount, "retained-first", subjectDigest);
      await confirmWallet(adminRuntime)(paidAccount, person(paidAccount));
      const commitment = makeMegapotCommitmentCoordinator({ store: makeControlPlaneMegapotCommitmentStore(adminRuntime), authority: { ensure: () => Effect.void }, now: () => firstCutoff + 1000, signer: { sign: async () => ({ signingKeyId: "isolated-fixture", signature: "isolated-fixture-signature" }) }, publisher: { publish: async () => ({ publicReference: "urn:test:disabled-v2-retained", publishedAt: new Date(firstCutoff + 2000).toISOString() }) } });
      await run(commitment.commit({ poolLegId: leg.legId, drawingId: 101n }));
      const claim = async (creditId: string, accountId: string) => {
        const row = (await f.admin.query<{ outcome: string; claim_status: string | null }>("SELECT outcome,claim_status FROM accept_megapot_participant_claim_v1($1,$2)", [creditId, accountId])).rows[0];
        if (row === undefined) throw new Error("Actual claim result is unavailable");
        return row;
      };
      const chain = await completeComposedWinningChain({ scopedConnection: adminUrl.toString(), poolLegId: leg.legId, drawingId: 101n, settlementAtMs: firstCutoff + 3000, expectedAllocationsAtomic: [451n, 450n], claim: async ({ creditId, accountId }) => { const result = await claim(creditId, accountId); expect(result.outcome).toBe(accountId === paidAccount ? "accepted" : "verification_missing"); return result.outcome === "accepted"; } });
      expect(chain.payoutEffectIds).toHaveLength(1);
      const heldCredit = chain.heldCreditIds[0];
      if (heldCredit === undefined) throw new Error("Genuine held positive credit is required");
      await seedVeryRewardEvidence(f.admin, heldAccount, "retained-recovered", subjectDigest, "current", { subject: "retained-first", previous: "retained-first", epoch: 2 });
      expect(await claim(heldCredit, heldAccount)).toEqual({ outcome: "subject_conflict", claim_status: "subject_conflict" });
      await expect(run(makeControlPlaneRewardPayoutStore(adminRuntime).loadCandidate(heldCredit))).rejects.toMatchObject({ reason: "credit-not-payable" });
      const emptyCutoff = await observe(102n, 1200);
      freezeAt = emptyCutoff + 1;
      const empty = await run(cutoff.freezeDue());
      expect(empty).toHaveLength(1);
      expect(empty[0]).toMatchObject({ status: "closed_no_entries", frozenShareCount: 0 });
      const openCutoff = await observe(103n, 3600);
      await accountStudy(f, people[2], person(people[2]))("session:retained-open");
      expect(openCutoff).toBeGreaterThan(freezeAt);
      const before = await fingerprint(f);
      const projections = makeControlPlaneRewardProjectionStore(adminRuntime);
      const beforePublic = await run(projections.listCredits({ accountId: heldAccount, cursor: null, limit: 10 }));
      expect(beforePublic.items).toHaveLength(1);
      await runPostgresMigrations({ connectionString: adminUrl.toString(), migrations: packet, expectedLedger: original });
      expect((await f.admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows).toEqual(packet.map(({ version, checksum }) => ({ version, checksum })));
      expect(await fingerprint(f)).toEqual(before);
      expect(await run(projections.listCredits({ accountId: heldAccount, cursor: null, limit: 10 }))).toEqual(beforePublic);
      await nativeBoundaries(f);
      expect((await f.serving.query("SELECT has_function_privilege(current_user,'list_guest_practice_participations_v1(jsonb,text,integer)','EXECUTE') AS allowed")).rows).toEqual([{ allowed: true }]);
      const originalHeld = (await f.admin.query("SELECT credit_id,account_id,payout_persona_id,amount_atomic::TEXT,paid_atomic::TEXT,state,identity_version,participation_owner_id FROM reward_ledger_credits WHERE credit_id=$1", [heldCredit])).rows;
      expect(originalHeld).toEqual([{ credit_id: heldCredit, account_id: heldAccount, payout_persona_id: person(heldAccount), amount_atomic: "450", paid_atomic: "0", state: "credited", identity_version: "account_v1", participation_owner_id: null }]);
      const originalClaim = (await f.admin.query("SELECT to_jsonb(claim)-'updated_at' AS original FROM megapot_participant_claims claim WHERE credit_id=$1", [heldCredit])).rows;
      expect(await claim(heldCredit, heldAccount)).toEqual({ outcome: "subject_conflict", claim_status: "subject_conflict" });
      // Existing203 conflict replay updates only its audit timestamp; it must
      // preserve every original right/source/subject field and held credit.
      expect((await f.admin.query("SELECT to_jsonb(claim)-'updated_at' AS original FROM megapot_participant_claims claim WHERE credit_id=$1", [heldCredit])).rows).toEqual(originalClaim);
      await expect(f.admin.query("UPDATE megapot_pool_drawings SET beneficiary_version=3 WHERE pool_leg_id=$1 AND drawing_id=101", [leg.legId])).rejects.toMatchObject({ code: "GP003" });
      await expect(f.admin.query("UPDATE megapot_pool_beneficiary_snapshots SET beneficiary_version=3 WHERE pool_leg_id=$1 AND drawing_id=101", [leg.legId])).rejects.toMatchObject({ code: "GP003" });
      await expect(f.admin.query("UPDATE megapot_allocation_batches SET beneficiary_version=3 WHERE pool_leg_id=$1 AND drawing_id=101", [leg.legId])).rejects.toMatchObject({ code: "GP003" });
      await expect(f.admin.query("UPDATE reward_ledger_credits SET identity_version='owner_v1',participation_owner_id=(SELECT owner_id FROM participation_owners WHERE kind='account' AND account_id=$2) WHERE credit_id=$1", [heldCredit, heldAccount])).rejects.toMatchObject({ code: "GP003" });
      expect((await f.admin.query("SELECT credit_id,account_id,payout_persona_id,amount_atomic::TEXT,paid_atomic::TEXT,state,identity_version,participation_owner_id FROM reward_ledger_credits WHERE credit_id=$1", [heldCredit])).rows).toEqual(originalHeld);
      await prepare(people[3]);
      await accountStudy(f, people[3], person(people[3]))("session:retained-after");
      expect((await f.admin.query("SELECT account_id,beneficiary_version FROM megapot_pool_shares WHERE pool_leg_id=$1 AND drawing_id=103 ORDER BY account_id", [leg.legId])).rows).toEqual([{ account_id: people[3], beneficiary_version: 2 }, { account_id: people[2], beneficiary_version: 2 }]);
      expect((await f.admin.query("SELECT count(*)::INTEGER AS count FROM megapot_pool_shares WHERE pool_leg_id=$1 AND drawing_id=101", [leg.legId])).rows).toEqual([{ count: 2 }]);
      await nativeBoundaries(f);
      const after = await fingerprint(f);
      for (const table of retainedTables) if (!["megapot_pool_shares", "reward_eligibility_decisions", "megapot_participant_claims", "study_sessions_v2", "study_spoken_answer_commands", "learner_audio_artifacts", "learner_audio_account_spoken_checkpoints", "learner_audio_upload_terminal_facts", "learner_audio_account_provider_calls"].includes(table)) expect(after[table]).toEqual(before[table]);
    });
  }, 180000);
});

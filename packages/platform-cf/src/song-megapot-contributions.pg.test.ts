/** SOURCE ONLY: parent owns fresh isolated PG execution. Never import this
 * module into an ordinary/offline suite. Toy policy/objective/observer facts
 * below are fixture inputs, not accepted CP2 or production financial policy. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";
import {
  ControlPlaneDb,
  ControlPlaneOperationTimedOut,
  ControlPlaneStatementFailed,
  ControlPlaneTransactionOutcomeUnknown,
} from "../../application/src/ports.ts";
import {
  digestFundingPreimageV2,
  FundingRefusalPacket,
  makeSongMegapotContributions,
  SongContributionFailure,
} from "../../application/src/rewards/song-megapot-contributions.ts";
import * as C from "../../contracts/src/rewards-song-contributions-v2.ts";
import type { MegapotV2FullRpcClient } from "./megapot-v2-rpc.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import type { FundingPrincipalEvidence } from "./reward-funding-receipt-discovery.ts";
import {
  makeCurrentFundingRecoveryEvidence,
  recoveryEvidencePreimage,
} from "./reward-funding-receipt-discovery.ts";
import {
  makeControlPlaneSongContributionPorts,
  makeControlPlaneSongFundingRecoveryStore,
  persistRewardFundingPrincipalIn,
} from "./song-megapot-contribution-repository.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("Test URL required");
const suite = url ? describe : describe.skip;
const schema = `contributions_v2_${process.pid}_${Date.now()}`;
const scoped = () => {
  if (!url) throw new Error("Test URL required");
  const u = new URL(url);
  u.searchParams.set("options", `-c search_path=${schema}`);
  return u.toString();
};
const h = "a".repeat(64),
  token = `0x${"22".repeat(20)}`,
  custody = `0x${"33".repeat(20)}`;
const sender = (a: string) => `0x${(a === "a" ? "11" : "44").repeat(20)}`;
const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const digest = (s: string) => Effect.runPromise(digestFundingPreimageV2(s));
const base = { communityId: "community", postId: "post", contributionId: null };
suite(
  "CP3 contribution persistence and CP4 incoming categories (SOURCE ONLY until parent admission)",
  () => {
    const admin = new Client({ connectionString: url });
    let terms: C.TermsV2;
    let target: C.CommittedTargetV2;
    let start: number;
    const layer = () => makeDirectPostgresControlPlaneLayer(scoped());
    const service = (a: string) =>
      makeSongMegapotContributions(
        makeControlPlaneSongContributionPorts(
          layer(),
          {
            authorize: () => Effect.succeed({ accountId: a }),
          },
          { rewardsEnabled: true },
        ),
      );
    beforeAll(async () => {
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
      // Remains a genuine277->278 upgrade even after maintained baseline growth.
      // Parent first binds candidate checksums/ordinals; no unregistered loader bypass.
      const migrations = await loadPostgresMigrations();
      const boundary =
        migrations.findIndex((m) => m.version === "0277_reward_wallet_nonce_authority_v2.sql") + 1;
      if (boundary !== 277) throw new Error("Expected exact maintained277 prefix");
      const prefix = await runPostgresMigrations({
        connectionString: scoped(),
        migrations: migrations.slice(0, boundary),
        expectedLedger: [],
      });
      if (prefix.dryRun) throw new Error("Expected actual isolated migration prefix");
      expect(prefix.result.currentVersion).toBe("0277_reward_wallet_nonce_authority_v2.sql");
      for (const file of [
        "0278_song_megapot_contributions_v2.sql",
        "0279_reward_principal_seals_v2.sql",
        "0280_reward_contribution_privileges_v2.sql",
        // Focused CP3 successor-body proof, not the complete production upgrade.
        "0294_song_contribution_refusals.sql",
      ])
        await admin.query(
          await Bun.file(
            new URL(`../../../db/postgres/migrations/${file}`, import.meta.url),
          ).text(),
        );
      start = Date.now();
      const iso = (n: number) => new Date(start + n).toISOString();
      target = {
        kind: "committed",
        community_id: "community",
        post_id: "post",
        canonical_song_id: "song",
        audio_revision: 1,
        offer_id: "offer",
        pool_leg_id: "leg",
      };
      const bindings = ["study", "karaoke", "dance"].map((activity) => ({
        template_key: `template-${activity}`,
        activity,
        grading_family: activity === "dance" ? "moderator_verdict" : "numeric",
        qualification_policy_id: `policy-${activity}`,
        qualification_policy_hash: h,
        numeric_floor_bps: activity === "dance" ? null : 7000,
        choreography_scope: activity === "dance" ? "any_policy_accepted" : "not_applicable",
        admission_id: `admission-${activity}`,
        admission_hash: h,
        disclosure_version: "fixture",
        binding_id: `binding-${activity}`,
        objective_id: `objective-${activity}`,
        offer_id: "offer",
        leg_id: "leg",
      }));
      const bindingHash = await digest(
        C.fundingHashPreimageV2(
          "pirate.shared-song-qualification-bindings.v1",
          bindings.map((b) =>
            C.projectQualificationBinding(Schema.decodeUnknownSync(C.QualificationBindingV2)(b)),
          ),
        ),
      );
      terms = Schema.decodeUnknownSync(C.TermsV2)({
        version: "shared-song-megapot-v2",
        profile_id: "profile",
        profile_hash: h,
        terms_hash: h,
        funding_policy_revision: 1,
        funding_policy_hash: h,
        budget_source: "leg_budget",
        empty_behavior: "no_purchase",
        eligible_activities: ["study", "karaoke", "dance"],
        dance_scope: "any_policy_accepted",
        starts_at: iso(-60_000),
        ends_at: iso(21_600_000),
        first_drawing_id: "101",
        last_planned_drawing_id: "106",
        ticket_price_ceiling_atomic: "1000000",
        disclosure_version: "fixture",
        origin_prospective_terms_hash: h,
        origin_slot_generation: 0,
        reward_policy_hash: h,
        qualification_bindings: bindings,
        qualification_bindings_hash: bindingHash,
        planned_drawing_ids: ["101", "102", "103", "104", "105", "106"],
        planned_schedule_hash: h,
      });
      terms = { ...terms, terms_hash: await digest(C.committedTermsPreimageV2(terms)) };
      await admin.query("BEGIN; SET LOCAL session_replication_role=replica");
      try {
        for (const [index, a] of ["a", "b"].entries()) {
          await admin.query("INSERT INTO users(user_id) VALUES($1)", [a]);
          await admin.query("INSERT INTO personas(persona_id,account_id) VALUES($1,$2)", [
            `persona-${a}`,
            a,
          ]);
          await admin.query(
            "INSERT INTO persona_wallet_assignments(assignment_id,persona_id,account_id,chain_account_kind,hd_wallet_index,address,status,reservation_idempotency_key,assigned_at,created_at,updated_at) VALUES($1,$2,$3,'evm',$4,$5,'active',$1,now(),now(),now())",
            [`wallet-${a}`, `persona-${a}`, a, index, sender(a)],
          );
          await admin.query(
            "INSERT INTO persona_community_bindings(persona_id,account_id,community_id,binding_source) VALUES($1,$2,'community','activity_participation')",
            [`persona-${a}`, a],
          );
        }
        await admin.query("SET LOCAL session_replication_role=origin; COMMIT");
      } catch (e) {
        await admin.query("ROLLBACK");
        throw e;
      }
      await admin.query(
        "SELECT set_reward_operations_paused_v1(revision,FALSE,'isolated_cp3_fixture') FROM reward_operations_control WHERE singleton",
      );
      const policy = {
        reconciliation: {
          maxAttempts: 3,
          leaseMs: 60_000,
          maximumBlocks: 10,
          maximumLogs: 5,
          receipt: {
            policyHash: h,
            requiredConfirmations: 1,
            maximumClockSkewMs: 1000,
            maximumObservationAgeMs: 120_000,
          },
        },
        maxActiveAccount: 4,
        maxActiveAccountLeg: 4,
        maxLegLiabilities: 10,
        maxAdmittedLeg: 10,
        maxAdmittedAccountLeg: 10,
        workPerInstruction: 10,
        economicsPolicyHash: h,
        gasPolicyHash: h,
        custodyPolicyHash: h,
      };
      let recoveryPolicy = Schema.decodeUnknownSync(C.CancellationRecoveryPolicyV2)({
        object: "nonce_cancellation_recovery_policy",
        version: "nonce-cancellation-recovery-v1",
        policy_id: "fixture-recovery",
        policy_hash: h,
        chain_id: 84532,
        valid_from: iso(-60_000),
        valid_until: iso(86_400_000),
        dispatch_ttl_seconds: 180,
        max_preparations_per_contribution: 2,
        fee_policy_id: "fixture-fee",
        fee_policy_hash: h,
        attestation_contract_version: "megapot-v2-current-recovery-v1",
      });
      recoveryPolicy = {
        ...recoveryPolicy,
        policy_hash: await digest(C.cancellationPolicyPreimageV2(recoveryPolicy)),
      };
      await admin.query(
        "INSERT INTO megapot_deployment_attestations(attestation_id,environment,chain_id,jackpot_address,usdc_address,ticket_nft_address,custody_address,referrer_address,source_tag,jackpot_code_hash,usdc_code_hash,ticket_nft_code_hash,attestation_block_number,attestation_block_hash,abi_version,status,verified_at) VALUES('attestation','test',84532,$1,$2,$3,$4,$5,$6,$6,$6,$6,1,$6,'megapot_v2','active',$7)",
        [
          `0x${"55".repeat(20)}`,
          token,
          `0x${"66".repeat(20)}`,
          custody,
          `0x${"77".repeat(20)}`,
          `0x${h}`,
          iso(-60_000),
        ],
      );
      const capacity = {
        maxDrawings: 6,
        reservationMs: 60_000,
        safetyMarginMs: 1_000,
        maximumWitnessAgeMs: 120_000,
        validUntil: start + 86_400_000,
        attestationValidUntil: start + 86_400_000,
        priceCeilingAtomic: "1000000",
        minimumAtomic: "1000000",
      };
      await admin.query(
        "INSERT INTO reward_funding_profiles_v2(profile_id,profile_hash,accepted,valid_until,policy,capacity_profile,nonce_policy,recovery_policy) VALUES('profile',$1,TRUE,$2,$3,$4,$5,$6)",
        [
          h,
          iso(86_400_000),
          json(policy),
          json(capacity),
          json({ hash: h, maxAgeMs: 120_000 }),
          json(recoveryPolicy),
        ],
      );
      await admin.query(
        "INSERT INTO reward_song_slots_v2(slot_id,community_id,post_id,generation,target,terms,reward_policy_ready,status) VALUES('slot','community','post',1,$1,$2,TRUE,'open')",
        [json(target), json(terms)],
      );
      for (const [scope, key] of [
        ["account", "a"],
        ["account", "b"],
        ["leg", "leg"],
        ["global", "funding"],
      ])
        await admin.query(
          "INSERT INTO reward_funding_work_envelopes_v2 VALUES($1,$2,$3,'profile',NULL,100,0,0,$4,NULL)",
          [`${scope}:${key}`, scope, key, iso(86_400_000)],
        );
    }, 120_000);
    afterAll(async () => {
      if (!url) return;
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    });
    async function request(a: string, key: string, nonce = "4") {
      const now = Date.now();
      const iso = (n: number) => new Date(now + n).toISOString();
      const id = `${a}:${key}`;
      const actor: C.OwnedActorV2 = {
        account_id: a,
        community_id: "community",
        persona_id: `persona-${a}`,
        wallet_assignment_id: `wallet-${a}`,
        wallet_index: a === "a" ? 0 : 1,
        sender_address: sender(a),
      };
      const schedule: C.ScheduleWitnessV2 = {
        schedule_witness_id: id,
        version: "song-megapot-schedule-v1",
        rule_id: "fixture-initialized-rows",
        contract_code_hash: h,
        cadence_seconds: "3600",
        rule_hash: h,
        price_rule_hash: h,
        valid_until: iso(120_000),
        anchor: {
          chain_id: 84532,
          finality_policy_id: "fixture-finality",
          attestation_id: "attestation",
          block_number: "20",
          block_hash: `0x${h}`,
          block_timestamp: iso(-1_000),
          observed_at: iso(0),
          attestation_hash: h,
        },
        rows: terms.planned_drawing_ids.map((drawing_id, index) => ({
          drawing_id,
          drawing_time: new Date(start + (index + 1) * 3_600_000).toISOString(),
          entry_cutoff_at: new Date(start + (index + 1) * 3_600_000 - 60_000).toISOString(),
          purchase_deadline_at: new Date(start + (index + 1) * 3_600_000 - 30_000).toISOString(),
          price_atomic: "1000000",
          price_ceiling_atomic: "1000000",
          initialized: true,
          proof_kind: "initialized_state",
        })),
      };
      let c = Schema.decodeUnknownSync(C.ContextReadyV2)({
        object: "song_megapot_funding_context",
        version: 2,
        readiness: "ready",
        context_hash: h,
        context_expires_at: iso(60_000),
        lifecycle_revision: 0,
        target,
        actor,
        schedule,
        limits: {
          profile_id: "profile",
          minimum_atomic: "1000000",
          maximum_atomic: "6000000",
          usable_capacity_atomic: "6000000",
          capacity_revision: 0,
          max_admitted_effects_per_leg: 10,
          remaining_effect_slots: 10,
          account_pending_slots_available: 4,
          fee_policy_id: "fixture-fee",
          reservation_ttl_seconds: 60,
          latest_allocation_at: iso(60_000),
          reservation_deadline_upper_bound: iso(121_000),
        },
        chain_id: 84532,
        token_address: token,
        custody_address: custody,
        attestation_id: "attestation",
        fees: {
          inbound_payer: "selected_persona_wallet",
          outbound_policy_id: "fixture-fee",
          gas_ready: true,
        },
        context_ref: {
          version: "funding-context-reference-v1",
          slot_id: "slot",
          slot_generation: 1,
          leg_snapshot_id: id,
          schedule_witness_id: id,
          profile_id: "profile",
          profile_hash: h,
          funding_policy_hash: h,
          wallet_assignment_id: `wallet-${a}`,
          wallet_assignment_revision: 1,
          lifecycle_revision: 0,
        },
        quote: {
          kind: "committed",
          committed_terms: terms,
          committed_terms_hash: terms.terms_hash,
        },
        submission_protocol: "single_fresh_delivery_v1",
      });
      const keys = [
        "profile_id",
        "minimum_atomic",
        "maximum_atomic",
        "usable_capacity_atomic",
        "capacity_revision",
        "max_admitted_effects_per_leg",
        "fee_policy_id",
        "reservation_ttl_seconds",
        "latest_allocation_at",
        "reservation_deadline_upper_bound",
      ] as const;
      c = {
        ...c,
        context_hash: await digest(
          C.fundingHashPreimageV2("pirate.song-megapot-funding-context.v2", [
            C.projectContextReference(c.context_ref),
            C.projectTarget(c.target),
            C.projectOwnedActor(c.actor),
            c.chain_id,
            c.token_address,
            c.custody_address,
            c.attestation_id,
            c.quote.kind,
            terms.terms_hash,
            keys.map((k) => [k, c.limits[k]]),
            c.context_expires_at,
          ]),
        ),
      };
      const witnessed = {
        observedAt: now,
        validUntil: now + 120_000,
        ruleHash: h,
        priceRuleHash: h,
        recurrenceProven: false,
        rows: schedule.rows.map((r) => ({
          id: r.drawing_id,
          drawingTime: Date.parse(r.drawing_time),
          entryCutoff: Date.parse(r.entry_cutoff_at),
          purchaseDeadline: Date.parse(r.purchase_deadline_at),
          priceAtomic: r.price_atomic,
          proof: r.proof_kind,
          state: "uncommitted",
          reservedCostAtomic: "0",
        })),
      };
      const nonceWitness = {
        // Distinct chain observations/reservations have distinct valid witness
        // identities. Exact command replay reuses this original body/snapshot.
        id: await digest(
          C.fundingHashPreimageV2("fixture.nonce-witness.v2", [id, a, nonce, now, h]),
        ),
        chainId: 84532,
        senderAddress: sender(a),
        observedAtMs: now,
        confirmed: { nonce, blockNumber: "20", blockHash: h },
        pending: { nonce, baseBlockNumber: "20", baseBlockHash: h },
      };
      const funded = (
        await admin.query(
          "SELECT coalesce(sum(amount_atomic),0)::text AS n FROM reward_incoming_receipts_v2 WHERE category='pool_principal'",
        )
      ).rows[0].n;
      await admin.query(
        "INSERT INTO reward_funding_schedule_witnesses_v2(witness_id,profile_id,witness_hash,schedule,nonce_witness,valid_until) VALUES($1,'profile',$2,$3,$4,$5)",
        [id, h, json(witnessed), json(nonceWitness), iso(120_000)],
      );
      await admin.query(
        "INSERT INTO reward_funding_leg_snapshots_v2(snapshot_id,slot_id,profile_id,witness_id,context_hash,context,budget,costs_reconciled,recovery_authority) VALUES($1,'slot','profile',$1,$2,$3,$4,TRUE,$5)",
        [
          id,
          c.context_hash,
          json(c),
          json({
            funded,
            spent: "0",
            committedPurchases: "0",
            refunded: "0",
            otherObligations: "0",
            liveInboundReservations: "0",
          }),
          json({
            policy: null,
            attestationId: "attestation",
            attestationHash: h,
            attestationValidUntil: iso(86_400_000),
            originalWalletStillOwned: true,
            currentSigningRefusal: null,
            boundedWorkAvailable: true,
          }),
        ],
      );
      return {
        version: 2,
        idempotency_key: key,
        persona_id: `persona-${a}`,
        funding_amount_atomic: "2000000",
        expected_context_hash: c.context_hash,
        expected_lifecycle_revision: 0,
        context_version: c.context_ref.version,
        context_slot_id: c.context_ref.slot_id,
        context_slot_generation: c.context_ref.slot_generation,
        context_leg_snapshot_id: c.context_ref.leg_snapshot_id ?? "",
        context_schedule_witness_id: c.context_ref.schedule_witness_id,
        context_profile_id: c.context_ref.profile_id,
        context_profile_hash: c.context_ref.profile_hash,
        context_funding_policy_hash: c.context_ref.funding_policy_hash,
        context_wallet_assignment_id: c.context_ref.wallet_assignment_id,
        context_wallet_assignment_revision: c.context_ref.wallet_assignment_revision,
        context_lifecycle_revision: c.context_ref.lifecycle_revision,
        expected_terms_kind: "committed",
        expected_terms_hash: terms.terms_hash,
      };
    }
    let receipt: C.ContributionReceiptV2;
    test("a late SQL refusal rolls back nonce, slot, counter, reservation and work writes before committing proof", async () => {
      const key = "late_refusal_original_01";
      const body = await request("a", key);
      const tables = [
        "song_megapot_contributions_v2",
        "reward_contribution_reservations_v2",
        "reward_funding_account_counters_v2",
        "reward_funding_work_envelopes_v2",
        "reward_song_slots_v2",
        "song_reward_offers",
        "song_reward_offer_legs",
        ...(
          await admin.query(
            "SELECT relname FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relkind IN('r','p') AND relname LIKE 'reward_wallet_nonce%' ORDER BY relname",
          )
        ).rows.map((row: { relname: string }) => row.relname),
      ];
      const snapshots = async () => {
        const result: Record<string, unknown> = {};
        for (const table of tables) {
          const quoted = `"${table.replaceAll('"', '""')}"`;
          result[table] = (
            await admin.query(
              `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${quoted} t`,
            )
          ).rows[0].rows;
        }
        return result;
      };
      const before = await snapshots();
      await admin.query(`CREATE FUNCTION refuse_late_create_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.idempotency_key='${key}' AND NEW.refusal_code IS NULL THEN
          RAISE EXCEPTION 'late fixture refusal' USING ERRCODE='PCV05';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER refuse_late_create_fixture BEFORE INSERT ON song_megapot_contribution_commands_v2
        FOR EACH ROW EXECUTE FUNCTION refuse_late_create_fixture()`);
      try {
        await expect(
          Effect.runPromise(service("a").execute("CreateSongMegapotContributionV2", base, body)),
        ).rejects.toMatchObject({
          code: "policy_unavailable",
          refusalReceipt: { allocation: "none", instruction_issued: false },
        });
        expect(await snapshots()).toEqual(before);
        const rows = (
          await admin.query(
            "SELECT refusal_code,contribution_id,receipt FROM song_megapot_contribution_commands_v2 WHERE account_id='a' AND idempotency_key=$1",
            [key],
          )
        ).rows;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          refusal_code: "policy_unavailable",
          contribution_id: null,
          receipt: { allocation: "none", instruction_issued: false },
        });
        await expect(
          Effect.runPromise(service("a").execute("CreateSongMegapotContributionV2", base, body)),
        ).rejects.toMatchObject({ code: "policy_unavailable", refusalReceipt: rows[0].receipt });
        await expect(
          Effect.runPromise(
            service("a").execute("CreateSongMegapotContributionV2", base, {
              ...body,
              funding_amount_atomic: "1000000",
            }),
          ),
        ).rejects.toMatchObject({ code: "idempotency_conflict" });
        expect(await snapshots()).toEqual(before);
      } finally {
        await admin.query(
          "DROP TRIGGER refuse_late_create_fixture ON song_megapot_contribution_commands_v2; DROP FUNCTION refuse_late_create_fixture()",
        );
      }
    });
    test("real app/SQL creation, same-key races, private replay and account/work reservations", async () => {
      const body = await request("a", "first_contribution_key_01");
      const [a, b] = await Promise.all([
        Effect.runPromise(service("a").execute("CreateSongMegapotContributionV2", base, body)),
        Effect.runPromise(service("a").execute("CreateSongMegapotContributionV2", base, body)),
      ]);
      expect(a).toEqual(b);
      receipt = Schema.decodeUnknownSync(C.ContributionReceiptV2)(a);
      expect(
        (await admin.query("SELECT count(*)::int AS n FROM song_megapot_contributions_v2")).rows[0]
          .n,
      ).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT active FROM reward_funding_account_counters_v2 WHERE account_id='a' AND scope_leg='' ",
          )
        ).rows[0].active,
      ).toBe("1");
      expect(
        (
          await admin.query(
            "SELECT reserved FROM reward_funding_work_envelopes_v2 WHERE scope='global'",
          )
        ).rows[0].reserved,
      ).toBe("10");
      await expect(
        Effect.runPromise(
          service("a").execute("CreateSongMegapotContributionV2", base, {
            ...body,
            funding_amount_atomic: "1000000",
          }),
        ),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(
        await Effect.runPromise(
          service("a").execute("CreateSongMegapotContributionV2", base, body),
        ),
      ).toEqual(a);
    });
    test("one durable purpose grant survives lost-response replay and competing new keys", async () => {
      const scope = { ...base, contributionId: receipt.contribution_id };
      const body = {
        idempotency_key: "grant_key_00000001",
        client_instance_id: "client_instance_a_0001",
        submission_attempt_id: "submission_attempt_a_0001",
        purpose: "funding_transfer",
        expected_state_revision: 0,
        instruction_hash: receipt.instruction.instruction_hash,
      };
      const first = await Effect.runPromise(
        service("a").execute("ClaimSongMegapotContributionSubmissionV2", scope, body),
      );
      expect(first).toMatchObject({ delivery: { kind: "fresh_grant" } });
      await admin.query(
        "SELECT set_reward_operations_paused_v1(revision,TRUE,'fixture_pause') FROM reward_operations_control WHERE singleton",
      );
      expect(
        await Effect.runPromise(
          service("a").execute("ClaimSongMegapotContributionSubmissionV2", scope, body),
        ),
      ).toMatchObject({ delivery: { kind: "recovery_only" } });
      await expect(
        Effect.runPromise(
          service("a").execute("ClaimSongMegapotContributionSubmissionV2", scope, {
            ...body,
            idempotency_key: "grant_key_00000002",
          }),
        ),
      ).rejects.toMatchObject({ code: "submission_already_claimed" });
      expect(
        (await admin.query("SELECT count(*)::int AS n FROM reward_funding_submission_claims_v2"))
          .rows[0].n,
      ).toBe(1);
      await admin.query(
        "SELECT set_reward_operations_paused_v1(revision,FALSE,'fixture_resume') FROM reward_operations_control WHERE singleton",
      );
    });
    test("snapshot future validity cannot authorize cancellation without current evidence", async () => {
      const before = (
        await admin.query(
          "SELECT state FROM song_megapot_contributions_v2 WHERE contribution_id=$1",
          [receipt.contribution_id],
        )
      ).rows[0].state;
      const scope = { ...base, contributionId: receipt.contribution_id };
      await expect(
        Effect.runPromise(
          service("a").execute("PrepareSongMegapotContributionCancellationV2", scope, {
            idempotency_key: "missing_current_evidence_01",
            expected_state_revision: before.revision,
            purpose: "cancel_original_nonce",
          }),
        ),
      ).rejects.toMatchObject({ code: "cancellation_recovery_unavailable" });
      expect(
        (
          await admin.query(
            "SELECT state FROM song_megapot_contributions_v2 WHERE contribution_id=$1",
            [receipt.contribution_id],
          )
        ).rows[0].state,
      ).toEqual(before);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM reward_funding_submission_claims_v2 WHERE purpose='nonce_cancellation'",
          )
        ).rows[0].n,
      ).toBe(0);
    });
    test("recovery replay keeps the receipt work identity and charges exactly once", async () => {
      const before = (
        await admin.query(
          "SELECT used,reserved FROM reward_funding_work_envelopes_v2 WHERE scope='global'",
        )
      ).rows[0];
      const body = {
        idempotency_key: "recover_queued_work_key_01",
        expected_state_revision: 1,
        purpose: "reconcile_original",
      };
      const scope = { ...base, contributionId: receipt.contribution_id };
      const [first, raced] = await Promise.all([
        Effect.runPromise(service("a").execute("RecoverSongMegapotContributionV2", scope, body)),
        Effect.runPromise(service("a").execute("RecoverSongMegapotContributionV2", scope, body)),
      ]);
      expect(first).toEqual(raced);
      expect(
        await Effect.runPromise(
          service("a").execute("RecoverSongMegapotContributionV2", scope, body),
        ),
      ).toEqual(first);
      const r = Schema.decodeUnknownSync(C.RecoveryReceiptV2)(first);
      expect(
        (
          await admin.query(
            "SELECT work_id,scope_key FROM reward_funding_work_envelopes_v2 WHERE scope='reconciliation'",
          )
        ).rows,
      ).toEqual([{ work_id: r.work_item_id, scope_key: r.command_id }]);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM song_megapot_contribution_commands_v2 WHERE receipt->>'command_id'=$1",
            [r.command_id],
          )
        ).rows[0].n,
      ).toBe(1);
      const after = (
        await admin.query(
          "SELECT used,reserved FROM reward_funding_work_envelopes_v2 WHERE scope='global'",
        )
      ).rows[0];
      expect(BigInt(after.used) - BigInt(before.used)).toBe(1n);
      expect(BigInt(before.reserved) - BigInt(after.reserved)).toBe(1n);
    });
    test("immutable evidence refuses updates/truncation and zero principal", async () => {
      await expect(
        admin.query("UPDATE song_megapot_contribution_commands_v2 SET request_hash=$1", [
          "b".repeat(64),
        ]),
      ).rejects.toMatchObject({ code: "PCV01" });
      await expect(
        admin.query("TRUNCATE reward_incoming_receipts_v2 CASCADE"),
      ).rejects.toMatchObject({
        code: "PCV01",
      });
      await expect(
        admin.query("UPDATE reward_contribution_reservations_v2 SET amount_atomic=0"),
      ).rejects.toMatchObject({ code: "23514" });
    });
    test("B shares the same pot while A is unresolved; final A receipt permits a fresh A nonce without unsigned proof", async () => {
      const b = Schema.decodeUnknownSync(C.ContributionReceiptV2)(
        await Effect.runPromise(
          service("b").execute(
            "CreateSongMegapotContributionV2",
            base,
            await request("b", "contribution_b_key_01"),
          ),
        ),
      );
      expect(b.target).toEqual(receipt.target);
      expect(b.committed_terms).toEqual(receipt.committed_terms);
      const now = new Date().toISOString();
      const proof: FundingPrincipalEvidence = {
        receiptId: "canonical-receipt-a",
        contributionId: receipt.contribution_id,
        category: "pool_principal" as const,
        evidence: {
          chain_id: 84532,
          transaction_hash: `0x${"12".repeat(32)}`,
          transfer_log_index: 0,
          sender_nonce: receipt.instruction.nonce,
          block_number: "21",
          block_hash: `0x${h}`,
          block_timestamp: receipt.created_at,
          first_observed_at: now,
          finalized_at: now,
          actual_amount_atomic: receipt.instruction.amount_atomic,
          attestation_id: receipt.instruction.attestation_id,
        },
        senderAddress: receipt.instruction.from,
        recipientAddress: custody,
        tokenAddress: token,
        instructionHash: receipt.instruction.instruction_hash,
        attestationHash: receipt.instruction.attestation_hash,
        policyHash: h,
        checkpointBlock: "25",
        checkpointHash: `0x${h}`,
        observedConfirmedNonce: "5",
        exactInstruction: true,
      };
      const principalState = async () =>
        (
          await admin.query(`SELECT jsonb_build_object(
        'receipts',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY receipt_id),'[]'::jsonb) FROM reward_incoming_receipts_v2 x),
        'late',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY receipt_id),'[]'::jsonb) FROM reward_late_principal_liabilities_v2 x),
        'contributions',(SELECT jsonb_agg(to_jsonb(x) ORDER BY contribution_id) FROM song_megapot_contributions_v2 x),
        'leases',(SELECT jsonb_agg(to_jsonb(x) ORDER BY lease_id) FROM reward_wallet_nonce_leases x),
        'reservations',(SELECT jsonb_agg(to_jsonb(x) ORDER BY reservation_id) FROM reward_contribution_reservations_v2 x),
        'counters',(SELECT jsonb_agg(to_jsonb(x) ORDER BY account_id,scope_leg) FROM reward_funding_account_counters_v2 x),
        'work',(SELECT jsonb_agg(to_jsonb(x) ORDER BY work_id) FROM reward_funding_work_envelopes_v2 x)) AS state`)
        ).rows[0].state;
      const unchanged = await principalState();
      for (const [nested, fields] of [
        [false, Object.keys(proof)],
        [true, Object.keys(proof.evidence)],
      ] as const) {
        for (const field of fields)
          for (const variant of ["missing", "null", "wrong_type"]) {
            const invalid = structuredClone(proof);
            const object = (nested ? invalid.evidence : invalid) as Record<string, unknown>;
            if (variant === "missing") delete object[field];
            else
              object[field] =
                variant === "null" ? null : typeof object[field] === "string" ? 1 : "wrong-type";
            // Direct SQL exercises its own null-safe boundary independently of
            // the repository decoder. No incoming/nonce/counter state may move.
            await expect(
              admin.query("SELECT accept_reward_funding_principal_v2($1::jsonb)", [json(invalid)]),
            ).rejects.toMatchObject({ code: "PCV11" });
            expect(await principalState()).toEqual(unchanged);
          }
      }
      const persist = () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const db = yield* ControlPlaneDb;
            return yield* db.withTransaction((tx) => persistRewardFundingPrincipalIn(tx, proof));
          }).pipe(Effect.provide(layer())),
        );
      await persist();
      await persist();
      expect(
        (await admin.query("SELECT count(*)::int AS n FROM reward_incoming_receipts_v2")).rows[0].n,
      ).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT active,admitted FROM reward_funding_account_counters_v2 WHERE account_id='a' AND scope_leg='' ",
          )
        ).rows[0],
      ).toEqual({ active: "0", admitted: "1" });
      const again = Schema.decodeUnknownSync(C.ContributionReceiptV2)(
        await Effect.runPromise(
          service("a").execute(
            "CreateSongMegapotContributionV2",
            base,
            await request("a", "contribution_a_again_01", "5"),
          ),
        ),
      );
      expect(again.instruction.nonce).toBe("5");
      expect(again.funding_effect_id).not.toBe(receipt.funding_effect_id);
      expect(again.committed_terms.ends_at).toBe(receipt.committed_terms.ends_at);
      const witnesses = (
        await admin.query(
          "SELECT witness_id FROM reward_wallet_nonce_leases WHERE source='song_funding_v2' ORDER BY lease_id",
        )
      ).rows.map((r) => r.witness_id);
      expect(witnesses).toHaveLength(3);
      expect(new Set(witnesses).size).toBe(3);
      for (const witness of witnesses) expect(witness).toMatch(/^[a-f0-9]{64}$/u);
    });
    test("accepted uint256 confirmed-nonce evidence is consumable without widening owned nonce history", async () => {
      const before = (
        await admin.query("SELECT state FROM song_megapot_contributions_v2 WHERE account_id='b'")
      ).rows[0].state;
      const b = Schema.decodeUnknownSync(C.ContributionReceiptV2)(before.receipt);
      const workBefore = (
        await admin.query("SELECT * FROM reward_funding_work_envelopes_v2 ORDER BY work_id")
      ).rows;
      const leasesBefore = (
        await admin.query("SELECT * FROM reward_wallet_nonce_leases ORDER BY lease_id")
      ).rows;
      const contextSql =
        "SELECT highest_nonce::text,blocked_reason FROM reward_wallet_nonce_context_v2($1,$2,NULL)";
      const contextArgs = [b.instruction.chain_id, b.instruction.from];
      expect((await admin.query(contextSql, contextArgs)).rows).toEqual([
        { highest_nonce: b.instruction.nonce, blocked_reason: "outstanding_nonce" },
      ]);
      // These are representation vectors, not new allocator limits or policy.
      // Roll back each valid acceptance so the same unresolved B can exercise
      // both sides of signed64 and the accepted uint256 maximum independently.
      for (const observedConfirmedNonce of [
        "9223372036854775807",
        "9223372036854775808",
        ((1n << 256n) - 1n).toString(),
      ]) {
        expect(Schema.decodeUnknownSync(C.UIntV2)(observedConfirmedNonce)).toBe(
          observedConfirmedNonce,
        );
        const now = new Date().toISOString();
        const proof: FundingPrincipalEvidence = {
          receiptId: `nonce-boundary-${observedConfirmedNonce}`,
          contributionId: b.contribution_id,
          category: "pool_principal",
          evidence: {
            chain_id: b.instruction.chain_id,
            transaction_hash: `0x${"56".repeat(32)}`,
            transfer_log_index: 0,
            sender_nonce: b.instruction.nonce,
            block_number: "21",
            block_hash: `0x${h}`,
            block_timestamp: b.created_at,
            first_observed_at: now,
            finalized_at: now,
            actual_amount_atomic: b.instruction.amount_atomic,
            attestation_id: b.instruction.attestation_id,
          },
          senderAddress: b.instruction.from,
          recipientAddress: custody,
          tokenAddress: token,
          instructionHash: b.instruction.instruction_hash,
          attestationHash: b.instruction.attestation_hash,
          policyHash: h,
          checkpointBlock: "25",
          checkpointHash: `0x${h}`,
          observedConfirmedNonce,
          exactInstruction: true,
        };
        await admin.query("BEGIN");
        try {
          const acceptSql = "SELECT accept_reward_funding_principal_v2($1::jsonb) AS packet";
          const accepted = (await admin.query(acceptSql, [json(proof)])).rows[0].packet;
          expect(accepted.category).toBe("pool_principal");
          expect(accepted.evidence.observedConfirmedNonce).toBe(observedConfirmedNonce);
          expect((await admin.query(acceptSql, [json(proof)])).rows[0].packet).toEqual(accepted);
          // This calls the real shared consumer after real principal acceptance.
          // The old BIGINT cast overflows here for the last two vectors.
          expect((await admin.query(contextSql, contextArgs)).rows).toEqual([
            { highest_nonce: b.instruction.nonce, blocked_reason: null },
          ]);
          expect(
            (
              await admin.query(
                "SELECT count(*)::int AS n, sum(amount_atomic)::text AS principal FROM reward_incoming_receipts_v2 WHERE contribution_id=$1",
                [b.contribution_id],
              )
            ).rows,
          ).toEqual([{ n: 1, principal: b.instruction.amount_atomic }]);
          expect(
            (
              await admin.query(
                "SELECT state FROM song_megapot_contributions_v2 WHERE contribution_id=$1",
                [b.contribution_id],
              )
            ).rows[0].state,
          ).toMatchObject({
            nonceFinalized: true,
            fundingState: "pool_credited",
            revision: before.revision + 1,
          });
          expect(
            (
              await admin.query(
                "SELECT disposition,closure_proof_id FROM reward_contribution_reservations_v2 WHERE contribution_id=$1",
                [b.contribution_id],
              )
            ).rows,
          ).toEqual([{ disposition: "converted", closure_proof_id: proof.receiptId }]);
          expect(
            (
              await admin.query(
                "SELECT scope_leg,active,admitted,custody_liabilities FROM reward_funding_account_counters_v2 WHERE account_id='b' ORDER BY scope_leg",
              )
            ).rows,
          ).toEqual([
            { scope_leg: "", active: "0", admitted: "1", custody_liabilities: "1" },
            {
              scope_leg: b.target.pool_leg_id,
              active: "0",
              admitted: "1",
              custody_liabilities: "1",
            },
          ]);
          expect(
            (await admin.query("SELECT * FROM reward_wallet_nonce_leases ORDER BY lease_id")).rows,
          ).toEqual(leasesBefore);
          expect(
            (await admin.query("SELECT * FROM reward_funding_work_envelopes_v2 ORDER BY work_id"))
              .rows,
          ).toEqual(workBefore);
        } finally {
          await admin.query("ROLLBACK");
        }
        expect(
          (
            await admin.query(
              "SELECT state FROM song_megapot_contributions_v2 WHERE contribution_id=$1",
              [b.contribution_id],
            )
          ).rows[0].state,
        ).toEqual(before);
        expect((await admin.query(contextSql, contextArgs)).rows).toEqual([
          { highest_nonce: b.instruction.nonce, blocked_reason: "outstanding_nonce" },
        ]);
      }
    });
    test("current producer evidence is fenced, stale/CAS-safe and revocable without regranting a consumed purpose", async () => {
      const b = Schema.decodeUnknownSync(C.ContributionReceiptV2)(
        (
          await admin.query(
            "SELECT state->'receipt' AS r FROM song_megapot_contributions_v2 WHERE account_id='b'",
          )
        ).rows[0].r,
      );
      const scope = { ...base, contributionId: b.contribution_id };
      const recovery = Schema.decodeUnknownSync(C.RecoveryReceiptV2)(
        await Effect.runPromise(
          service("b").execute("RecoverSongMegapotContributionV2", scope, {
            idempotency_key: "current_recovery_queue_0001",
            expected_state_revision: 0,
            purpose: "reconcile_original",
          }),
        ),
      );
      const store = makeControlPlaneSongFundingRecoveryStore(layer());
      const queued = (
        await admin.query("SELECT * FROM reward_funding_work_envelopes_v2 ORDER BY work_id")
      ).rows;
      await expect(admin.query("SELECT list_song_funding_work_v2(NULL)")).rejects.toMatchObject({
        code: "PCV07",
      });
      await expect(
        admin.query("SELECT claim_song_funding_work_v2($1,NULL)", [recovery.work_item_id]),
      ).rejects.toMatchObject({ code: "PCV07" });
      expect(
        (await admin.query("SELECT * FROM reward_funding_work_envelopes_v2 ORDER BY work_id")).rows,
      ).toEqual(queued);
      const claims = await Promise.all([
        Effect.runPromise(store.claim(recovery.work_item_id, "lease-one")),
        Effect.runPromise(store.claim(recovery.work_item_id, "lease-two")),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const work = claims.find((x) => x !== null);
      if (work === undefined || work === null) throw new Error("Missing actual work lease");
      const now = () => new Date().toISOString();
      const rpc = {
        deployment: work.source.deployment,
        attestDeploymentAt: async () => {},
        readHead: async () => ({
          blockNumber: 20n,
          blockHash: `0x${h}`,
          blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        }),
        readBlock: async () => ({ blockNumber: 1n, blockHash: `0x${h}` }),
        readTransactionCount: async () => 4n,
        readPendingNonce: async () => 4n,
      } as unknown as MegapotV2FullRpcClient;
      const e = await Effect.runPromise(
        makeCurrentFundingRecoveryEvidence(rpc, now)(work.state, work.source),
      );
      const stale = { ...e, observedAt: new Date(Date.now() - 121_000).toISOString() };
      stale.witnessHash = await digest(recoveryEvidencePreimage(stale));
      await expect(Effect.runPromise(store.record(work, stale))).rejects.toMatchObject({
        code: "cancellation_recovery_unavailable",
      });
      await Effect.runPromise(store.record(work, e));
      await Effect.runPromise(store.record(work, e));
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM reward_funding_schedule_witnesses_v2 WHERE schedule->>'contributionId'=$1",
            [b.contribution_id],
          )
        ).rows[0].n,
      ).toBe(1);
      await admin.query("BEGIN");
      try {
        await admin.query("SELECT invalidate_song_recovery_evidence_v2($1,$2,'outcome_unknown')", [
          work.workId,
          work.token,
        ]);
        expect(
          (
            await admin.query("SELECT load_song_contribution_recovery_v2($1::jsonb) AS a", [
              json(work.identity),
            ])
          ).rows[0].a.policy,
        ).toBeNull();
        expect(
          (
            await admin.query(
              "SELECT state->>'nonceFinalized' AS closed FROM song_megapot_contributions_v2 WHERE contribution_id=$1",
              [b.contribution_id],
            )
          ).rows,
        ).toEqual([{ closed: "false" }]);
        expect(
          (
            await admin.query(
              "SELECT disposition FROM reward_contribution_reservations_v2 WHERE contribution_id=$1",
              [b.contribution_id],
            )
          ).rows,
        ).toEqual([{ disposition: "held" }]);
      } finally {
        await admin.query("ROLLBACK");
      }
      const preparedBody = {
        idempotency_key: "current_cancel_prepare_0001",
        expected_state_revision: 0,
        purpose: "cancel_original_nonce",
      };
      const plan = Schema.decodeUnknownSync(C.CancellationReceiptV2)(
        await Effect.runPromise(
          service("b").execute("PrepareSongMegapotContributionCancellationV2", scope, preparedBody),
        ),
      );
      await expect(Effect.runPromise(store.record(work, e))).rejects.toMatchObject({
        code: "lifecycle_changed",
      });
      const claim = {
        idempotency_key: "current_cancel_claim_0001",
        client_instance_id: "current_device_0001",
        submission_attempt_id: "current_attempt_0001",
        purpose: "nonce_cancellation",
        expected_state_revision: 1,
        instruction_hash: plan.instruction_hash,
      };
      const [one, two] = await Promise.allSettled([
        Effect.runPromise(
          service("b").execute("ClaimSongMegapotContributionSubmissionV2", scope, claim),
        ),
        Effect.runPromise(
          service("b").execute("ClaimSongMegapotContributionSubmissionV2", scope, {
            ...claim,
            idempotency_key: "current_cancel_claim_0002",
          }),
        ),
      ]);
      expect([one, two].filter((x) => x.status === "fulfilled")).toHaveLength(1);
      const won =
        one.status === "fulfilled"
          ? claim
          : { ...claim, idempotency_key: "current_cancel_claim_0002" };
      const lost = one.status === "rejected" ? one : two;
      // Bun collapses tagged errors in assertion output. Emit only allowlisted
      // classification fields, never raw causes, SQL, request data or messages.
      const reason = lost.status === "rejected" ? lost.reason : undefined;
      const knownFailure = reason instanceof SongContributionFailure;
      const cause = knownFailure ? reason.underlying : undefined;
      const statement = cause instanceof ControlPlaneStatementFailed ? cause : null;
      const timedOut = cause instanceof ControlPlaneOperationTimedOut;
      const unknownCommit = cause instanceof ControlPlaneTransactionOutcomeUnknown;
      const label = statement?.label ?? (timedOut || unknownCommit ? cause.label : null);
      const knownLabels = [
        "song-contribution.owned.read",
        "song-contribution.clock",
        "song-contribution.recovery.authority",
        "song-contribution.command.update",
        "song-megapot-contribution.command.lock",
      ];
      console.info(
        JSON.stringify({
          event: "song_contribution_claim_loser_classification",
          rejected: lost.status === "rejected",
          oneFulfilled: [one, two].filter((x) => x.status === "fulfilled").length === 1,
          code:
            knownFailure && Schema.is(C.ErrorV2.fields.code)(reason.code)
              ? reason.code
              : "unrecognized",
          causeType:
            statement !== null
              ? "ControlPlaneStatementFailed"
              : timedOut
                ? "ControlPlaneOperationTimedOut"
                : unknownCommit
                  ? "ControlPlaneTransactionOutcomeUnknown"
                  : cause === undefined
                    ? "absent"
                    : "unrecognized",
          sqlState:
            statement?.sqlState !== null &&
            statement?.sqlState !== undefined &&
            /^[A-Z0-9]{5}$/u.test(statement.sqlState)
              ? statement.sqlState
              : null,
          label: label !== null && knownLabels.includes(label) ? label : "other",
          commitUncertain: unknownCommit && cause.phase === "commit",
          rollbackUncertain: unknownCommit && cause.phase === "rollback",
        }),
      );
      expect(lost).toMatchObject({
        status: "rejected",
        reason: { code: "submission_already_claimed" },
      });
      await admin.query(
        "UPDATE megapot_deployment_attestations SET status='retired',retired_at=clock_timestamp() WHERE attestation_id='attestation'",
      );
      const ports = makeControlPlaneSongContributionPorts(
        layer(),
        {
          authorize: () => Effect.succeed({ accountId: "b" }),
        },
        { rewardsEnabled: true },
      );
      const current = await Effect.runPromise(
        ports.transaction(work.identity, (tx) =>
          Effect.gen(function* () {
            return yield* tx.recoveryAuthority(yield* tx.ownedContribution());
          }),
        ),
      );
      expect(current.policy).toBeNull();
      expect(
        await Effect.runPromise(
          service("b").execute("PrepareSongMegapotContributionCancellationV2", scope, preparedBody),
        ),
      ).toEqual(plan);
      expect(
        await Effect.runPromise(
          service("b").execute("ClaimSongMegapotContributionSubmissionV2", scope, won),
        ),
      ).toMatchObject({ delivery: { kind: "recovery_only" } });
      await expect(
        Effect.runPromise(
          service("b").execute("ClaimSongMegapotContributionSubmissionV2", scope, {
            ...won,
            idempotency_key: "current_cancel_claim_0003",
          }),
        ),
      ).rejects.toMatchObject({ code: "submission_already_claimed" });
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM reward_funding_submission_claims_v2 WHERE contribution_id=$1 AND purpose='nonce_cancellation'",
            [b.contribution_id],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT disposition FROM reward_contribution_reservations_v2 WHERE contribution_id=$1",
            [b.contribution_id],
          )
        ).rows,
      ).toEqual([{ disposition: "held" }]);
    });
    test("private readers preserve original receipts and liabilities without current admission or GET writes", async () => {
      const rows = (
        await admin.query(
          "SELECT contribution_id,account_id,community_id,post_id,state FROM song_megapot_contributions_v2 ORDER BY contribution_id",
        )
      ).rows;
      expect(rows.length).toBeGreaterThan(1);
      const before = (
        await admin.query(
          "SELECT (SELECT count(*)::int FROM song_megapot_contribution_commands_v2) AS commands,(SELECT count(*)::int FROM reward_funding_work_envelopes_v2) AS work,(SELECT count(*)::int FROM reward_incoming_receipts_v2) AS receipts,(SELECT count(*)::int FROM reward_contribution_reservations_v2) AS reservations",
        )
      ).rows;
      for (const row of rows) {
        const identity = {
          accountId: row.account_id,
          communityId: row.community_id,
          postId: row.post_id,
          contributionId: row.contribution_id,
        };
        const packet = (
          await admin.query("SELECT read_owned_song_contribution_current_v2($1::jsonb) AS packet", [
            json(identity),
          ])
        ).rows[0].packet;
        expect(packet.accountId).toBe(row.account_id);
        const view = Schema.decodeUnknownSync(C.CurrentStateV2, { onExcessProperty: "error" })(
          packet.current,
        );
        expect(view.command_receipt).toEqual(row.state.receipt);
        expect(view.original_sender).toBe(row.state.owner.sender_address);
        expect(view.submissions.every((s) => s.state !== "unclaimed")).toBe(true);
        expect(
          (
            await admin.query(
              "SELECT read_owned_song_contribution_current_v2($1::jsonb) AS packet",
              [json({ ...identity, accountId: "foreign_account" })],
            )
          ).rows,
        ).toEqual([{ packet: null }]);
        expect(
          (
            await admin.query(
              "SELECT read_owned_song_contribution_current_v2($1::jsonb) AS packet",
              [json({ ...identity, postId: "foreign_post" })],
            )
          ).rows,
        ).toEqual([{ packet: null }]);
      }
      // Refusal UUIDs can sort before successful commands. Exercise both
      // retained read shapes with a refusal first, independent of random IDs.
      const commands = (
        await admin.query(
          "SELECT * FROM song_megapot_contribution_commands_v2 ORDER BY (refusal_code IS NOT NULL) DESC,command_id",
        )
      ).rows;
      expect(commands[0]?.refusal_code).toBe("policy_unavailable");
      expect(commands.some((command) => command.refusal_code === null)).toBe(true);
      for (const command of commands) {
        const scope = {
          accountId: command.account_id,
          communityId: command.community_id,
          postId: command.post_id,
        };
        const own = (
          await admin.query("SELECT read_song_contribution_command_v2($1::jsonb,$2,$3) AS packet", [
            json(scope),
            command.operation,
            command.idempotency_key,
          ])
        ).rows[0].packet;
        if (command.refusal_code === null) {
          expect(Schema.decodeUnknownSync(C.FundingCommandReceiptV2)(own.receipt)).toEqual(
            command.receipt,
          );
          expect(own.receipt).not.toHaveProperty("delivery");
          expect(own).not.toHaveProperty("refusal");
        } else {
          const refused = Schema.decodeUnknownSync(FundingRefusalPacket, {
            onExcessProperty: "error",
          })(own);
          expect(refused.refusal).toEqual({
            code: command.refusal_code,
            receipt: command.receipt,
          });
          expect(own).not.toHaveProperty("receipt");
        }
        expect(
          (
            await admin.query(
              "SELECT read_song_contribution_command_v2($1::jsonb,$2,$3) AS packet",
              [
                json({ ...scope, postId: "foreign_post" }),
                command.operation,
                command.idempotency_key,
              ],
            )
          ).rows,
        ).toEqual([{ packet: null }]);
      }
      expect(
        (
          await admin.query(
            "SELECT contribution_id,account_id,community_id,post_id,state FROM song_megapot_contributions_v2 ORDER BY contribution_id",
          )
        ).rows,
      ).toEqual(rows);
      expect(
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM song_megapot_contribution_commands_v2) AS commands,(SELECT count(*)::int FROM reward_funding_work_envelopes_v2) AS work,(SELECT count(*)::int FROM reward_incoming_receipts_v2) AS receipts,(SELECT count(*)::int FROM reward_contribution_reservations_v2) AS reservations",
          )
        ).rows,
      ).toEqual(before);
    });
    test("retired attestation blocks new locked funding admission without changing liabilities", async () => {
      const snapshot = (
        await admin.query(
          "SELECT context_hash,context FROM reward_funding_leg_snapshots_v2 ORDER BY created_at DESC,snapshot_id DESC LIMIT 1",
        )
      ).rows[0];
      if (!snapshot) throw new Error("Expected retained authoritative snapshot fixture");
      expect(
        (
          await admin.query(
            "SELECT status FROM megapot_deployment_attestations WHERE attestation_id=$1",
            [snapshot.context.attestation_id],
          )
        ).rows,
      ).toEqual([{ status: "retired" }]);
      const identity = {
        accountId: snapshot.context.actor.account_id,
        communityId: snapshot.context.target.community_id,
        postId: snapshot.context.target.post_id,
        contributionId: null,
        operation: "CreateSongMegapotContributionV2",
        key: "retired_admission_key_0001",
        hash: h,
      };
      const before = (
        await admin.query(
          "SELECT contribution_id,state FROM song_megapot_contributions_v2 ORDER BY contribution_id",
        )
      ).rows;
      await expect(
        admin.query("SELECT lock_song_contribution_context_v2($1::jsonb,$2)", [
          json(identity),
          snapshot.context_hash,
        ]),
      ).rejects.toMatchObject({ code: "PCV05" });
      expect(
        (
          await admin.query(
            "SELECT contribution_id,state FROM song_megapot_contributions_v2 ORDER BY contribution_id",
          )
        ).rows,
      ).toEqual(before);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM song_megapot_contribution_commands_v2 WHERE idempotency_key=$1",
            [identity.key],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
    });
  },
);

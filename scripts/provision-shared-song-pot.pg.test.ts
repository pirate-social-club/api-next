import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { makeSongMegapotContributions } from "../packages/application/src/rewards/song-megapot-contributions.ts";
import { canonicalBodyHash } from "../packages/application/src/use-cases/content/common.ts";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import { makeReleaseRuntimeLogin } from "../packages/platform-cf/src/reward-safe-runtime-role.pg-fixture.ts";
import { seedSong } from "../packages/platform-cf/src/rewards-song-offers.pg-fixture.ts";
import { makeControlPlaneSharedSongContextProducer } from "../packages/platform-cf/src/shared-song-megapot-production.ts";
import {
  SHARED_SONG_SUCCESSOR_RULE,
  SHARED_SONG_SUCCESSOR_RULE_ID,
} from "../packages/platform-cf/src/shared-song-successor-schedule.ts";
import { makeControlPlaneSongContributionPorts } from "../packages/platform-cf/src/song-megapot-contribution-repository.ts";
import {
  applySharedSongSuccessorTemplate,
  readSharedSongSuccessorTemplate,
} from "./admit-shared-song-successor.ts";
import {
  applySharedSongProvisioning,
  buildSharedSongProvisioning,
  ENTRY_CUTOFF_SECONDS,
  readSharedSongProvisioningInput,
  SHARED_SONG_ATTESTATION,
} from "./provision-shared-song-pot.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
}
const suite = url ? describe : describe.skip;
const SAFE = `0x${"5".repeat(40)}`;
const FUNDER_WALLET = `0x${"c".repeat(40)}`;
const ATTESTATION_BLOCK = 900n;
const ATTESTATION_BLOCK_HASH = `0x${"a".repeat(64)}`;
const CURRENT_DRAWING = 11_254n;
const hex = (byte: string) => `0x${byte.repeat(64)}`;
const DANCE_POLICY = "dance-test-owner-verdict-v1";
const DANCE_ADMISSION = "dance-test-admission-v1";
const DANCE_ADMISSION_HASH = "d".repeat(64);

suite("shared-song pot provisioning", () => {
  const schema = `shared_song_provisioning_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: url });
  let runtime: Awaited<ReturnType<typeof makeReleaseRuntimeLogin>> | undefined;
  let communityId = "";
  let funderAccountId = "";
  let slotId = "";
  let postId = "";
  let personaId = "";
  let drawingTime = 0n;

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(await Bun.file(new URL("../db/postgres/schema.sql", import.meta.url)).text());
    await admin.query(`SET search_path TO "${schema}"`);
    const song = await seedSong(admin, "pot", FUNDER_WALLET);
    communityId = song.communityId;
    postId = song.postId;
    personaId = song.personaId;
    funderAccountId = song.accountId;
    slotId = (
      await admin.query("SELECT slot_id FROM reward_song_slots_v2 WHERE post_id=$1", [song.postId])
    ).rows[0]?.slot_id;
    await admin.query(
      `INSERT INTO persona_community_bindings(persona_id,account_id,community_id,binding_source)
       VALUES($1,$2,$3,'activity_participation')`,
      [song.personaId, song.accountId, song.communityId],
    );
    await admin.query("SET session_replication_role = replica");
    // Registration records the Safe's nonce authority and the settlement asset beside the
    // attestation, as on staging; the authority makes every pool leg ticket-first.
    await admin.query(
      `INSERT INTO reward_signer_nonces (chain_id,signer_address,next_nonce,
         observed_pending_nonce,observed_block_number,observed_block_hash,observed_at,
         nonce_authority)
       VALUES (84532,$1,1,1,1,$2,clock_timestamp(),'safe_owner_v1')`,
      [SAFE, hex("1")],
    );
    await admin.query(
      `INSERT INTO reward_asset_whitelist (chain_id, token_address, decimals, symbol, asset_kind,
         environment, status, policy_version, activated_at, plain_erc20_verified_at)
       VALUES (84532,$1,6,'USDC','settlement_usdc','staging','active','base-sepolia-usdc-v1',
         now(),now())`,
      [`0x${"1".repeat(40)}`],
    );
    await admin.query(
      `INSERT INTO megapot_deployment_attestations (attestation_id, environment, chain_id,
         jackpot_address, usdc_address, ticket_nft_address, custody_address, referrer_address,
         source_tag, jackpot_code_hash, usdc_code_hash, ticket_nft_code_hash,
         attestation_block_number, attestation_block_hash, abi_version, status, verified_at)
       VALUES ($1,'staging',84532,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'megapot_v2','active',
         clock_timestamp())`,
      [
        SHARED_SONG_ATTESTATION,
        SHARED_SONG_SUCCESSOR_RULE.jackpotAddress,
        `0x${"1".repeat(40)}`,
        `0x${"3".repeat(40)}`,
        SAFE,
        `0x${"4".repeat(40)}`,
        hex("6"),
        SHARED_SONG_SUCCESSOR_RULE.jackpotCodeHash,
        hex("8"),
        hex("9"),
        ATTESTATION_BLOCK.toString(),
        ATTESTATION_BLOCK_HASH,
      ],
    );
    // Study and singing keep the baseline's current policies, as staging does; Dance is
    // reserved in the baseline and gets one money-admitted policy here.
    const danceBody = {
      grading_mode: "moderator_verdict",
      verdict: "passed",
      score_bps: null,
      calibration: null,
      numeric_floor_bps: null,
      producer_id: "test-producer",
      admission: "money_admitted",
      admission_version: DANCE_ADMISSION,
      admission_hash: DANCE_ADMISSION_HASH,
    };
    const danceHash = await Effect.runPromise(
      canonicalBodyHash([
        "pirate.shared-song-qualification-policy.v1",
        DANCE_POLICY,
        "dance",
        "dance_owner_verdict_v1",
        danceBody,
      ]),
    );
    await admin.query(
      `INSERT INTO qualification_policy_versions(qualification_policy_version_id,activity_key,
         policy_kind,policy_document) VALUES($1,'dance','dance_owner_verdict_v1',$2::jsonb)`,
      [DANCE_POLICY, JSON.stringify({ ...danceBody, policy_hash: danceHash })],
    );
    await admin.query(
      `UPDATE activity_registry SET status='active',producer_version='test-producer',
         current_policy_version_id=$1 WHERE activity_key='dance'`,
      [DANCE_POLICY],
    );
    await admin.query(
      `INSERT INTO dance_review_policy_versions_v1(policy_id,policy_hash,review_policy,
         operational_profile,disposition_profile,qualification_policy_version_id,accepted_by,
         valid_from,valid_until)
       VALUES('dance-review-test',$1,$2::jsonb,'{}','{}',$3,'operator',
         clock_timestamp()-interval '1 hour',clock_timestamp()+interval '6 days')`,
      [
        "b".repeat(64),
        JSON.stringify({
          version: "moderator-review-policy-v1",
          hash: "b".repeat(64),
          reviewWindowMs: 604800000,
          qualificationVersion: DANCE_POLICY,
          qualificationHash: danceHash,
          admission: "money_admitted",
          admissionVersion: DANCE_ADMISSION,
          admissionHash: DANCE_ADMISSION_HASH,
          producerId: "test-producer",
          rubricId: "routine",
        }),
        DANCE_POLICY,
      ],
    );
    await admin.query(
      `INSERT INTO dance_review_policy_admissions_v1(community_id,policy_id,accepted,accepted_by,
         effective_at,valid_until)
       VALUES($1,'dance-review-test',true,'operator',clock_timestamp()-interval '1 hour',
         clock_timestamp()+interval '5 days')`,
      [communityId],
    );
    await admin.query("SET session_replication_role = origin");
    await admin.query(
      "SELECT set_reward_operations_paused_v1(0,FALSE,'shared_song_provisioning_test')",
    );
    runtime = await makeReleaseRuntimeLogin(admin, url as string, schema);
    // The owner binds the shared-song and contribution functions to the runtime role per
    // purpose; the release privilege list does not carry them.
    for (const purpose of ["account", "context_worker"])
      await admin.query("SELECT grant_shared_song_funding_runtime_v2($1,$2)", [
        runtime.role,
        purpose,
      ]);
    for (const purpose of ["http_commands", "incoming_observer", "funding_recovery_jobs"])
      await admin.query("SELECT bind_reward_contribution_purpose_v2($1,$2)", [
        runtime.role,
        purpose,
      ]);
  }, 120_000);

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await runtime?.drop();
    await admin.end();
  });

  test("its rows let the maintained producer write a ready one-drawing funding context", async () => {
    const input = await readSharedSongProvisioningInput(admin, {
      communityId,
      funderAccountId,
      slotIds: [slotId],
    });
    const rows = await buildSharedSongProvisioning(input);
    expect(rows.template.qualification_templates.map((b) => b.activity)).toEqual([
      "study",
      "karaoke",
      "dance",
    ]);
    await applySharedSongProvisioning(admin, rows);
    await expect(applySharedSongProvisioning(admin, rows)).rejects.toThrow();

    const now = Date.now();
    // Sixteen minutes out, funding could not reach the Safe purchase in time.
    drawingTime = BigInt(Math.floor(now / 1000) + 16 * 60);
    const headTimestamp = BigInt(Math.floor(now / 1000) - 2);
    const head = { blockNumber: 1_000n, blockHash: hex("e"), blockTimestamp: headTimestamp };
    const producer = makeControlPlaneSharedSongContextProducer({
      runtime: makeDirectPostgresControlPlaneLayer(runtime?.url as string),
      now: () => new Date().toISOString(),
      rpcFor: (deployment) =>
        ({
          deployment,
          attestDeploymentAt: async () => deployment,
          readHead: async () => head,
          readBlock: async (blockNumber: bigint) => ({
            blockNumber,
            blockHash: blockNumber === ATTESTATION_BLOCK ? ATTESTATION_BLOCK_HASH : head.blockHash,
            blockTimestamp: headTimestamp,
          }),
          readCurrentDrawingId: async () => CURRENT_DRAWING,
          readDrawing: async () => ({ ticketPrice: 10_000n, drawingTime, jackpotLock: false }),
          readTransactionCount: async () => 0n,
          readPendingNonce: async () => 0n,
          readNativeBalance: async () => 10n ** 15n,
        }) as never,
    });
    const produce = () =>
      Effect.runPromise(
        producer.run({ enabled: true, ensure: () => Effect.void }) as Effect.Effect<void, unknown>,
      );
    await produce();
    expect(
      (
        await admin.query(
          `SELECT w.last_error, (SELECT count(*)::int FROM reward_funding_leg_snapshots_v2 s
              WHERE s.slot_id=w.slot_id) AS snapshots
             FROM reward_song_context_work_v2 w`,
        )
      ).rows,
    ).toEqual([{ last_error: "capacity_exhausted", snapshots: 0 }]);

    drawingTime = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
    await produce();
    const snapshots = (
      await admin.query(
        `SELECT profile_id, refusal, context FROM reward_funding_leg_snapshots_v2 WHERE slot_id=$1`,
        [slotId],
      )
    ).rows;
    const work = (
      await admin.query("SELECT status, last_error, attempts FROM reward_song_context_work_v2")
    ).rows;
    expect({ work, refusals: snapshots.map((s) => s.refusal) }).toMatchObject({
      refusals: [null],
    });
    const [snapshot] = snapshots;
    expect(snapshot.profile_id).toBe(rows.profile.profile_id);
    expect(snapshot.context.readiness).toBe("ready");
    // Funding closes early enough that the Safe purchase still has the staging minimum
    // entry time before the cutoff, plus three minutes for confirmations and the scan.
    expect(Date.parse(snapshot.context.context_expires_at)).toBeLessThanOrEqual(
      Number(drawingTime) * 1000 - (ENTRY_CUTOFF_SECONDS + 600 + 180) * 1000,
    );
    expect(snapshot.context.quote.prospective_terms.planned_drawing_ids).toEqual([
      CURRENT_DRAWING.toString(),
    ]);
    expect(snapshot.context.quote.prospective_terms.reward_policy_template_hash).toBe(
      rows.template.template_hash,
    );
  }, 60_000);

  test("a funder's first contribution binds a pot whose one leg admits Study, singing and Dance", async () => {
    const [snapshot] = (
      await admin.query("SELECT context FROM reward_funding_leg_snapshots_v2 WHERE slot_id=$1", [
        slotId,
      ])
    ).rows;
    const c = snapshot.context;
    const service = makeSongMegapotContributions(
      makeControlPlaneSongContributionPorts(
        makeDirectPostgresControlPlaneLayer(runtime?.url as string),
        { authorize: () => Effect.succeed({ accountId: funderAccountId }) },
        { rewardsEnabled: true },
      ),
    );
    const receipt = await Effect.runPromise(
      service.execute(
        "CreateSongMegapotContributionV2",
        { communityId, postId, contributionId: null },
        {
          version: 2,
          idempotency_key: "shared_song_provisioning_first_pot",
          persona_id: personaId,
          funding_amount_atomic: "10000",
          expected_context_hash: c.context_hash,
          expected_lifecycle_revision: c.lifecycle_revision,
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
          expected_terms_kind: "prospective",
          expected_terms_hash: c.quote.prospective_terms_hash,
        } as never,
      ) as Effect.Effect<unknown, unknown>,
    );
    expect(receipt).toBeDefined();
    const legs = (
      await admin.query(
        `SELECT leg.status, leg.eligible_activities, leg.purchase_order, leg.attestation_id,
                leg.shared_song_terms_v2->'planned_drawing_ids' AS planned, offer.status AS offer_status
           FROM song_reward_offer_legs leg JOIN song_reward_offers offer USING (offer_id)
          WHERE offer.post_id=$1`,
        [postId],
      )
    ).rows;
    expect(legs).toEqual([
      {
        status: "funding",
        eligible_activities: ["study", "karaoke", "dance"],
        purchase_order: "ticket_first_v1",
        attestation_id: SHARED_SONG_ATTESTATION,
        planned: [CURRENT_DRAWING.toString()],
        offer_status: "active",
      },
    ]);
  }, 60_000);

  test("a reviewed successor replaces only the admission pointer while all original financial state stays byte-equivalent", async () => {
    const financial = async () => {
      const tables = [
        "reward_funding_profiles_v2",
        "reward_funding_work_envelopes_v2",
        "reward_context_work_counters_v2",
        "reward_funding_account_counters_v2",
        "reward_song_slots_v2",
        "song_megapot_contributions_v2",
        "song_reward_offers",
        "song_reward_offer_legs",
      ];
      const rows = [];
      for (const table of tables)
        rows.push(
          (
            await admin.query(
              `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) data FROM ${table} t`,
            )
          ).rows[0].data,
        );
      return rows;
    };
    const before = await financial();
    await admin.query("BEGIN READ ONLY");
    const plan = await readSharedSongSuccessorTemplate(admin, communityId);
    await admin.query("ROLLBACK");
    const old = (
      await admin.query(
        "SELECT to_jsonb(t) data FROM reward_shared_song_templates_v2 t WHERE template_hash=$1",
        [plan.predecessorHash],
      )
    ).rows[0].data;
    const revision = async () =>
      Number(
        (await admin.query("SELECT revision::text FROM reward_operations_control WHERE singleton"))
          .rows[0].revision,
      );
    const input = {
      communityId,
      expectedAdmissionHash: plan.expectedAdmissionHash,
      expectedTemplateHash: plan.template.template_hash,
      expectedBrakeRevision: await revision(),
    };
    await expect(applySharedSongSuccessorTemplate(admin, input)).rejects.toThrow(
      "exact paused brake",
    );
    await admin.query(
      "SELECT set_reward_operations_paused_v1(revision,TRUE,'successor_fixture') FROM reward_operations_control WHERE singleton",
    );
    input.expectedBrakeRevision = await revision();
    await expect(
      applySharedSongSuccessorTemplate(admin, { ...input, expectedTemplateHash: "f".repeat(64) }),
    ).rejects.toThrow("reviewed template/admission changed");
    await expect(
      applySharedSongSuccessorTemplate(admin, {
        ...input,
        expectedBrakeRevision: input.expectedBrakeRevision - 1,
      }),
    ).rejects.toThrow("exact paused brake");
    await admin.query("SELECT acquire_reward_run_lease_v1('successor-template-fixture',30,60)");
    await expect(applySharedSongSuccessorTemplate(admin, input)).rejects.toThrow(
      "exact paused brake",
    );
    await admin.query(
      "SELECT release_reward_run_lease_v1(run_id,fence) FROM reward_operations_run_lease WHERE singleton",
    );
    expect(await financial()).toEqual(before);
    const applied = await applySharedSongSuccessorTemplate(admin, input);
    expect(applied).toEqual(plan);
    expect(applied.template.operational_profile.scheduleRuleId).toBe(SHARED_SONG_SUCCESSOR_RULE_ID);
    expect(applied.template.qualification_templates).toEqual(old.qualification_templates);
    expect(applied.template.profile_id).toBe(old.profile_id);
    expect(applied.template.valid_until).toBe(new Date(old.valid_until).toISOString());
    expect(await financial()).toEqual(before);
    expect(
      (
        await admin.query(
          "SELECT to_jsonb(t) data FROM reward_shared_song_templates_v2 t WHERE template_hash=$1",
          [plan.predecessorHash],
        )
      ).rows[0].data,
    ).toEqual(old);
    expect(
      (
        await admin.query(
          "SELECT template_id,admission_hash FROM reward_shared_song_template_admissions_v2 WHERE community_id=$1",
          [communityId],
        )
      ).rows[0],
    ).toEqual({
      template_id: plan.template.template_id,
      admission_hash: plan.admission.admission_hash,
    });
    await expect(applySharedSongSuccessorTemplate(admin, input)).rejects.toThrow();
    expect(await financial()).toEqual(before);
    expect(
      (await admin.query("SELECT count(*)::int n FROM reward_shared_song_templates_v2")).rows[0].n,
    ).toBe(2);
  }, 60_000);
});

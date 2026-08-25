import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeControlPlaneMegapotPurchaseStore } from "./megapot-purchase-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { applyPostgresMigrations } from "./postgres-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const migrations = await loadPostgresMigrations();

const address = (byte: string): string => `0x${byte.repeat(40)}`;
const bytes32 = (byte: string): string => `0x${byte.repeat(64)}`;
const hash = (byte: string): string => byte.repeat(64);

const schemaIdentifier = (): string =>
  `api_next_rewards_offers_${crypto.randomUUID().replaceAll("-", "")}`;
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const connectionForSchema = (raw: string, schema: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
};

async function withSchema<A>(
  use: (admin: Client, scopedConnection: string) => Promise<A>,
): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = schemaIdentifier();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  try {
    await Effect.runPromise(
      Effect.scoped(
        applyPostgresMigrations(migrations).pipe(
          Effect.provide(
            makeDirectPostgresControlPlaneLayer(connectionForSchema(connectionString, schema)),
          ),
        ),
      ),
    );
    return await use(admin, connectionForSchema(connectionString, schema));
  } finally {
    await admin.query("ROLLBACK");
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

type SeedIdentity = Readonly<{
  accountId: string;
  communityId: string;
  personaId: string;
  postId: string;
}>;

async function seedSong(admin: Client, suffix: string): Promise<SeedIdentity> {
  const accountId = `account-${suffix}`;
  const communityId = `community-${suffix}`;
  const postId = `post-${suffix}`;
  await admin.query(
    `INSERT INTO users (user_id, status, account, created_at)
     VALUES ($1, 'active', '{}'::jsonb, clock_timestamp() - interval '30 days')`,
    [accountId],
  );
  const personas = await admin.query<{ readonly persona_id: string }>(
    `SELECT persona_id FROM personas WHERE account_id=$1 AND is_first_persona`,
    [accountId],
  );
  const personaId = personas.rows[0]?.persona_id;
  if (personaId === undefined) throw new Error("first persona was not provisioned");
  await admin.query(
    `INSERT INTO communities (
       community_id, display_name, status, created_by_user_id, created_at, updated_at
     ) VALUES ($1, $2, 'active', $3, clock_timestamp() - interval '20 days',
       clock_timestamp() - interval '20 days')`,
    [communityId, `Community ${suffix}`, accountId],
  );
  await admin.query(
    `INSERT INTO community_memberships (
       community_id, membership_id, user_id, status, joined_at, created_at, updated_at
     ) VALUES ($1, $2, $3, 'member', clock_timestamp() - interval '19 days',
       clock_timestamp() - interval '19 days', clock_timestamp() - interval '19 days')`,
    [communityId, `membership-${suffix}`, accountId],
  );
  await admin.query(
    `INSERT INTO posts (
       community_id, post_id, author_user_id, author_persona_id, post_type,
       status, visibility, title, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'song', 'published', 'public', $5,
       clock_timestamp() - interval '10 days', clock_timestamp() - interval '10 days')`,
    [communityId, postId, accountId, personaId, `Song ${suffix}`],
  );
  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query(
      `INSERT INTO media_publication_projections (
         submission_id, community_id, actor_user_id, operation_id, post_id,
         creation_revision, audio_revision, analysis_revision, decision_revision,
         canonical_audio_sha256, title, audio_asset_ref, language_status,
         lyrics_explicitness, alignment, data_registration, locked_delivery,
         projected_at, author_persona_id, lyrics_status, lyrics_revision, lyrics_text
       ) VALUES (
         $1, $2, $3, $4, $5, 1, 3, 1, 1, $6, $7, $8, 'ready',
         'not_explicit', 'ready', 'registered', 'not_required', clock_timestamp(),
         $9, 'ready', 1, 'Raise the sails'
       )`,
      [
        `submission-${suffix}`,
        communityId,
        accountId,
        `operation-${suffix}`,
        postId,
        hash("a"),
        `Song ${suffix}`,
        `r2://audio-${suffix}`,
        personaId,
      ],
    );
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
  return { accountId, communityId, personaId, postId };
}

async function seedMegapotAuthority(admin: Client): Promise<void> {
  await admin.query(
    `INSERT INTO reward_asset_whitelist (
       chain_id, token_address, decimals, symbol, asset_kind, environment,
       status, policy_version, activated_at
     ) VALUES (84532, $1, 6, 'USDC', 'settlement_usdc', 'staging',
       'active', 'base-sepolia-usdc-v1', clock_timestamp())`,
    [address("1")],
  );
  await admin.query(
    `INSERT INTO megapot_deployment_attestations (
       attestation_id, environment, chain_id, jackpot_address, usdc_address,
       ticket_nft_address, custody_address, referrer_address, source_tag,
       jackpot_code_hash, usdc_code_hash, ticket_nft_code_hash,
       attestation_block_number, attestation_block_hash, abi_version, status, verified_at
     ) VALUES (
       'megapot-base-sepolia-v2', 'staging', 84532, $1, $2, $3, $4, $5, $6,
       $7, $8, $9, 100, $10, 'megapot_v2', 'active', clock_timestamp()
     )`,
    [
      address("2"),
      address("1"),
      address("3"),
      address("4"),
      address("5"),
      bytes32("6"),
      bytes32("7"),
      bytes32("8"),
      bytes32("9"),
      bytes32("a"),
    ],
  );
}

async function seedActivePoolLeg(
  admin: Client,
  identity: SeedIdentity,
  input: Readonly<{ fallback: boolean; suffix: string }> = { fallback: false, suffix: "pool" },
): Promise<Readonly<{ legId: string; offerId: string }>> {
  const offerId = `offer-${input.suffix}`;
  const legId = `leg-${input.suffix}`;
  await admin.query(
    `INSERT INTO reward_activity_availability_observations (
       availability_observation_id, community_id, post_id, audio_revision,
       activity_key, producer_id, producer_revision, state, study_item_count,
       evidence, evidence_hash, observed_at, expires_at
     ) VALUES ($1, $2, $3, 3, 'study', 'study-item-source', 'v1',
       'available', 3, '{"kind":"typed_study_items","item_count":3}'::jsonb,
       $4, clock_timestamp(), clock_timestamp() + interval '2 hours')`,
    [`availability-${input.suffix}`, identity.communityId, identity.postId, hash("b")],
  );
  await admin.query(
    `INSERT INTO song_reward_offers (
       offer_id, community_id, post_id, audio_revision, created_by_account_id,
       status, starts_at, ends_at, owner_policy_snapshot, terms_hash
     ) VALUES ($1, $2, $3, 3, $4, 'draft', clock_timestamp() - interval '1 day',
       clock_timestamp() + interval '10 days', '{"third_party_legs":"allowed"}'::jsonb, $5)`,
    [offerId, identity.communityId, identity.postId, identity.accountId, hash("c")],
  );
  await admin.query(
    `UPDATE song_reward_offers
        SET status='active', activated_at=clock_timestamp(), updated_at=clock_timestamp()
      WHERE offer_id=$1`,
    [offerId],
  );
  await admin.query(
    `INSERT INTO song_reward_offer_legs (
       leg_id, offer_id, kind, status, funder_account_id, refund_policy,
       leg_terms_hash, participation_starts_at, chain_id, token_address,
       token_decimals, tickets_per_drawing, max_ticket_price_atomic,
       entry_cutoff_seconds, beneficiary_algorithm_version, ticket_selection_version,
       attestation_id, participation_starts_drawing_id, eligible_activities,
       min_score_bps, empty_pool_policy, funding_source,
       fallback_beneficiary_account_id, fallback_payout_persona_id,
       referral_allocation_version, referral_policy_hash, referral_disclosed_at,
       funded_atomic
     ) VALUES (
       $1, $2, 'megapot_pool', 'draft', $3, 'refund_to_funders_pro_rata',
       $4, clock_timestamp() - interval '1 day', 84532, $5, 6, 1, 10000, 300,
       'equal_v1', 'keccak_packed_v1', 'megapot-base-sepolia-v2', 100,
       ARRAY['study'], 7000, $6, 'leg_budget', $7, $8, $9, $10, $11, 100000
     )`,
    [
      legId,
      offerId,
      identity.accountId,
      bytes32("b"),
      address("1"),
      input.fallback ? "funder_fallback" : "no_purchase",
      input.fallback ? identity.accountId : null,
      input.fallback ? identity.personaId : null,
      input.fallback ? "referral-test-v1" : null,
      input.fallback ? hash("d") : null,
      input.fallback ? new Date().toISOString() : null,
    ],
  );
  await admin.query(
    `UPDATE song_reward_offer_legs
        SET status='active', activated_at=clock_timestamp(), updated_at=clock_timestamp()
      WHERE leg_id=$1`,
    [legId],
  );
  return { legId, offerId };
}

suite("Postgres 17 Megapot rewards persistence", () => {
  test("closes fallback score, availability, parallel-leg, and foreign-funder routes", async () => {
    await withSchema(async (admin) => {
      const identity = await seedSong(admin, "fallback");
      await seedMegapotAuthority(admin);
      const { legId, offerId } = await seedActivePoolLeg(admin, identity, {
        fallback: true,
        suffix: "fallback",
      });
      await expect(
        admin.query(
          `INSERT INTO song_reward_offer_legs (
             leg_id, offer_id, kind, status, funder_account_id, refund_policy,
             leg_terms_hash, participation_starts_at, chain_id, token_address,
             token_decimals, tickets_per_drawing, max_ticket_price_atomic,
             entry_cutoff_seconds, beneficiary_algorithm_version, ticket_selection_version,
             attestation_id, participation_starts_drawing_id, eligible_activities,
             min_score_bps, empty_pool_policy, funding_source,
             fallback_beneficiary_account_id, fallback_payout_persona_id,
             referral_allocation_version, referral_policy_hash, referral_disclosed_at
           ) SELECT 'bad-score-leg', offer_id, kind, 'draft', funder_account_id,
             refund_policy, $1, participation_starts_at, chain_id, token_address,
             token_decimals, tickets_per_drawing, max_ticket_price_atomic,
             entry_cutoff_seconds, beneficiary_algorithm_version, ticket_selection_version,
             attestation_id, participation_starts_drawing_id, eligible_activities,
             10000, empty_pool_policy, funding_source, fallback_beneficiary_account_id,
             fallback_payout_persona_id, referral_allocation_version,
             referral_policy_hash, referral_disclosed_at
           FROM song_reward_offer_legs WHERE leg_id=$2`,
          [bytes32("c"), legId],
        ),
      ).rejects.toBeDefined();
      await expect(
        admin.query(
          `INSERT INTO song_reward_offer_legs (
             leg_id, offer_id, kind, status, funder_account_id, refund_policy,
             leg_terms_hash, participation_starts_at, chain_id, token_address,
             token_decimals, tickets_per_drawing, max_ticket_price_atomic,
             entry_cutoff_seconds, beneficiary_algorithm_version, ticket_selection_version,
             attestation_id, participation_starts_drawing_id, eligible_activities,
             min_score_bps, empty_pool_policy, funding_source
           ) VALUES (
             'parallel-pool', $1, 'megapot_pool', 'draft', $2,
             'refund_to_funders_pro_rata', $3, clock_timestamp(), 84532, $4, 6,
             1, 10000, 300, 'equal_v1', 'keccak_packed_v1',
             'megapot-base-sepolia-v2', 100, ARRAY['study'], 7000,
             'no_purchase', 'leg_budget'
           )`,
          [offerId, identity.accountId, bytes32("d"), address("1")],
        ),
      ).rejects.toBeDefined();
      await admin.query(
        `INSERT INTO users (user_id, status, account)
         VALUES ('foreign-funder', 'active', '{}'::jsonb)`,
      );
      await expect(
        admin.query(
          `INSERT INTO song_reward_leg_funding_effects (
             funding_effect_id, leg_id, funder_account_id, chain_id, token_address,
             sender_address, recipient_address, expected_amount_atomic,
             required_confirmations, state
           ) VALUES (
             'foreign-topup', $1, 'foreign-funder', 84532, $2, $3, $4,
             10000, 2, 'planned'
           )`,
          [legId, address("1"), address("e"), address("4")],
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining("fallback_sponsor_mismatch") });
    });
  });

  test("freezes one account share into a private/public commitment without identity leakage", async () => {
    await withSchema(async (admin) => {
      const identity = await seedSong(admin, "snapshot");
      await seedMegapotAuthority(admin);
      const { legId } = await seedActivePoolLeg(admin, identity, {
        fallback: false,
        suffix: "snapshot",
      });
      await admin.query(
        `INSERT INTO megapot_drawing_observations (
           observation_id, attestation_id, chain_id, drawing_id,
           ticket_price_atomic, drawing_time, ball_max, bonusball_max,
           drawing_locked, referral_fee_wei, referral_win_share_wei,
           block_number, block_hash, block_timestamp, confirmations,
           observed_at, expires_at, raw_state_hash
         ) VALUES (
           'drawing-observation-100', 'megapot-base-sepolia-v2', 84532, 100,
           10000, clock_timestamp() + interval '1 hour', 25, 13, false,
           100000000000000000, 100000000000000000, 101, $1,
           clock_timestamp() - interval '1 minute', 3, clock_timestamp(),
           clock_timestamp() + interval '30 minutes', $2
         )`,
        [bytes32("e"), hash("e")],
      );
      await admin.query(
        `INSERT INTO megapot_pool_drawings (
           pool_leg_id, drawing_id, observation_id, status, entry_cutoff_at,
           ticket_price_ceiling_atomic
         ) SELECT $1, 100, 'drawing-observation-100', 'entry_open',
             drawing_time - interval '300 seconds', 10000
           FROM megapot_drawing_observations
          WHERE observation_id='drawing-observation-100'`,
        [legId],
      );
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          `INSERT INTO activity_qualifications (
             qualification_id, account_id, persona_id, community_id, post_id,
             audio_revision, activity_key, study_session_id, score_bps,
             qualification_policy_version_id, qualified_at, streak_day,
             evidence_summary
           ) VALUES (
             'qualification-snapshot', $1, $2, $3, $4, 3, 'study',
             'study-session-snapshot', 8000, 'study_session_first_pass_v2@1',
             clock_timestamp() - interval '1 minute', current_date,
             '{"kind":"study_session_first_pass_v2"}'::jsonb
           )`,
          [identity.accountId, identity.personaId, identity.communityId, identity.postId],
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      await admin.query(
        `INSERT INTO reward_eligibility_decisions (
           eligibility_decision_id, leg_id, account_id, persona_id, purpose,
           qualification_id, drawing_id, outcome, policy_version, evidence_hash,
           decided_at, expires_at
         ) VALUES (
           'eligibility-snapshot', $1, $2, $3, 'pool_share',
           'qualification-snapshot', 100, 'eligible', 'pool-legal-test-v1', $4,
           clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour'
         )`,
        [legId, identity.accountId, identity.personaId, hash("f")],
      );
      await admin.query(
        `INSERT INTO megapot_pool_shares (
           pool_leg_id, drawing_id, account_id, persona_id, qualification_id,
           eligibility_decision_id, qualified_at
         ) SELECT $1, 100, account_id, persona_id, qualification_id,
             'eligibility-snapshot', qualified_at
           FROM activity_qualifications WHERE qualification_id='qualification-snapshot'`,
        [legId],
      );
      await expect(
        admin.query(
          `INSERT INTO megapot_pool_shares (
             pool_leg_id, drawing_id, account_id, persona_id, qualification_id,
             eligibility_decision_id, qualified_at
           ) SELECT $1, 100, account_id, persona_id, qualification_id,
               'eligibility-snapshot', qualified_at
             FROM activity_qualifications WHERE qualification_id='qualification-snapshot'`,
          [legId],
        ),
      ).rejects.toBeDefined();

      const orderKey = bytes32("1");
      const leafCommitment = bytes32("2");
      const snapshotHash = bytes32("3");
      const termsHash = bytes32("b");
      await admin.query("BEGIN");
      try {
        await admin.query(
          `UPDATE megapot_pool_drawings
              SET status='cutoff_frozen', version=2, reserved_ticket_cost_atomic=10000,
                  frozen_share_count=1, fallback_beneficiary=false,
                  snapshot_id='snapshot-100', cutoff_frozen_at=clock_timestamp(),
                  updated_at=clock_timestamp()
            WHERE pool_leg_id=$1 AND drawing_id=100`,
          [legId],
        );
        await admin.query(
          `INSERT INTO megapot_pool_drawing_transitions (
             pool_leg_id, drawing_id, target_version, event_type, event
           ) VALUES ($1, 100, 2, 'cutoff', '{"type":"cutoff"}'::jsonb)`,
          [legId],
        );
        await admin.query(
          `INSERT INTO megapot_pool_beneficiary_snapshots (
             snapshot_id, pool_leg_id, drawing_id, domain, terms_hash,
             algorithm_version, fallback, leaf_count, snapshot_hash,
             published_artifact, frozen_at
           ) VALUES (
             'snapshot-100', $1::text, 100,
             'pirate.megapot-pool-beneficiary-snapshot.v2', $2,
             'equal_v1', false, 1, $3,
             jsonb_build_object(
               'domain', 'pirate.megapot-pool-beneficiary-snapshot.v2',
               'poolLegId', $1::text,
               'drawingId', '100',
               'termsHash', $2::text,
               'algorithmVersion', 'equal_v1',
               'fallback', false,
               'leafCount', 1,
               'leafCommitments', jsonb_build_array($4::text),
               'snapshotHash', $3::text
             ), clock_timestamp()
           )`,
          [legId, termsHash, snapshotHash, leafCommitment],
        );
        await admin.query(
          `INSERT INTO megapot_pool_snapshot_private_leaves (
             snapshot_id, ordinal, account_id, persona_id, order_key, leaf_commitment
           ) VALUES ('snapshot-100', 0, $1, $2, $3, $4)`,
          [identity.accountId, identity.personaId, orderKey, leafCommitment],
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      const snapshot = await admin.query<{ readonly published_artifact: unknown }>(
        `SELECT published_artifact FROM megapot_pool_beneficiary_snapshots
          WHERE snapshot_id='snapshot-100'`,
      );
      const published = JSON.stringify(snapshot.rows[0]?.published_artifact);
      expect(published).not.toContain(identity.accountId);
      expect(published).not.toContain(identity.personaId);
      await expect(
        admin.query(
          `DELETE FROM megapot_pool_snapshot_private_leaves
            WHERE snapshot_id='snapshot-100'`,
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining("append-only") });
    });
  });

  test("fences one active effect per signer nonce and freezes exact signed bytes", async () => {
    await withSchema(async (admin) => {
      const signer = address("4");
      await admin.query(
        `INSERT INTO reward_signer_nonces (
           chain_id, signer_address, next_nonce, observed_pending_nonce,
           observed_block_number, observed_block_hash, observed_at
         ) VALUES (84532, $1, 7, 7, 100, $2, clock_timestamp())`,
        [signer, bytes32("4")],
      );
      for (const effectId of ["purchase-effect", "duplicate-effect"]) {
        await admin.query(
          `INSERT INTO reward_chain_effects (
             effect_id, effect_kind, state, chain_id, signer_address,
             target_address, reserved_amount_atomic
           ) VALUES ($1, 'ticket_purchase', 'planned', 84532, $2, $3, 10000)`,
          [effectId, signer, address("2")],
        );
      }
      await admin.query("BEGIN");
      try {
        await admin.query(
          `UPDATE reward_chain_effects
              SET state='nonce_reserved', version=2, nonce=7, updated_at=clock_timestamp()
            WHERE effect_id='purchase-effect'`,
        );
        await admin.query(
          `INSERT INTO reward_chain_effect_transitions (
             effect_id, target_version, event_type, event
           ) VALUES ('purchase-effect', 2, 'nonce_reserved', '{"nonce":"7"}'::jsonb)`,
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      await expect(
        admin.query("BEGIN").then(async () => {
          try {
            await admin.query(
              `UPDATE reward_chain_effects
                  SET state='nonce_reserved', version=2, nonce=7,
                      updated_at=clock_timestamp()
                WHERE effect_id='duplicate-effect'`,
            );
            await admin.query(
              `INSERT INTO reward_chain_effect_transitions (
                 effect_id, target_version, event_type, event
               ) VALUES ('duplicate-effect', 2, 'nonce_reserved', '{"nonce":"7"}'::jsonb)`,
            );
            await admin.query("COMMIT");
          } catch (error) {
            await admin.query("ROLLBACK");
            throw error;
          }
        }),
      ).rejects.toBeDefined();
      await admin.query("BEGIN");
      try {
        await admin.query(
          `UPDATE reward_chain_effects
              SET state='prepared', version=3, calldata='0xdeadbeef',
                  calldata_hash=$1, signed_transaction='0x0102',
                  signed_transaction_hash=$2, prepared_at=clock_timestamp(),
                  updated_at=clock_timestamp()
            WHERE effect_id='purchase-effect'`,
          [hash("5"), bytes32("5")],
        );
        await admin.query(
          `INSERT INTO reward_chain_effect_transitions (
             effect_id, target_version, event_type, event
           ) VALUES ('purchase-effect', 3, 'prepared', '{"type":"prepared"}'::jsonb)`,
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      await expect(
        admin.query(
          `UPDATE reward_chain_effects
              SET calldata='0xcafebabe', version=4, state='broadcast_pending',
                  transaction_hash=$1, broadcast_at=clock_timestamp(),
                  updated_at=clock_timestamp()
            WHERE effect_id='purchase-effect'`,
          [bytes32("5")],
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining("bytes are immutable") });
      const effect = await admin.query<{
        readonly state: string;
        readonly reserved_amount_atomic: string;
      }>(
        `SELECT state, reserved_amount_atomic::text
           FROM reward_chain_effects WHERE effect_id='purchase-effect'`,
      );
      expect(effect.rows).toEqual([{ state: "prepared", reserved_amount_atomic: "10000" }]);
    });
  });

  test("persists nonce reserve through confirmed custody ticket without duplicate purchase", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const identity = await seedSong(admin, "purchase-repository");
      await seedMegapotAuthority(admin);
      const { legId } = await seedActivePoolLeg(admin, identity, {
        fallback: false,
        suffix: "purchase-repository",
      });
      await admin.query(
        `INSERT INTO megapot_drawing_observations (
           observation_id, attestation_id, chain_id, drawing_id,
           ticket_price_atomic, drawing_time, ball_max, bonusball_max,
           drawing_locked, referral_fee_wei, referral_win_share_wei,
           block_number, block_hash, block_timestamp, confirmations,
           observed_at, expires_at, raw_state_hash
         ) VALUES (
           'drawing-observation-101', 'megapot-base-sepolia-v2', 84532, 101,
           10000, clock_timestamp() + interval '1 hour', 25, 13, false,
           100000000000000000, 100000000000000000, 110, $1,
           clock_timestamp() - interval '1 minute', 3, clock_timestamp(),
           clock_timestamp() + interval '30 minutes', $2
         )`,
        [bytes32("6"), hash("6")],
      );
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          `INSERT INTO megapot_pool_drawings (
             pool_leg_id, drawing_id, observation_id, status, version,
             entry_cutoff_at, ticket_price_ceiling_atomic,
             reserved_ticket_cost_atomic, actual_ticket_cost_atomic,
             frozen_share_count, fallback_beneficiary, snapshot_id,
             commitment_effect_id, cutoff_frozen_at
           ) VALUES (
             $1, 101, 'drawing-observation-101', 'committed', 3,
             clock_timestamp() + interval '55 minutes', 10000, 10000, 0,
             1, false, 'snapshot-101', 'commitment-101', clock_timestamp()
           )`,
          [legId],
        );
        await admin.query(
          `INSERT INTO megapot_pool_beneficiary_snapshots (
             snapshot_id, pool_leg_id, drawing_id, domain, terms_hash,
             algorithm_version, fallback, leaf_count, snapshot_hash,
             published_artifact, frozen_at
           ) VALUES (
             'snapshot-101', $1, 101,
             'pirate.megapot-pool-beneficiary-snapshot.v2', $2,
             'equal_v1', false, 1, $3, '{}'::jsonb, clock_timestamp()
           )`,
          [legId, bytes32("b"), bytes32("7")],
        );
        await admin.query(
          `INSERT INTO megapot_pool_commitment_effects (
             commitment_effect_id, snapshot_id, payload_hash, signing_key_id,
             signature, state, prepared_at, published_at, public_reference
           ) VALUES (
             'commitment-101', 'snapshot-101', $1, 'test-commitment-key',
             'test-signature', 'published', clock_timestamp(), clock_timestamp(),
             'urn:pirate:test:commitment-101'
           )`,
          [hash("7")],
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }

      await admin.query(`UPDATE song_reward_offer_legs SET reserved_atomic=10000 WHERE leg_id=$1`, [
        legId,
      ]);

      const store = makeControlPlaneMegapotPurchaseStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const candidate = await Effect.runPromise(
        store.loadCandidate({ poolLegId: legId, drawingId: 101n }),
      );
      expect(candidate).toMatchObject({
        drawingVersion: 3,
        ticketPriceAtomic: 10_000n,
        ballMax: 25,
        bonusballMax: 13,
      });
      const reserved = await Effect.runPromise(
        store.reserveNonce({
          candidate,
          effectId: "purchase-effect-101",
          ticket: { normals: [1, 2, 3, 4, 5], bonusball: 6 },
          observedPendingNonce: 9n,
          observedBlockNumber: 111n,
          observedBlockHash: bytes32("8"),
          observedAt: new Date().toISOString(),
        }),
      );
      expect(reserved.nonce).toBe(9n);
      const transactionHash = bytes32("9");
      await Effect.runPromise(
        store.prepare({
          reservation: reserved,
          ticket: { normals: [1, 2, 3, 4, 5], bonusball: 6 },
          calldata: "0xdeadbeef",
          calldataHash: hash("8"),
          signedTransaction: "0x0102",
          signedTransactionHash: transactionHash,
          preparedAt: new Date().toISOString(),
        }),
      );
      await Effect.runPromise(
        store.recordSubmission({
          effectId: reserved.effectId,
          transactionHash,
          submittedAt: new Date().toISOString(),
          outcome: "accepted",
        }),
      );
      await Effect.runPromise(
        store.confirm({
          effectId: reserved.effectId,
          transactionHash,
          ticketId: 501n,
          purchaseLogIndex: 3,
          mintLogIndex: 4,
          blockNumber: 112n,
          blockHash: bytes32("a"),
          receiptHash: hash("a"),
          confirmations: 3,
          referralFeesAtomic: 100n,
          lpEarningsAtomic: 900n,
          confirmedAt: new Date().toISOString(),
        }),
      );
      const rows = await admin.query<{
        readonly effect_state: string;
        readonly drawing_state: string;
        readonly ticket_state: string;
        readonly evidence_count: string;
        readonly reserved_atomic: string;
        readonly spent_atomic: string;
        readonly referral_fees_atomic: string;
      }>(
        `SELECT effect.state AS effect_state, drawing.status AS drawing_state,
                ticket.status AS ticket_state,
                (SELECT count(*)::text FROM megapot_purchase_receipt_evidence
                  WHERE purchase_effect_id=effect.effect_id) AS evidence_count,
                leg.reserved_atomic::text, leg.spent_atomic::text,
                evidence.referral_fees_atomic::text
           FROM reward_chain_effects effect
           JOIN megapot_pool_drawings drawing
             ON drawing.purchase_effect_id=effect.effect_id
           JOIN megapot_ticket_inventory ticket
             ON ticket.purchase_effect_id=effect.effect_id
           JOIN song_reward_offer_legs leg ON leg.leg_id=drawing.pool_leg_id
           JOIN megapot_purchase_receipt_evidence evidence
             ON evidence.purchase_effect_id=effect.effect_id
          WHERE effect.effect_id='purchase-effect-101'`,
      );
      expect(rows.rows).toEqual([
        {
          effect_state: "confirmed",
          drawing_state: "tickets_confirmed",
          ticket_state: "custodied",
          evidence_count: "1",
          reserved_atomic: "0",
          spent_atomic: "10000",
          referral_fees_atomic: "100",
        },
      ]);
      await expect(
        Effect.runPromise(
          store.reserveNonce({
            candidate,
            effectId: "purchase-effect-101-duplicate",
            ticket: { normals: [1, 2, 3, 4, 5], bonusball: 6 },
            observedPendingNonce: 9n,
            observedBlockNumber: 113n,
            observedBlockHash: bytes32("b"),
            observedAt: new Date().toISOString(),
          }),
        ),
      ).rejects.toMatchObject({ reason: "drawing-not-committed" });
    });
  });
});

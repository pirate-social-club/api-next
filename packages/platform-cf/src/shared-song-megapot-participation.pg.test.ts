import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  otherParticipantAccount,
  participantAccount,
  seedSharedSongParticipant,
} from "./shared-song-megapot-participation.pg-fixture.ts";
import {
  decodeSharedSongParticipation,
  makeSharedSongMegapotParticipationReader,
} from "./shared-song-megapot-participation.ts";
import { seedParticipantWinHistory } from "./shared-song-participant-history.pg-fixture.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("Isolated Postgres URL required");
const suite = url ? describe : describe.skip;
const schema = `participant_read_${process.pid}_${Date.now()}`;
const role = `participant_reader_${process.pid}_${Date.now()}`;
const admin = new Client({ connectionString: url });
let connected = false,
  roleCreated = false;
let read: ReturnType<typeof makeSharedSongMegapotParticipationReader>;
const connectionString = () => {
  if (!url) throw new Error("Isolated Postgres URL required");
  const scoped = new URL(url);
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  return scoped.toString();
};
setDefaultTimeout(30_000);
beforeAll(async () => {
  if (!url) return;
  await admin.connect();
  connected = true;
  await admin.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
  const migrations = await loadPostgresMigrations();
  const result = await runPostgresMigrations({
    connectionString: connectionString(),
    migrations,
    expectedLedger: [],
  });
  if (result.dryRun) throw new Error("Actual isolated schema required");
  const latest = migrations.at(-1);
  if (latest === undefined) throw new Error("Migration plan required");
  expect(result.result.currentVersion).toBe(latest.version);
  await seedSharedSongParticipant(admin);
  // A synthetic execute-only login, not a managed credential or role plan.
  const password = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
  roleCreated = true;
  await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
  await admin.query(
    `GRANT EXECUTE ON FUNCTION read_shared_song_megapot_participation_v2(TEXT,TEXT,TEXT) TO "${role}"`,
  );
  const restricted = new URL(connectionString());
  restricted.username = role;
  restricted.password = password;
  read = makeSharedSongMegapotParticipationReader(
    makeDirectPostgresControlPlaneLayer(restricted.toString()),
  );
});
afterAll(async () => {
  if (!connected) return;
  try {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (roleCreated) await admin.query(`DROP ROLE "${role}"`);
  } finally {
    await admin.end();
  }
});

async function bootstrapTransaction(use: () => Promise<void>) {
  await admin.query("BEGIN");
  try {
    await admin.query("SET LOCAL session_replication_role=replica");
    await use();
  } finally {
    await admin.query("ROLLBACK");
  }
}
async function decodedAdminRead(account = participantAccount) {
  const { packet } = (
    await admin.query(
      "SELECT read_shared_song_megapot_participation_v2($1,'test-community','test-song') AS packet",
      [account],
    )
  ).rows[0];
  const result = await Effect.runPromise(
    decodeSharedSongParticipation(packet, "test-community", "test-song"),
  );
  if (result.status !== "found" || result.participation === null)
    throw new Error("Funded projection required");
  return result.participation;
}

suite("shared-song participant read on actual PostgreSQL", () => {
  test("an account without membership, persona or wallet can read frozen rules and the bounded schedule", async () => {
    const result = await read(participantAccount, "test-community", "test-song");
    expect(result.status).toBe("found");
    if (result.status !== "found" || result.participation === null)
      throw new Error("Funded projection required");
    const p = result.participation;
    expect(p.participation_available).toBe(true);
    expect(p.confirmed_contributed_atomic).toBe("10000000");
    expect(p.remaining_budget_atomic).toBe("8000000");
    expect(p.drawings.map((row) => row.planned_drawing_id)).toEqual(["200", "201"]);
    expect(p.drawings[1]).toEqual({ kind: "not_open", planned_drawing_id: "201" });
    expect(p.qualification_rules.map((row) => row.binding.activity)).toEqual([
      "study",
      "karaoke",
      "dance",
    ]);
    expect(
      p.qualification_rules.find((row) => row.binding.activity === "dance")?.rule,
    ).toMatchObject({ grading_mode: "moderator_verdict", verdict: "passed" });
    expect(JSON.stringify(p)).not.toContain("rubricId");
    expect(JSON.stringify(p)).not.toContain("test-other-reader");
    expect(JSON.stringify(p)).not.toContain("test-owner-persona");
  });
  test("the read is stable, definer-owned and exposes no PUBLIC or table grant", async () => {
    const row = (
      await admin.query(
        `SELECT p.provolatile,p.prosecdef,p.proconfig,
      has_table_privilege($1,'reward_ledger_credits','SELECT') AS table_read,
      EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
      FROM pg_proc p WHERE p.oid='read_shared_song_megapot_participation_v2(text,text,text)'::regprocedure`,
        [role],
      )
    ).rows[0];
    expect(row).toMatchObject({
      provolatile: "s",
      prosecdef: true,
      table_read: false,
      public_execute: false,
    });
    expect(row.proconfig).toContain(`search_path=${schema}, pg_catalog, pg_temp`);
  });
  test("access rejection is distinct from an accessible song with no committed pot", async () => {
    expect(await read("missing-account", "test-community", "test-song")).toEqual({
      status: "not_found",
    });
    expect(await read(participantAccount, "test-community", "missing-song")).toEqual({
      status: "not_found",
    });
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role=replica");
      await admin.query(
        "UPDATE reward_song_slots_v2 SET target=NULL,terms=NULL WHERE slot_id='test-slot'",
      );
      const row = (
        await admin.query(
          "SELECT read_shared_song_megapot_participation_v2($1,'test-community','test-song') AS packet",
          [participantAccount],
        )
      ).rows[0];
      expect(row.packet).toBeNull();
    } finally {
      await admin.query("ROLLBACK");
    }
  });
  test("a second account receives no share or credit for someone else's live entry", async () => {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role=replica");
      await admin.query(
        `INSERT INTO megapot_pool_shares(pool_leg_id,drawing_id,account_id,persona_id,
        qualification_id,eligibility_decision_id,qualified_at) VALUES('test-leg',200,$1,'test-private-persona',
        'test-qualification','test-eligibility',statement_timestamp())`,
        [otherParticipantAccount],
      );
      const own = (
        await admin.query(
          "SELECT read_shared_song_megapot_participation_v2($1,'test-community','test-song') AS packet",
          [participantAccount],
        )
      ).rows[0].packet;
      expect(own.projection.drawings[0].drawing.beneficiary_count).toBe(1);
      expect(own.projection.drawings[0].standing).toEqual({ share_held: false, credit: null });
      const other = (
        await admin.query(
          "SELECT read_shared_song_megapot_participation_v2($1,'test-community','test-song') AS packet",
          [otherParticipantAccount],
        )
      ).rows[0].packet;
      expect(other.projection.drawings[0].standing).toEqual({ share_held: true, credit: null });
      expect(JSON.stringify(own)).not.toContain("test-private-persona");
    } finally {
      await admin.query("ROLLBACK");
    }
  });
  test("switching the admitted review rubric does not change the frozen categorical Dance rule", async () =>
    bootstrapTransaction(async () => {
      const before = await decodedAdminRead();
      await admin.query(
        "UPDATE dance_review_policy_admissions_v1 SET policy_id='test-review-b' WHERE community_id='test-community'",
      );
      const after = await decodedAdminRead();
      expect(after.qualification_rules).toEqual(before.qualification_rules);
      expect(
        after.qualification_rules.find((row) => row.binding.activity === "dance")
          ?.currently_available,
      ).toBe(true);
      expect(JSON.stringify(after)).not.toContain("routine-b");
    }));
  test("current activity unavailability preserves frozen terms and historical standing", async () =>
    bootstrapTransaction(async () => {
      const before = await decodedAdminRead();
      await admin.query(
        "UPDATE activity_registry SET status='reserved',producer_version=NULL,current_policy_version_id=NULL",
      );
      const after = await decodedAdminRead();
      expect(after.terms).toEqual(before.terms);
      expect(after.participation_available).toBe(false);
      expect(after.qualification_rules.every((row) => !row.currently_available)).toBe(true);
      expect(after.drawings).toEqual(before.drawings);
    }));
  test("a cutoff at the statement start is closed even if the drawing row is still entry_open", async () =>
    bootstrapTransaction(async () => {
      await admin.query(
        "UPDATE megapot_drawing_observations SET drawing_time=statement_timestamp()+interval '5 minutes' WHERE observation_id='test-observation'",
      );
      await admin.query(
        "UPDATE megapot_pool_drawings SET entry_cutoff_at=(SELECT drawing_time-interval '5 minutes' FROM megapot_drawing_observations WHERE observation_id='test-observation')",
      );
      const p = await decodedAdminRead();
      expect(p.drawings[0]).toMatchObject({
        kind: "materialized",
        drawing: { state: "entry_closed", lifecycle_status: "entry_open" },
      });
      const first = p.drawings[0];
      if (first?.kind !== "materialized") throw new Error("Drawing required");
      expect(Date.parse(first.drawing.entry_cutoff_at)).toBeLessThanOrEqual(Date.parse(p.as_of));
    }));
  test("budget inconsistency fails closed instead of displaying invented remaining funds", async () =>
    bootstrapTransaction(async () => {
      await admin.query(
        "UPDATE song_reward_offer_legs SET funded_atomic=11000000 WHERE leg_id='test-leg'",
      );
      await expect(decodedAdminRead()).rejects.toMatchObject({ code: "PCV05" });
    }));
  test("a hidden or age-restricted song and an inactive account remain unreadable", async () =>
    bootstrapTransaction(async () => {
      await admin.query(
        "UPDATE posts SET content_rating='adult_18',author_declared_rating='adult_18' WHERE post_id='test-song'",
      );
      let row = (
        await admin.query(
          "SELECT read_shared_song_megapot_participation_v2($1,'test-community','test-song') AS packet",
          [participantAccount],
        )
      ).rows[0];
      expect(row.packet).toEqual({ status: "not_found" });
      await admin.query(
        "UPDATE posts SET content_rating='general',author_declared_rating='general',visibility='members_only' WHERE post_id='test-song'",
      );
      row = (
        await admin.query(
          "SELECT read_shared_song_megapot_participation_v2($1,'test-community','test-song') AS packet",
          [participantAccount],
        )
      ).rows[0];
      expect(row.packet).toEqual({ status: "not_found" });
      await admin.query("UPDATE posts SET visibility='public' WHERE post_id='test-song'");
      await admin.query("UPDATE users SET status='deleted' WHERE user_id=$1", [participantAccount]);
      row = (
        await admin.query(
          "SELECT read_shared_song_megapot_participation_v2($1,'test-community','test-song') AS packet",
          [participantAccount],
        )
      ).rows[0];
      expect(row.packet).toEqual({ status: "not_found" });
    }));
  test("an earlier custody-backed credit stays visible when the next drawing is open", async () =>
    bootstrapTransaction(async () => {
      await seedParticipantWinHistory(admin);
      const p = await decodedAdminRead();
      expect(p.drawings[0]).toMatchObject({
        planned_drawing_id: "200",
        drawing: {
          state: "won",
          gross_prize_pool_atomic: "1000000000",
          net_winnings_atomic: "900000",
        },
        standing: {
          share_held: true,
          credit: {
            credit_id: "test-credit",
            amount_atomic: "450000",
            state: "credited",
            claim: { status: "unclaimed", payout_status: null },
          },
        },
      });
      expect(p.drawings[1]).toMatchObject({
        planned_drawing_id: "201",
        drawing: { state: "entry_open" },
        standing: { share_held: false, credit: null },
      });
      expect(JSON.stringify(p)).not.toContain("test-other-credit");
      expect(JSON.stringify(p)).not.toContain("test-other-persona");
    }));
  for (const [name, change, message] of [
    [
      "missing custody receipt",
      "DELETE FROM megapot_claim_receipt_evidence",
      "participant custody receipt unavailable",
    ],
    [
      "foreign credit account",
      "UPDATE reward_ledger_credits SET account_id='test-other-reader' WHERE credit_id='test-credit'",
      "participant credit ownership unavailable",
    ],
    [
      "wrong credit source",
      "UPDATE reward_ledger_credits SET source_reference='test-batch:1' WHERE credit_id='test-credit'",
      "participant credit ownership unavailable",
    ],
    [
      "missing positive allocation",
      "DELETE FROM megapot_allocations WHERE account_id='test-reader'",
      "participant allocation evidence unavailable",
    ],
    [
      "wrong private leaf ordinal",
      "UPDATE megapot_allocations SET ordinal=2 WHERE account_id='test-reader'",
      "participant credit ownership unavailable",
    ],
    [
      "unconfirmed custody",
      "UPDATE reward_chain_effects SET confirmations=2 WHERE effect_id='test-custody-claim'",
      "participant custody receipt unavailable",
    ],
  ] as const) {
    test(`refuses a claimable amount with ${name}`, async () =>
      bootstrapTransaction(async () => {
        await seedParticipantWinHistory(admin);
        const valid = await decodedAdminRead();
        expect(valid.drawings[0]).toMatchObject({
          standing: { credit: { amount_atomic: "450000" } },
        });
        await admin.query(change);
        await expect(decodedAdminRead()).rejects.toMatchObject({ code: "PCV05", message });
      }));
  }
  test("accepted Claim uses the existing payout vocabulary without exposing private verification", async () =>
    bootstrapTransaction(async () => {
      await seedParticipantWinHistory(admin);
      await admin.query(
        `INSERT INTO megapot_participant_claims(credit_id,account_id,pool_leg_id,drawing_id,status,
      subject_key_id,evidence_receipt_id,accepted_at) VALUES('test-credit',$1,'test-leg',200,'accepted',
      'test-private-subject','test-private-evidence',clock_timestamp())`,
        [participantAccount],
      );
      let p = await decodedAdminRead();
      expect(p.drawings[0]).toMatchObject({
        standing: { credit: { claim: { status: "accepted", payout_status: "recipient_pending" } } },
      });
      expect(JSON.stringify(p)).not.toContain("test-private-subject");
      expect(JSON.stringify(p)).not.toContain("test-private-evidence");
      await admin.query(
        "UPDATE reward_ledger_credits SET state='payout_pending' WHERE credit_id='test-credit'",
      );
      p = await decodedAdminRead();
      expect(p.drawings[0]).toMatchObject({
        standing: { credit: { claim: { status: "accepted", payout_status: "submitted" } } },
      });
    }));
});

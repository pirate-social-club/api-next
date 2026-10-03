/** Minimal admission/lock fixture. Full repository tests separately prove money lineage. */
import { Client } from "pg";

export async function withSettlingAdmissionFixture(
  url: string,
  use: (fixture: {
    admin: Client;
    writer: Client;
    operator: Client;
    later: Client;
    schema: string;
    runtimeRole: string;
  }) => Promise<void>,
  options: { readonly seedHistory?: boolean } = {},
) {
  const suffix = `${process.pid}_${Date.now()}`;
  const schema = `reward_settling_${suffix}`;
  const runtimeRole = `reward_runtime_${suffix}`;
  const operatorRole = `reward_operator_${suffix}`;
  const admin = new Client({ connectionString: url });
  const writer = new Client({ connectionString: url });
  const operator = new Client({ connectionString: url });
  const later = new Client({ connectionString: url });
  await Promise.all([admin.connect(), writer.connect(), operator.connect(), later.connect()]);
  try {
    await admin.query(`CREATE SCHEMA "${schema}"; CREATE ROLE "${runtimeRole}"; CREATE ROLE "${operatorRole}";
      SET search_path TO "${schema}";
      ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT ALL ON TABLES TO "${runtimeRole}";
      ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT EXECUTE ON FUNCTIONS TO "${runtimeRole}"`);
    const baseline = await Bun.file(
      new URL("../../../db/postgres/schema.sql", import.meta.url),
    ).text();
    const nonceDdl = baseline.match(/CREATE TABLE reward_signer_nonces \([\s\S]*?\n\);/u)?.[0];
    if (!nonceDdl) throw Error("nonce DDL missing");
    await admin.query(nonceDdl);
    await admin.query(`
      CREATE FUNCTION guard_reward_signer_nonce() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER reward_signer_nonces_change_guard BEFORE INSERT OR UPDATE OR DELETE ON reward_signer_nonces
        FOR EACH ROW EXECUTE FUNCTION guard_reward_signer_nonce();
      CREATE TABLE song_reward_offers(id TEXT PRIMARY KEY);
      CREATE TABLE song_reward_offer_legs(id TEXT PRIMARY KEY);
      CREATE TABLE song_reward_leg_funding_effects(funding_effect_id TEXT PRIMARY KEY,leg_id TEXT,state TEXT);
      CREATE TABLE activity_qualifications(id TEXT PRIMARY KEY);
      CREATE TABLE megapot_pool_shares(id TEXT PRIMARY KEY);
      CREATE TABLE song_reward_bundle_claims(id TEXT PRIMARY KEY);
      CREATE TABLE song_reward_bundle_claim_legs(id TEXT PRIMARY KEY);
      CREATE TABLE reward_ledger_credits(credit_id TEXT PRIMARY KEY,source_kind TEXT);
      CREATE TABLE reward_chain_effects(effect_id TEXT PRIMARY KEY,effect_kind TEXT,state TEXT,
        chain_id BIGINT,signer_address TEXT,nonce NUMERIC(78,0),replacement_of_effect_id TEXT,replaced_by_effect_id TEXT,
        target_address TEXT DEFAULT 'token',value_wei NUMERIC(78,0) DEFAULT 0,reserved_amount_atomic NUMERIC(78,0) DEFAULT 0,
        calldata TEXT,calldata_hash TEXT,signed_transaction TEXT,signed_transaction_hash TEXT);
      CREATE TABLE reward_refund_effects(refund_effect_id TEXT PRIMARY KEY,funding_effect_id TEXT,leg_id TEXT);
      CREATE TABLE reward_payout_effects(payout_effect_id TEXT PRIMARY KEY,credit_id TEXT);
      CREATE TABLE megapot_claim_effects(claim_effect_id TEXT PRIMARY KEY,attestation_id TEXT,ticket_id NUMERIC(78,0));
      CREATE TABLE megapot_ticket_inventory(attestation_id TEXT,ticket_id NUMERIC(78,0),purchase_effect_id TEXT);
      CREATE FUNCTION project_asset_bonus_claim_from_qualification() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO song_reward_bundle_claims VALUES(NEW.id); RETURN NEW; END $$;
      CREATE FUNCTION project_megapot_pool_share_from_qualification() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO megapot_pool_shares VALUES(NEW.id); RETURN NEW; END $$;
      CREATE TRIGGER activity_qualifications_project_asset_bonus_claim AFTER INSERT ON activity_qualifications
        FOR EACH ROW EXECUTE FUNCTION project_asset_bonus_claim_from_qualification();
      CREATE TRIGGER activity_qualifications_project_megapot_share AFTER INSERT ON activity_qualifications
        FOR EACH ROW EXECUTE FUNCTION project_megapot_pool_share_from_qualification()`);
    for (const migration of [
      "0230_reward_operations_control.sql",
      "0231_reward_http_admission.sql",
      "0236_reward_settling_control.sql",
    ]) {
      if (migration === "0236_reward_settling_control.sql" && options.seedHistory)
        await admin.query(
          "SELECT set_reward_operations_paused_v1(0,FALSE,'historic_running'); SELECT set_reward_operations_paused_v1(1,TRUE,'historic_pause')",
        );
      await admin.query(
        await Bun.file(
          new URL(`../../../db/postgres/migrations/${migration}`, import.meta.url),
        ).text(),
      );
    }
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${runtimeRole}","${operatorRole}";
      GRANT EXECUTE ON FUNCTION set_reward_operations_state_v2(BIGINT,TEXT,TEXT),
        set_reward_operations_paused_v1(BIGINT,BOOLEAN,TEXT) TO "${operatorRole}";
      GRANT SELECT ON reward_operations_control,reward_operations_control_events TO "${operatorRole}"`);
    for (const [client, role] of [
      [writer, runtimeRole],
      [later, runtimeRole],
      [operator, operatorRole],
    ] as const)
      await client.query(
        `SET search_path TO "${schema}"; SET ROLE "${role}"; SET statement_timeout='10s'`,
      );
    await use({ admin, writer, operator, later, schema, runtimeRole });
  } finally {
    await Promise.all(
      [writer.query("ROLLBACK"), operator.query("ROLLBACK"), later.query("ROLLBACK")].map(
        (result) => result.catch(() => undefined),
      ),
    );
    await Promise.all([writer.end(), operator.end(), later.end()]);
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.query(
      `DROP OWNED BY "${runtimeRole}","${operatorRole}"; DROP ROLE "${runtimeRole}","${operatorRole}"`,
    );
    await admin.end();
  }
}

export const insertAdmissionNonce = (client: Client, signer: string) =>
  client.query(
    `INSERT INTO reward_signer_nonces
    (chain_id,signer_address,next_nonce,observed_pending_nonce,observed_block_number,observed_block_hash,observed_at)
    VALUES(84532,$1,1,0,1,$2,clock_timestamp())`,
    [signer, `0x${"a".repeat(64)}`],
  );

export const insertAdmissionEffect = (client: Client, id: string, kind: string, signer: string) =>
  client.query(
    `INSERT INTO reward_chain_effects(effect_id,effect_kind,state,chain_id,signer_address)
    VALUES($1,$2,'planned',84532,$3)`,
    [id, kind, signer],
  );

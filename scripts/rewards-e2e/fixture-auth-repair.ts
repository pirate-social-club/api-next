import { createHash } from "node:crypto";
import { Client } from "pg";
import { normalizePostgresConnectionString } from "../postgres-connection-string.ts";
import {
  type IsolatedDatabaseIdentity,
  validateIsolatedDatabaseIdentity,
} from "./bootstrap-database.ts";
import { verifyRetiredDatabase } from "./retired-stack-inventory.ts";
import { fixture } from "./seed-fixtures.ts";

type Credential = {
  credential_id: string;
  provider: string;
  provider_app_id: string;
  provider_subject: string;
  canonical_user_id: string;
  status: string;
  created_at: string;
  updated_at: string;
};
/** Restore exact fixture provider mappings. Existing immutable mappings are reconciled by a normal alias, never overwritten. */
export async function repairFixtureAuthentication(
  sourceUrl: string,
  targetUrl: string,
  identity: IsolatedDatabaseIdentity,
  apply = false,
) {
  verifyRetiredDatabase(sourceUrl);
  validateIsolatedDatabaseIdentity(targetUrl, identity);
  const source = new Client({
    connectionString: normalizePostgresConnectionString(sourceUrl),
    connectionTimeoutMillis: 20000,
  });
  const target = new Client({
    connectionString: normalizePostgresConnectionString(targetUrl),
    connectionTimeoutMillis: 20000,
  });
  await source.connect();
  try {
    await target.connect();
    try {
      await source.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const credentials = (
        await source.query<Credential>(
          "SELECT * FROM api_next.identity_credentials WHERE canonical_user_id=ANY($1::text[]) AND status='active'",
          [fixture.accounts],
        )
      ).rows;
      if (
        credentials.length !== fixture.accounts.length ||
        new Set(credentials.map((row) => row.canonical_user_id)).size !== fixture.accounts.length
      )
        throw Error("Fixture source credential inventory differs");
      await target.query("BEGIN");
      await target.query("SET LOCAL search_path TO api_next, public");
      try {
        const receipt = await target.query(
          `SELECT finished FROM rewards_bootstrap_${identity.branchId}.receipt WHERE branch_id=$1`,
          [identity.branchId],
        );
        if (receipt.rows.length !== 1 || receipt.rows[0].finished !== true)
          throw Error("Completed isolated bootstrap required");
        const activity = await target.query(
          "SELECT (SELECT count(*) FROM api_next.reward_chain_effects)+(SELECT count(*) FROM api_next.song_reward_offers)+(SELECT count(*) FROM api_next.karaoke_attempts)+(SELECT count(*) FROM api_next.study_sessions_v2) AS total",
        );
        if (String(activity.rows[0].total) !== "0")
          throw Error("Authentication seed repair requires no attempts or money");
        const ageRows = (
          await source.query(
            "SELECT * FROM api_next.account_minimum_age_attestations WHERE account_id=ANY($1::text[])",
            [fixture.accounts],
          )
        ).rows;
        if (
          ageRows.length !== fixture.accounts.length ||
          ageRows.some(
            (row) =>
              row.version !== "minimum-age-attestation-v1" ||
              row.minimum_age !== 16 ||
              row.affirmed !== true,
          )
        )
          throw Error("Fixture source minimum-age attestations missing");
        for (const row of ageRows) {
          if (apply)
            await target.query(
              "INSERT INTO api_next.account_minimum_age_attestations (account_id,version,minimum_age,affirmed,attested_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (account_id) DO NOTHING",
              [
                row.account_id,
                row.version,
                row.minimum_age,
                row.affirmed,
                row.attested_at,
                row.updated_at,
              ],
            );
        }
        const slugRows = (
          await source.query("SELECT * FROM api_next.post_slug_aliases WHERE post_id=$1", [
            fixture.song,
          ])
        ).rows;
        if (slugRows.length !== 1 || slugRows[0].slug_policy_version !== "post-slug-v1")
          throw Error("Fixture source canonical post route missing");
        if (apply)
          await target.query(
            "INSERT INTO api_next.post_slug_aliases (slug,post_id,slug_policy_version,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (post_id) DO NOTHING",
            [
              slugRows[0].slug,
              fixture.song,
              slugRows[0].slug_policy_version,
              slugRows[0].created_at,
            ],
          );
        const report = [];
        for (const row of credentials) {
          if (row.provider !== "privy" || row.provider_app_id !== "cmsw5pis300b80cladbxx7bsr")
            throw Error("Fixture provider differs");
          const existing = (
            await target.query<Credential>(
              "SELECT * FROM api_next.identity_credentials WHERE provider=$1 AND provider_app_id=$2 AND provider_subject=$3",
              [row.provider, row.provider_app_id, row.provider_subject],
            )
          ).rows;
          if (existing.length > 1 || existing[0]?.status === "tombstoned")
            throw Error("Existing fixture credential refused");
          let action = "already-mapped";
          if (existing.length === 0) {
            action = "import-exact-credential";
            if (apply)
              await target.query(
                "INSERT INTO api_next.identity_credentials (credential_id,provider,provider_app_id,provider_subject,canonical_user_id,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
                [
                  row.credential_id,
                  row.provider,
                  row.provider_app_id,
                  row.provider_subject,
                  row.canonical_user_id,
                  row.status,
                  row.created_at,
                  row.updated_at,
                ],
              );
          } else if (existing[0] && existing[0].canonical_user_id !== row.canonical_user_id) {
            action = "preserve-registration-with-fixture-alias";
            const from = existing[0].canonical_user_id;
            if (fixture.accounts.includes(from)) throw Error("Cannot alias another fixture actor");
            const aliases = (
              await target.query(
                "SELECT canonical_user_id,kind,status FROM api_next.account_aliases WHERE source_user_id=$1 OR source_user_id=$2",
                [from, row.canonical_user_id],
              )
            ).rows;
            if (
              aliases.length &&
              !(
                aliases.length === 1 &&
                aliases[0].canonical_user_id === row.canonical_user_id &&
                aliases[0].kind === "alias" &&
                aliases[0].status === "active"
              )
            )
              throw Error("Unexpected alias topology");
            if (apply && aliases.length === 0)
              await target.query(
                "INSERT INTO api_next.account_aliases (source_user_id,canonical_user_id,kind,status) VALUES ($1,$2,'alias','active')",
                [from, row.canonical_user_id],
              );
          }
          report.push({
            accountId: row.canonical_user_id,
            providerSubjectSha256: createHash("sha256").update(row.provider_subject).digest("hex"),
            action,
          });
        }
        await target.query(apply ? "COMMIT" : "ROLLBACK");
        await source.query("COMMIT");
        return {
          applied: apply,
          scope: "isolated fixture identity migration; real Privy verification unchanged",
          credentials: report,
        };
      } catch (error) {
        await target.query("ROLLBACK").catch(() => {});
        throw error;
      }
    } finally {
      await target.end();
    }
  } finally {
    await source.end();
  }
}

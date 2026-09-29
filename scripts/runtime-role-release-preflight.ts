/** Read-only privilege and ledger gate for rewards and sponsored Wallet releases. */
import pg from "pg";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";
import { loadPostgresMigrations } from "./postgres-migrations.ts";

type Privilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "EXECUTE";
type Requirement = Readonly<{
  object: string;
  privilege: Privilege;
  allowed: boolean;
}>;

/** Keep allowed operations in sync with direct SQL in reward, Megapot and Wallet repositories. */
export const RUNTIME_RELEASE_PRIVILEGES: readonly Requirement[] = [
  { object: "wallet_sponsored_sends", privilege: "SELECT", allowed: true },
  { object: "wallet_sponsored_sends", privilege: "INSERT", allowed: true },
  { object: "wallet_sponsored_sends", privilege: "UPDATE", allowed: true },
  { object: "wallet_sponsored_sends", privilege: "DELETE", allowed: false },
  { object: "persona_wallet_assignments", privilege: "SELECT", allowed: true },
  { object: "personas", privilege: "SELECT", allowed: true },
  { object: "reward_ledger_credits", privilege: "SELECT", allowed: true },
  { object: "reward_asset_whitelist", privilege: "SELECT", allowed: true },
  { object: "megapot_participant_claims", privilege: "SELECT", allowed: true },
  { object: "megapot_participant_claims", privilege: "INSERT", allowed: false },
  { object: "megapot_participant_claims", privilege: "UPDATE", allowed: false },
  { object: "megapot_participant_claims", privilege: "DELETE", allowed: false },
  { object: "megapot_participant_claim_guards", privilege: "INSERT", allowed: false },
  { object: "megapot_participant_claim_guards", privilege: "UPDATE", allowed: false },
  { object: "megapot_participant_claim_guards", privilege: "DELETE", allowed: false },
  { object: "reward_winner_sends", privilege: "SELECT", allowed: true },
  { object: "reward_payout_effects", privilege: "SELECT", allowed: true },
  { object: "reward_chain_effects", privilege: "SELECT", allowed: true },
  { object: "reward_chain_effects", privilege: "INSERT", allowed: true },
  { object: "reward_chain_effects", privilege: "UPDATE", allowed: true },
  { object: "reward_chain_effect_transitions", privilege: "INSERT", allowed: true },
  { object: "reward_signer_nonces", privilege: "SELECT", allowed: true },
  { object: "reward_signer_nonces", privilege: "INSERT", allowed: true },
  { object: "reward_signer_nonces", privilege: "UPDATE", allowed: true },
  { object: "megapot_pool_drawings", privilege: "SELECT", allowed: true },
  { object: "megapot_pool_drawings", privilege: "UPDATE", allowed: true },
  { object: "song_reward_offer_legs", privilege: "SELECT", allowed: true },
  { object: "megapot_drawing_sweeps", privilege: "SELECT", allowed: true },
  { object: "megapot_sweep_ticket_evidence", privilege: "SELECT", allowed: true },
  { object: "megapot_ticket_inventory", privilege: "SELECT", allowed: true },
  { object: "megapot_ticket_inventory", privilege: "UPDATE", allowed: true },
  { object: "megapot_deployment_attestations", privilege: "SELECT", allowed: true },
  { object: "megapot_claim_effects", privilege: "SELECT", allowed: true },
  { object: "megapot_claim_effects", privilege: "INSERT", allowed: true },
  { object: "megapot_claim_effects", privilege: "UPDATE", allowed: true },
  { object: "megapot_claim_receipt_evidence", privilege: "SELECT", allowed: true },
  { object: "megapot_claim_receipt_evidence", privilege: "INSERT", allowed: true },
  { object: "megapot_pool_drawing_transitions", privilege: "INSERT", allowed: true },
  { object: "megapot_ticket_review_evidence", privilege: "INSERT", allowed: true },
  { object: "platform_referral_revenue_ledger", privilege: "INSERT", allowed: true },
  { object: "action_intents", privilege: "SELECT", allowed: true },
  { object: "action_intents", privilege: "INSERT", allowed: true },
  { object: "proof_sessions", privilege: "SELECT", allowed: true },
  { object: "community_memberships", privilege: "SELECT", allowed: true },
  { object: "custody_solvency_observations", privilege: "SELECT", allowed: true },
  { object: "megapot_allocation_batches", privilege: "INSERT", allowed: true },
  { object: "megapot_allocation_batches", privilege: "SELECT", allowed: true },
  { object: "megapot_allocation_batches", privilege: "UPDATE", allowed: true },
  { object: "megapot_allocations", privilege: "INSERT", allowed: true },
  { object: "megapot_allocations", privilege: "SELECT", allowed: true },
  { object: "megapot_drawing_observations", privilege: "INSERT", allowed: true },
  { object: "megapot_drawing_observations", privilege: "SELECT", allowed: true },
  { object: "megapot_drawing_sweeps", privilege: "INSERT", allowed: true },
  { object: "megapot_fallback_cutoff_activity_evidence", privilege: "INSERT", allowed: true },
  { object: "megapot_fallback_cutoff_evidence", privilege: "INSERT", allowed: true },
  { object: "megapot_fallback_cutoff_evidence", privilege: "SELECT", allowed: true },
  { object: "megapot_pool_beneficiary_snapshots", privilege: "INSERT", allowed: true },
  { object: "megapot_pool_beneficiary_snapshots", privilege: "SELECT", allowed: true },
  { object: "megapot_pool_commitment_effects", privilege: "INSERT", allowed: true },
  { object: "megapot_pool_commitment_effects", privilege: "SELECT", allowed: true },
  { object: "megapot_pool_commitment_effects", privilege: "UPDATE", allowed: true },
  { object: "megapot_pool_drawings", privilege: "INSERT", allowed: true },
  { object: "megapot_pool_shares", privilege: "SELECT", allowed: true },
  { object: "megapot_pool_snapshot_private_leaves", privilege: "INSERT", allowed: true },
  { object: "megapot_pool_snapshot_private_leaves", privilege: "SELECT", allowed: true },
  { object: "megapot_purchase_receipt_evidence", privilege: "INSERT", allowed: true },
  { object: "megapot_purchase_receipt_evidence", privilege: "SELECT", allowed: true },
  { object: "megapot_sweep_ticket_evidence", privilege: "INSERT", allowed: true },
  { object: "megapot_ticket_inventory", privilege: "INSERT", allowed: true },
  { object: "megapot_ticket_purchase_effects", privilege: "INSERT", allowed: true },
  { object: "megapot_ticket_purchase_effects", privilege: "SELECT", allowed: true },
  { object: "megapot_usdc_approval_effects", privilege: "INSERT", allowed: true },
  { object: "megapot_usdc_approval_effects", privilege: "SELECT", allowed: true },
  { object: "megapot_usdc_approval_receipt_evidence", privilege: "INSERT", allowed: true },
  { object: "megapot_usdc_approval_receipt_evidence", privilege: "SELECT", allowed: true },
  { object: "platform_sponsorship_budget_entries", privilege: "INSERT", allowed: true },
  { object: "platform_sponsorship_budgets", privilege: "SELECT", allowed: true },
  { object: "platform_sponsorship_budgets", privilege: "UPDATE", allowed: true },
  { object: "posts", privilege: "SELECT", allowed: true },
  { object: "reward_activity_availability_observations", privilege: "SELECT", allowed: true },
  { object: "reward_eligibility_decisions", privilege: "SELECT", allowed: true },
  { object: "reward_erc20_transfer_receipt_evidence", privilege: "INSERT", allowed: true },
  { object: "reward_erc20_transfer_receipt_evidence", privilege: "SELECT", allowed: true },
  { object: "reward_gas_topup_daily_budgets", privilege: "INSERT", allowed: true },
  { object: "reward_gas_topup_daily_budgets", privilege: "SELECT", allowed: true },
  { object: "reward_gas_topup_daily_budgets", privilege: "UPDATE", allowed: true },
  { object: "reward_gas_topup_wallets", privilege: "SELECT", allowed: true },
  { object: "reward_gas_topups", privilege: "INSERT", allowed: true },
  { object: "reward_gas_topups", privilege: "SELECT", allowed: true },
  { object: "reward_gas_topups", privilege: "UPDATE", allowed: true },
  { object: "reward_ledger_credits", privilege: "INSERT", allowed: true },
  { object: "reward_ledger_credits", privilege: "UPDATE", allowed: true },
  { object: "reward_native_transfer_receipt_evidence", privilege: "INSERT", allowed: true },
  { object: "reward_payout_effects", privilege: "INSERT", allowed: true },
  { object: "reward_refund_effects", privilege: "INSERT", allowed: true },
  { object: "reward_refund_effects", privilege: "SELECT", allowed: true },
  { object: "reward_winner_send_attempts", privilege: "INSERT", allowed: true },
  { object: "reward_winner_send_attempts", privilege: "SELECT", allowed: true },
  { object: "reward_winner_send_outcomes", privilege: "INSERT", allowed: true },
  { object: "reward_winner_send_transactions", privilege: "INSERT", allowed: true },
  { object: "reward_winner_send_transactions", privilege: "SELECT", allowed: true },
  { object: "reward_winner_sends", privilege: "INSERT", allowed: true },
  { object: "reward_winner_sends", privilege: "UPDATE", allowed: true },
  { object: "song_reward_bundle_claim_legs", privilege: "SELECT", allowed: true },
  { object: "song_reward_bundle_claims", privilege: "SELECT", allowed: true },
  { object: "song_reward_leg_funding_effects", privilege: "INSERT", allowed: true },
  { object: "song_reward_leg_funding_effects", privilege: "SELECT", allowed: true },
  { object: "song_reward_leg_funding_effects", privilege: "UPDATE", allowed: true },
  { object: "song_reward_offer_legs", privilege: "UPDATE", allowed: true },
  { object: "song_reward_offers", privilege: "SELECT", allowed: true },
  { object: "song_reward_offers", privilege: "UPDATE", allowed: true },
  { object: "sponsor_daily_ticket_totals", privilege: "INSERT", allowed: true },
  { object: "sponsor_daily_ticket_totals", privilege: "UPDATE", allowed: true },
  {
    object: "accept_megapot_participant_claim_v1(text,text)",
    privilege: "EXECUTE",
    allowed: true,
  },
] as const;

type PrivilegeFact = Readonly<{
  object: string;
  privilege: Privilege;
  expected: boolean;
  exists: boolean;
  allowed: boolean;
}>;

type LedgerRow = Readonly<{ version: string; checksum: string }>;

export function privilegeViolations(facts: readonly PrivilegeFact[]): string[] {
  return facts.flatMap((fact) =>
    !fact.exists || fact.allowed !== fact.expected
      ? [`${fact.object}: ${fact.privilege} ${fact.exists ? "mismatch" : "object missing"}`]
      : [],
  );
}

export function assertMainLedger(ledger: readonly LedgerRow[], plan: readonly LedgerRow[]): void {
  if (ledger.length !== plan.length) throw new Error("release migration ledger length mismatch");
  for (const [index, row] of ledger.entries()) {
    if (row.version !== plan[index]?.version || row.checksum !== plan[index]?.checksum) {
      throw new Error(`release migration ledger mismatch at position ${index + 1}`);
    }
  }
}

export async function runRuntimeRoleReleasePreflight(input: {
  runtimeConnectionString: string;
  adminConnectionString?: string;
  requireMainLedger: boolean;
}) {
  if (input.requireMainLedger && !input.adminConnectionString) {
    throw new Error("admin URL required for main-source ledger check");
  }
  const runtime = new pg.Client({
    connectionString: normalizePostgresConnectionString(input.runtimeConnectionString),
  });
  await runtime.connect();
  let principal = "unknown";
  let facts: PrivilegeFact[] = [];
  try {
    await runtime.query("BEGIN READ ONLY");
    const identity = await runtime.query<{ principal: string; schema_usage: boolean }>(
      "SELECT current_user AS principal, has_schema_privilege(current_user,'api_next','USAGE') AS schema_usage",
    );
    principal = identity.rows[0]?.principal ?? "unknown";
    if (identity.rows.length !== 1 || !identity.rows[0]?.schema_usage) {
      throw new Error("runtime role lacks api_next schema USAGE");
    }
    const tables = RUNTIME_RELEASE_PRIVILEGES.filter((item) => item.privilege !== "EXECUTE");
    const routines = RUNTIME_RELEASE_PRIVILEGES.filter((item) => item.privilege === "EXECUTE");
    const tableResult = await runtime.query<PrivilegeFact>(
      `SELECT requirement.object, requirement.privilege, requirement.expected,
              to_regclass(format('%I.%I','api_next',requirement.object)) IS NOT NULL AS exists,
              COALESCE(has_table_privilege(current_user,
                to_regclass(format('%I.%I','api_next',requirement.object)),
                requirement.privilege),false) AS allowed
         FROM jsonb_to_recordset($1::jsonb)
           AS requirement(object text, privilege text, expected boolean)`,
      [
        JSON.stringify(
          tables.map((item) => ({
            object: item.object,
            privilege: item.privilege,
            expected: item.allowed,
          })),
        ),
      ],
    );
    const routineResult = await runtime.query<PrivilegeFact>(
      `SELECT requirement.object, requirement.privilege, requirement.expected,
              to_regprocedure('api_next.' || requirement.object) IS NOT NULL AS exists,
              COALESCE(has_function_privilege(current_user,
                to_regprocedure('api_next.' || requirement.object),
                requirement.privilege),false) AS allowed
         FROM jsonb_to_recordset($1::jsonb)
           AS requirement(object text, privilege text, expected boolean)`,
      [
        JSON.stringify(
          routines.map((item) => ({
            object: item.object,
            privilege: item.privilege,
            expected: item.allowed,
          })),
        ),
      ],
    );
    facts = [...tableResult.rows, ...routineResult.rows];
    await runtime.query("ROLLBACK");
  } catch (error) {
    await runtime.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await runtime.end();
  }
  if (facts.length !== RUNTIME_RELEASE_PRIVILEGES.length) {
    throw new Error("runtime privilege fact count mismatch");
  }
  const violations = privilegeViolations(facts);
  if (violations.length > 0)
    throw new Error(`runtime privilege preflight refused: ${violations.join("; ")}`);

  let migrationCount: number | null = null;
  if (input.requireMainLedger) {
    const plan = (await loadPostgresMigrations()).map(({ version, checksum }) => ({
      version,
      checksum,
    }));
    const admin = new pg.Client({
      connectionString: normalizePostgresConnectionString(input.adminConnectionString as string),
    });
    await admin.connect();
    try {
      await admin.query("BEGIN READ ONLY");
      const result = await admin.query<LedgerRow>(
        "SELECT version,checksum FROM api_next.schema_migrations ORDER BY version",
      );
      assertMainLedger(result.rows, plan);
      migrationCount = result.rows.length;
      await admin.query("ROLLBACK");
    } catch (error) {
      await admin.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await admin.end();
    }
  }
  return { ready: true as const, principal, checkedPrivileges: facts.length, migrationCount };
}

if (import.meta.main) {
  const privilegesOnly = process.argv.slice(2).join(" ") === "--privileges-only";
  if (!privilegesOnly && process.argv.length !== 2) throw new Error("unknown option");
  const runtimeConnectionString =
    process.env.RUNTIME_POSTGRES_URL ?? process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL;
  const adminConnectionString =
    process.env.ADMIN_POSTGRES_URL ?? process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL;
  if (!runtimeConnectionString) throw new Error("runtime Postgres URL is required");
  const result = await runRuntimeRoleReleasePreflight({
    runtimeConnectionString,
    ...(adminConnectionString === undefined ? {} : { adminConnectionString }),
    requireMainLedger: !privilegesOnly,
  });
  console.log(JSON.stringify(result));
}

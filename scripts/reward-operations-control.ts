import { Client } from "pg";

export type RewardOperationsCommand = {
  readonly paused: boolean;
  readonly expectedRevision: string;
  readonly reason: string;
};

export function parseRewardOperationsCommand(args: readonly string[]): RewardOperationsCommand {
  const [mode, expectedRevision, reason] = args;
  if (
    args.length !== 3 ||
    (mode !== "pause" && mode !== "resume") ||
    expectedRevision === undefined ||
    !/^(0|[1-9][0-9]*)$/u.test(expectedRevision) ||
    reason === undefined ||
    Buffer.byteLength(reason.trim()) < 1 ||
    Buffer.byteLength(reason.trim()) > 256
  ) {
    throw new Error("Usage: reward-operations-control pause|resume expected_revision reason");
  }
  return { paused: mode === "pause", expectedRevision, reason: reason.trim() };
}

/** No rollback to running on any failure. The database function owns the cut-over lock. */
export async function setRewardOperationsControl(client: Client, command: RewardOperationsCommand) {
  const changed = await client.query<{ revision: string }>(
    "SELECT set_reward_operations_paused_v1($1::bigint,$2::boolean,$3::text)::text AS revision",
    [command.expectedRevision, command.paused, command.reason],
  );
  const control = await client.query(
    "SELECT paused,revision::text,reason,changed_at FROM reward_operations_control WHERE singleton",
  );
  const row = control.rows[0];
  if (
    control.rowCount !== 1 ||
    row.paused !== command.paused ||
    row.revision !== changed.rows[0]?.revision
  ) {
    throw new Error("Reward control readback failed; inspect the control before further action");
  }
  const admitted = await client.query(
    `SELECT effect_kind,state,count(*)::text AS effects
       FROM reward_chain_effects
      WHERE nonce IS NOT NULL AND state IN
        ('nonce_reserved','prepared','broadcast_pending','confirming','reconciliation_required')
      GROUP BY effect_kind,state ORDER BY effect_kind,state`,
  );
  return { control: row, admitted: admitted.rows };
}

if (import.meta.main) {
  try {
    const command = parseRewardOperationsCommand(process.argv.slice(2));
    const connectionString = process.env.REWARD_OPERATIONS_OPERATOR_DATABASE_URL?.trim();
    if (!connectionString) throw new Error("REWARD_OPERATIONS_OPERATOR_DATABASE_URL is required");
    const client = new Client({
      connectionString,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
      application_name: "reward_operations_operator",
    });
    await client.connect();
    try {
      console.log(JSON.stringify(await setRewardOperationsControl(client, command)));
    } finally {
      await client.end();
    }
  } catch {
    console.error(
      "Reward control operation failed. No compensating resume was attempted. Read the control and audit trail before taking over.",
    );
    process.exitCode = 1;
  }
}

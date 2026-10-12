import type { ControlPlaneDb, ControlPlaneTransaction } from "@pirate/application";
import { SpacesOwnerProofRefused } from "@pirate/contracts";
import { Effect } from "effect";

export const iso = (value: unknown): string => new Date(value as string).toISOString();
export const text = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("Invalid Spaces ceremony row");
  return value;
};
export const number = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Invalid Spaces ceremony row");
  return parsed;
};

export type Row = Readonly<Record<string, unknown>>;
export type Transaction = ControlPlaneTransaction;

export const query = async (
  tx: Transaction,
  label: string,
  sql: string,
  values: readonly unknown[],
) => Effect.runPromise(tx.execute<Row>({ label, text: sql, values, readonly: false }));

export const one = (rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new Error("Invalid Spaces ceremony cardinality");
  return rows[0];
};

export const databaseNow = async (tx: Transaction): Promise<string> =>
  iso(one((await query(tx, "spaces-owner.clock", "SELECT clock_timestamp() AS now", [])).rows).now);

export const transact = <T>(
  db: ControlPlaneDb["Service"],
  action: (tx: Transaction) => Promise<T>,
): Promise<T> =>
  Effect.runPromise(
    db.withTransaction((tx) => Effect.tryPromise({ try: () => action(tx), catch: (e) => e })),
  );

export const lockRoot = async (
  tx: Transaction,
  environment: string,
  root: string,
): Promise<void> => {
  await query(
    tx,
    "spaces-owner.root.lock",
    "SELECT pg_advisory_xact_lock(hashtextextended($1,202612))",
    [`${environment}:mainnet:${root}`],
  );
};

export const checkAuthority = async (
  tx: Transaction,
  accountId: string,
  communityId: string,
): Promise<void> => {
  const result = await query(
    tx,
    "spaces-owner.sales-authority",
    `
    SELECT authority_grant.grant_id FROM community_handle_sales_authority_grants AS authority_grant
    JOIN communities AS community ON community.community_id=authority_grant.community_id
    WHERE authority_grant.community_id=$1 AND authority_grant.principal_account_id=$2
      AND authority_grant.authority='manage_handle_sales' AND authority_grant.status='active'
      AND community.status='active'
    FOR SHARE OF authority_grant,community`,
    [communityId, accountId],
  );
  if (result.rows.length !== 1) throw new SpacesOwnerProofRefused("forbidden");
};

export const checkMainnet = async (tx: Transaction): Promise<void> => {
  const result = await query(
    tx,
    "spaces-owner.network",
    `
    SELECT network FROM spaces_network_configuration
    WHERE configuration_key='spaces_network_v1' FOR SHARE`,
    [],
  );
  if (result.rows.length !== 1 || result.rows[0]?.network !== "mainnet") {
    throw new SpacesOwnerProofRefused("unavailable");
  }
};

export const challengeResponse = (row: Row, replayed: boolean) => ({
  contract: "pirate-spaces-ownership-start-v1" as const,
  ceremony_id: text(row.ceremony_id),
  generation: number(row.generation),
  network: "mainnet" as const,
  canonical_root: text(row.canonical_root),
  root_outpoint: text(row.root_outpoint),
  root_key_hex: text(row.root_key_hex),
  challenge_message: text(row.challenge_message),
  challenge_digest_hex: text(row.challenge_digest_hex),
  expires_at: iso(row.expires_at),
  replayed,
});

export const terminalResponse = (row: Row, replayed: boolean) => {
  if (typeof row.terminal_response !== "object" || row.terminal_response === null) {
    throw new Error("Missing Spaces ceremony terminal response");
  }
  return { ...row.terminal_response, replayed };
};

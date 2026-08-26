import type { Client } from "pg";

type PersonaProfileFixture = Readonly<{
  displayName?: string | null;
  bio?: string | null;
  preferredLocale?: string | null;
}>;

const activationStatements = [
  `UPDATE persona_wallet_assignments AS assignment
     SET status='active',
         privy_wallet_id='fixture-' || assignment.assignment_id,
         address=coalesce(
           $2::text,
           '0x' || left(md5(assignment.assignment_id) || md5(assignment.assignment_id || ':wallet'), 40)
         ),
         assigned_at=greatest(clock_timestamp(), assignment.created_at),
         updated_at=greatest(clock_timestamp(), assignment.created_at)
    FROM personas AS persona
   WHERE persona.persona_id=assignment.persona_id
     AND persona.status='pending_wallet'
     AND assignment.status='pending'
     AND ($1::text[] IS NULL OR persona.persona_id=ANY($1::text[]))`,
  `INSERT INTO persona_profiles (
    persona_id,revision,display_name,avatar_ref,cover_ref,bio,
    preferred_locale,created_at,updated_at
  ) SELECT draft.persona_id,1,draft.display_name,draft.avatar_ref,draft.cover_ref,draft.bio,
           draft.preferred_locale,draft.created_at,greatest(clock_timestamp(), draft.created_at)
      FROM persona_pending_profiles AS draft
      JOIN personas AS persona USING (persona_id)
     WHERE persona.status='pending_wallet'
       AND ($1::text[] IS NULL OR persona.persona_id=ANY($1::text[]))`,
  `INSERT INTO public_handle_index (
    handle_id,label_normalized,label_display,status,
    owner_user_id,owner_persona_id,redirect_target_handle_id
  ) SELECT draft.handle_id,draft.label_normalized,draft.label_display,'active',
           persona.account_id,persona.persona_id,NULL
      FROM persona_pending_first_handles AS draft
      JOIN personas AS persona USING (persona_id)
     WHERE persona.status='pending_wallet'
       AND ($1::text[] IS NULL OR persona.persona_id=ANY($1::text[]))`,
  `UPDATE personas
     SET status='active'
   WHERE status='pending_wallet'
     AND ($1::text[] IS NULL OR persona_id=ANY($1::text[]))`,
  `DELETE FROM persona_pending_first_handles
   WHERE $1::text[] IS NULL OR persona_id=ANY($1::text[])`,
  `DELETE FROM persona_pending_profiles
   WHERE $1::text[] IS NULL OR persona_id=ANY($1::text[])`,
] as const;

async function activate(
  client: Client,
  personaIds: readonly string[] | undefined,
  walletAddress?: string,
): Promise<void> {
  const personaValues = [personaIds === undefined ? null : [...personaIds]];
  for (const [index, statement] of activationStatements.entries()) {
    await client.query(
      statement,
      index === 0 ? [...personaValues, walletAddress ?? null] : personaValues,
    );
  }
}

/** Explicitly activates non-personal PostgreSQL fixtures through the v1 final database shape. */
export async function activatePendingPersonaFixtures(
  client: Client,
  personaIds?: readonly string[],
  walletAddress?: string,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await activate(client, personaIds, walletAddress);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/** Creates one additional active test persona without bypassing the wallet activation invariant. */
export async function createActivePersonaFixture(
  client: Client,
  input: Readonly<{
    accountId: string;
    personaId: string;
    profile?: PersonaProfileFixture;
  }>,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO personas (persona_id,account_id,status,is_first_persona)
       VALUES ($1,$2,'pending_wallet',false)`,
      [input.personaId, input.accountId],
    );
    await client.query(
      `INSERT INTO persona_pending_profiles (
         persona_id,display_name,bio,preferred_locale
       ) VALUES ($1,$2,$3,$4)`,
      [
        input.personaId,
        input.profile?.displayName ?? null,
        input.profile?.bio ?? null,
        input.profile?.preferredLocale ?? null,
      ],
    );
    await client.query(
      `INSERT INTO persona_wallet_assignments (
         assignment_id,persona_id,account_id,chain_account_kind,hd_wallet_index,
         status,reservation_idempotency_key
       ) SELECT 'fixture-wallet-' || $1,$1,$2,'evm',
                coalesce(max(hd_wallet_index),-1)+1,'pending','fixture-persona-' || $1
           FROM persona_wallet_assignments WHERE account_id=$2`,
      [input.personaId, input.accountId],
    );
    await activate(client, [input.personaId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/** Seeds one wallet-backed account document for repository fixtures that test later profile edits. */
export async function createWalletBackedAccountFixture(
  client: Client,
  input: Readonly<{ userId: string; account: unknown; createdAt?: string }>,
): Promise<void> {
  await client.query(
    `INSERT INTO users (user_id,status,account,created_at)
     VALUES ($1,'active',$2::jsonb,coalesce($3::timestamptz,clock_timestamp()))`,
    [input.userId, JSON.stringify(input.account), input.createdAt ?? null],
  );
  await activatePendingPersonaFixtures(client);
}

/** Supplies confirmed assignments to non-personal legacy rows before a fail-closed 0060 test upgrade. */
export async function backfillActivePersonaWalletFixtures(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO persona_wallet_assignments (
       assignment_id,persona_id,account_id,chain_account_kind,privy_wallet_id,
       hd_wallet_index,address,status,reservation_idempotency_key,assigned_at,created_at,updated_at
     ) SELECT 'fixture-wallet-' || persona.persona_id,persona.persona_id,persona.account_id,'evm',
              'fixture-' || persona.persona_id,
              row_number() OVER (PARTITION BY persona.account_id ORDER BY persona.created_at,persona.persona_id)-1,
              '0x' || left(md5(persona.persona_id) || md5(persona.persona_id || ':wallet'), 40),
              'active','fixture-legacy-' || persona.persona_id,
              persona.created_at,persona.created_at,persona.created_at
         FROM personas AS persona
        WHERE persona.status IN ('active','suspended')
          AND NOT EXISTS (
            SELECT 1 FROM persona_wallet_assignments AS assignment
             WHERE assignment.persona_id=persona.persona_id
               AND assignment.chain_account_kind='evm'
          )`,
  );
}

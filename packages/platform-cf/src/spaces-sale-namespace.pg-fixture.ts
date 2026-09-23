import { createHash } from "node:crypto";
import type { Client } from "pg";

/**
 * Spaces sale-namespace fixtures (spec 012 §5.3.13.3). Evidence, operator
 * assignments, and root enablement are written directly because their
 * ceremony and operator wires are frozen by a later contract checkpoint. The
 * root enablement is test-only: no migration or production path writes one.
 */

export const spacesRoot = "charizard";
export const spacesKeyA = "a".repeat(64);
export const spacesKeyB = "b".repeat(64);
export const spacesOutpoint = `${"c".repeat(64)}:0`;

const at = (offsetSeconds: number): string =>
  new Date(Date.now() + offsetSeconds * 1_000).toISOString();

export async function configureSpacesNetwork(admin: Client, network = "regtest"): Promise<void> {
  await admin.query(
    `INSERT INTO spaces_network_configuration (configuration_key, network)
     VALUES ('spaces_network_v1', $1)`,
    [network],
  );
}

export async function seedSpacesSeller(
  admin: Client,
  input: Readonly<{ communityId: string; sellerId: string; createUser?: boolean }>,
): Promise<void> {
  if (input.createUser !== false) {
    await admin.query("INSERT INTO users (user_id,status) VALUES ($1,'active')", [input.sellerId]);
  }
  await admin.query(
    `INSERT INTO communities (
       community_id,display_name,status,created_by_user_id,created_at,updated_at,
       route_slug,route_authority_version
     ) VALUES ($1,'Spaces Test','active',$2,clock_timestamp(),clock_timestamp(),NULL,'optional_route_v2')
     ON CONFLICT (community_id) DO NOTHING`,
    [input.communityId, input.sellerId],
  );
  await grantSpacesSalesAuthority(admin, input);
}

export async function grantSpacesSalesAuthority(
  admin: Client,
  input: Readonly<{ communityId: string; sellerId: string }>,
): Promise<void> {
  await admin.query(
    `INSERT INTO community_handle_sales_authority_grants (
       grant_id,community_id,principal_account_id,authority,source_kind,source_policy_ref,
       status,granted_at,granted_by_account_id
     ) VALUES (community_handle_sales_creator_grant_id_v1($1,$2),$1,$2,'manage_handle_sales',
               'community_policy','spaces-test-policy','active',clock_timestamp(),$2)
     ON CONFLICT (community_id,principal_account_id,authority) DO NOTHING`,
    [input.communityId, input.sellerId],
  );
}

/** Records one evidence generation. Later generations move every time forward. */
export async function recordSpacesAuthorityEvidence(
  admin: Client,
  input: Readonly<{
    reference: string;
    generation: number;
    communityId: string;
    controllingAccountId: string;
    rootKeyHex?: string;
    root?: string;
    network?: string;
    /** Seconds before now at which the root key was last observed to change. */
    keyChangedSecondsAgo?: number;
  }>,
): Promise<void> {
  const keyChanged = input.keyChangedSecondsAgo ?? 3_600;
  await admin.query(
    `INSERT INTO spaces_namespace_authority_evidence (
       namespace_authority_reference,namespace_authority_generation,evidence_digest,network,
       canonical_root,display_root,community_id,controlling_account_id,challenge_environment,
       challenge_nonce_digest,root_outpoint,root_key_hex,anchor_block_hash,anchor_height,
       anchored_at,key_last_changed_at,challenge_completed_at,publication_verified_at,
       observed_at,fresh_until,raw_verifier_evidence
     ) VALUES (
       $1,$2,$15,$3,$4,$4,$5,$6,
       'test',repeat('d',64),$7,$8,repeat('e',64),100,$9::timestamptz,$10::timestamptz,
       $11::timestamptz,$12::timestamptz,$13::timestamptz,$14::timestamptz,'\\x01'::bytea
     )`,
    [
      input.reference,
      input.generation,
      input.network ?? "regtest",
      input.root ?? spacesRoot,
      input.communityId,
      input.controllingAccountId,
      spacesOutpoint,
      input.rootKeyHex ?? spacesKeyA,
      at(-3),
      at(-keyChanged),
      at(-keyChanged + Math.max(1, Math.floor(keyChanged / 2))),
      at(-keyChanged + Math.max(1, Math.floor(keyChanged / 2))),
      at(-2),
      at(86_400),
      createHash("sha256").update(`${input.reference}:${input.generation}`).digest("hex"),
    ],
  );
}

export async function seedSpacesOperatorAssignment(
  admin: Client,
  input: Readonly<{
    assignmentId: string;
    generation: number;
    delegationAddress: string;
    walletReference?: string;
    instanceId?: string;
    root?: string;
    network?: string;
  }>,
): Promise<void> {
  const instanceId = input.instanceId ?? "operator-instance-1";
  const network = input.network ?? "regtest";
  await admin.query(
    `INSERT INTO spaces_operator_instances (operator_instance_id,network,status,created_at)
     VALUES ($1,$2,'active',clock_timestamp() - interval '1 day')
     ON CONFLICT (operator_instance_id) DO NOTHING`,
    [instanceId, network],
  );
  await admin.query(
    `INSERT INTO spaces_operator_assignment_revisions (
       operator_assignment_id,operator_assignment_generation,network,canonical_root,
       operator_instance_id,operator_wallet_reference,delegation_address,status,created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'active',
               COALESCE((SELECT created_at FROM spaces_operator_assignment_revisions
                          WHERE operator_assignment_id=$1 AND operator_assignment_generation=1),
                        clock_timestamp() - interval '1 hour'))`,
    [
      input.assignmentId,
      input.generation,
      network,
      input.root ?? spacesRoot,
      instanceId,
      input.walletReference ?? `wallet-${input.assignmentId}`,
      input.delegationAddress,
    ],
  );
  await admin.query(
    input.generation === 1
      ? `INSERT INTO spaces_operator_assignment_current (
           operator_assignment_id,network,canonical_root,operator_wallet_reference,
           delegation_address,current_generation,status,updated_at
         ) SELECT operator_assignment_id,network,canonical_root,operator_wallet_reference,
                  delegation_address,operator_assignment_generation,status,clock_timestamp()
             FROM spaces_operator_assignment_revisions
            WHERE operator_assignment_id=$1 AND operator_assignment_generation=$2`
      : `UPDATE spaces_operator_assignment_current
            SET current_generation=$2,updated_at=clock_timestamp()
          WHERE operator_assignment_id=$1`,
    [input.assignmentId, input.generation],
  );
}

/** Test-only root enablement of the disabled Spaces driver revision (ruling Q3). */
export async function enableSpacesDriverForRoot(
  admin: Client,
  input: Readonly<{ enablementId: string; root?: string; network?: string }>,
): Promise<void> {
  await admin.query(
    `INSERT INTO spaces_issuance_driver_root_enablements (
       enablement_id,network,canonical_root,driver_family,driver_id,driver_version,status,
       authorization_reference,enabled_at
     ) VALUES ($1,$2,$3,'spaces','spaces_native-local','1','enabled','test-only-enablement',
               clock_timestamp())`,
    [input.enablementId, input.network ?? "regtest", input.root ?? spacesRoot],
  );
}

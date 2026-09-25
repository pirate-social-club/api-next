import { afterAll, describe, expect, test } from "bun:test";
import { schnorr } from "@noble/curves/secp256k1.js";
import { ControlPlaneDb } from "@pirate/application";
import { SpacesOwnerProofRefused } from "@pirate/contracts";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  makeSpacesOwnerProofStore,
  type SpacesRootAuthorityObserver,
} from "./spaces-owner-proof-repository.ts";
import type { SpacesRootAuthorityEvidenceV1 } from "./spaces-root-authority-evidence.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString ? describe : describe.skip;
const root = "yahoo";
const accountId = "spaces-owner-proof-test-account";
const communityId = "community_00000000-0000-4000-8000-00000000c001";
const secretKey = Buffer.from("03".repeat(32), "hex");
const rootKey = Buffer.from(schnorr.getPublicKey(secretKey)).toString("hex");
const outpoint = `${"22".repeat(32)}:1`;

async function withSchema(use: (admin: Client, connection: string) => Promise<void>) {
  if (!connectionString) throw new Error("Missing test database");
  const schema = `spaces_owner_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`SET search_path TO "${schema}"`);
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const connection = url.toString();
  try {
    await applyPostgresTestBaselineConnection({ connectionString: connection });
    await admin.query("INSERT INTO users (user_id,status) VALUES ($1,'active')", [accountId]);
    await admin.query(
      `INSERT INTO communities (community_id,display_name,status,created_by_user_id,created_at,updated_at,route_slug,route_authority_version)
       VALUES ($1,'Spaces Owner Proof','active',$2,clock_timestamp(),clock_timestamp(),NULL,'optional_route_v2')`,
      [communityId, accountId],
    );
    await admin.query(
      `INSERT INTO community_handle_sales_authority_grants
       (grant_id,community_id,principal_account_id,authority,source_kind,source_policy_ref,status,granted_at,granted_by_account_id)
       VALUES ('spaces-owner-proof-grant',$1,$2,'manage_handle_sales','community_policy','spaces-owner-test','active',clock_timestamp(),$2)`,
      [communityId, accountId],
    );
    await admin.query(
      "INSERT INTO spaces_network_configuration (configuration_key,network) VALUES ('spaces_network_v1','mainnet')",
    );
    await use(admin, connection);
  } finally {
    await admin.query("ROLLBACK");
    await admin.query("SET session_replication_role = origin");
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}

const evidence = (changed = false): SpacesRootAuthorityEvidenceV1 => ({
  contract: "spaces-verifier-root-authority-v1",
  network: "mainnet",
  root: `@${root}`,
  outpoint: changed ? `${"33".repeat(32)}:1` : outpoint,
  owner_script_pubkey_hex: `5120${rootKey}`,
  owner_xonly_key_hex: rootKey,
  tip_height: 968544,
  tip_time: 1,
  tip_age_seconds: 1,
  anchor_height: 968544,
  anchor_block_hash: "44".repeat(32),
  operator_num_id: null,
  operator_num_live: false,
  operator_num_outpoint: null,
  operator_num_holder_script_pubkey_hex: null,
  reverse_delegation_matches: false,
  latest_commitment: null,
  latest_final_commitment: null,
  commitment_count: 0,
  root_certificate_sha256_hex: "55".repeat(32),
  root_certificate_base64: "AQ==",
  owner_signature_verified: null,
  anchor_bound_outpoint: true,
  proof_anchor_height: 968544,
  proof_anchor_block_hash: "44".repeat(32),
  proof_root_anchor_id_hex: "66".repeat(32),
  certificate_anchor_height: 968544,
  certificate_anchor_block_hash: "44".repeat(32),
  certificate_root_anchor_id_hex: "66".repeat(32),
  chain_proof_sha256_hex: "77".repeat(32),
  chain_proof_base64: "AQ==",
});

function makeStore(connection: string, observer: SpacesRootAuthorityObserver) {
  const layer = makeDirectPostgresControlPlaneLayer(connection);
  const run = <T>(action: (store: ReturnType<typeof makeSpacesOwnerProofStore>) => Promise<T>) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.provide(layer)(
          Effect.gen(function* () {
            const db = yield* ControlPlaneDb;
            return yield* Effect.promise(() =>
              action(makeSpacesOwnerProofStore({ db, observer, environment: "staging" })),
            );
          }),
        ),
      ),
    );
  return {
    start: (input: Parameters<ReturnType<typeof makeSpacesOwnerProofStore>["start"]>[0]) =>
      run((store) => store.start(input)),
    poll: (input: Parameters<ReturnType<typeof makeSpacesOwnerProofStore>["poll"]>[0]) =>
      run((store) => store.poll(input)),
  };
}

suite("Spaces owner proof persistence", () => {
  test("verifies once, then replays exactly without a verifier call", async () => {
    await withSchema(async (admin, connection) => {
      let observations = 0;
      const observer: SpacesRootAuthorityObserver = {
        observe: async ({ digestHex }) => {
          observations += 1;
          const state = {
            ...evidence(),
            owner_signature_verified: digestHex === undefined ? null : true,
          };
          return { kind: "verified", bytes: Buffer.from(JSON.stringify(state)), evidence: state };
        },
      };
      const store = makeStore(connection, observer);
      const startInput = { accountId, communityId, canonicalRoot: root, idempotencyKey: "start-1" };
      const first = (await store.start(startInput)) as {
        ceremony_id: string;
        challenge_digest_hex: string;
        replayed: boolean;
      };
      expect(first.replayed).toBe(false);
      expect(((await store.start(startInput)) as { replayed: boolean }).replayed).toBe(true);
      expect(observations).toBe(1);
      const signatureHex = Buffer.from(
        schnorr.sign(Buffer.from(first.challenge_digest_hex, "hex"), secretKey),
      ).toString("hex");
      const pollInput = {
        accountId,
        communityId,
        ceremonyId: first.ceremony_id,
        idempotencyKey: "poll-1",
        signatureHex,
      };
      const verified = (await store.poll(pollInput)) as { status: string; replayed: boolean };
      expect(verified.status).toBe("verified");
      expect(((await store.poll(pollInput)) as { replayed: boolean }).replayed).toBe(true);
      expect(observations).toBe(2);
      await expect(store.poll({ ...pollInput, idempotencyKey: "poll-2" })).rejects.toBeInstanceOf(
        SpacesOwnerProofRefused,
      );
      expect(observations).toBe(2);
      const rows = await admin.query(
        "SELECT count(*)::int AS count FROM spaces_namespace_authority_evidence",
      );
      expect(rows.rows[0]?.count).toBe(1);
    });
  });

  test("keeps a 409 pending and records root drift only from positive evidence", async () => {
    await withSchema(async (_admin, connection) => {
      let signedPending = false;
      let unsignedChanged = false;
      const observer: SpacesRootAuthorityObserver = {
        observe: async ({ digestHex }) => {
          if (digestHex !== undefined && signedPending) return { kind: "pending" };
          if (digestHex === undefined && unsignedChanged) {
            const state = evidence(true);
            return { kind: "verified", bytes: Buffer.from(JSON.stringify(state)), evidence: state };
          }
          const state = {
            ...evidence(),
            owner_signature_verified: digestHex === undefined ? null : true,
          };
          return { kind: "verified", bytes: Buffer.from(JSON.stringify(state)), evidence: state };
        },
      };
      const store = makeStore(connection, observer);
      const first = (await store.start({
        accountId,
        communityId,
        canonicalRoot: root,
        idempotencyKey: "start-2",
      })) as { ceremony_id: string; challenge_digest_hex: string };
      const signatureHex = Buffer.from(
        schnorr.sign(Buffer.from(first.challenge_digest_hex, "hex"), secretKey),
      ).toString("hex");
      const poll = {
        accountId,
        communityId,
        ceremonyId: first.ceremony_id,
        idempotencyKey: "poll-1",
        signatureHex,
      };
      signedPending = true;
      expect(((await store.poll(poll)) as { status: string }).status).toBe("verification_pending");
      unsignedChanged = true;
      expect(((await store.poll(poll)) as { status: string }).status).toBe("root_changed");
    });
  });
});

afterAll(() => {
  if (connectionString) console.log("Spaces owner proof PostgreSQL suite complete");
});

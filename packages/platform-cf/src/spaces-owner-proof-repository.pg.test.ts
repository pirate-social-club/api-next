import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { ControlPlaneDb } from "@pirate/application";
import {
  SpacesOwnerProofRefused,
  SpacesOwnershipPollResponseV1,
  SpacesOwnershipStartResponseV1,
} from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  makeSpacesOperatorAssignmentStore,
  mintSpacesOperatorServiceCredential,
} from "./spaces-operator-assignment-repository.ts";
import {
  makeSpacesOwnerProofStore,
  type SpacesRootAuthorityObserver,
} from "./spaces-owner-proof-repository.ts";
import {
  parseSpacesRootAuthorityEvidenceV1,
  SPACES_ROOT_AUTHORITY_MAX_RESPONSE_BYTES,
  type SpacesRootAuthorityEvidenceV1,
} from "./spaces-root-authority-evidence.ts";
import { bytes, fixture } from "./spaces-root-authority-test-fixture.ts";

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
    list: (input: Parameters<ReturnType<typeof makeSpacesOwnerProofStore>["list"]>[0]) =>
      run((store) => store.list(input)),
    current: (input: Parameters<ReturnType<typeof makeSpacesOwnerProofStore>["current"]>[0]) =>
      run((store) => store.current(input)),
    resume: (input: Parameters<ReturnType<typeof makeSpacesOwnerProofStore>["resume"]>[0]) =>
      run((store) => store.resume(input)),
    start: (input: Parameters<ReturnType<typeof makeSpacesOwnerProofStore>["start"]>[0]) =>
      run((store) => store.start(input)),
    poll: (input: Parameters<ReturnType<typeof makeSpacesOwnerProofStore>["poll"]>[0]) =>
      run((store) => store.poll(input)),
  };
}

suite("Spaces owner proof persistence", () => {
  test("discovers only this account's roots with stable bounded pagination", async () => {
    await withSchema(async (admin, connection) => {
      const observer: SpacesRootAuthorityObserver = {
        observe: async ({ canonicalRoot }) => ({
          kind: "verified",
          evidence: { ...evidence(), root: `@${canonicalRoot}` },
          bytes: Buffer.from("{}"),
        }),
      };
      const store = makeStore(connection, observer);
      const input = { accountId, communityId };
      expect(await store.list(input)).toEqual({ items: [], next_cursor: null });
      for (let index = 0; index < 22; index++) {
        const canonicalRoot = `space-${index.toString().padStart(2, "0")}`;
        await store.start({ ...input, canonicalRoot, idempotencyKey: `discover-${index}` });
      }
      const first = await store.list(input);
      expect(first.items).toHaveLength(20);
      expect(first.next_cursor).toBe("space-19");
      expect(
        await makeStore(connection, observer).list({
          ...input,
          cursor: first.next_cursor as string,
        }),
      ).toEqual({
        items: [{ canonical_root: "space-20" }, { canonical_root: "space-21" }],
        next_cursor: null,
      });
      await expect(store.list({ ...input, communityId: "wrong-community" })).rejects.toMatchObject({
        reason: "forbidden",
      });
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM spaces_owner_proof_ceremonies"))
          .rows[0].count,
      ).toBe(22);
    });
  });
  test("recovers a lost start response without another ceremony and isolates roots and callers", async () => {
    await withSchema(async (admin, connection) => {
      const observer: SpacesRootAuthorityObserver = {
        observe: async () => ({ kind: "verified", evidence: evidence(), bytes: Buffer.from("{}") }),
      };
      const input = { accountId, communityId, canonicalRoot: root };
      const first = await makeStore(connection, observer).start({
        ...input,
        idempotencyKey: "lost-start",
      });
      const recovered = await makeStore(connection, observer).current(input);
      expect(recovered.ceremony).toMatchObject({
        status: "awaiting_signature",
        challenge: { ...(first as object), replayed: true },
      });
      expect(recovered.operator_assignment).toBeNull();
      expect(
        (await makeStore(connection, observer).current({ ...input, canonicalRoot: "csca" }))
          .ceremony,
      ).toBeNull();
      await admin.query(
        "INSERT INTO users (user_id,status) VALUES ('other-spaces-manager','active')",
      );
      await admin.query(
        `INSERT INTO community_handle_sales_authority_grants
        (grant_id,community_id,principal_account_id,authority,source_kind,source_policy_ref,status,granted_at,granted_by_account_id)
        VALUES ('other-spaces-grant',$1,'other-spaces-manager','manage_handle_sales','community_policy','test','active',clock_timestamp(),$2)`,
        [communityId, accountId],
      );
      const other = await makeStore(connection, observer).current({
        ...input,
        accountId: "other-spaces-manager",
      });
      expect(other.ceremony).toBeNull();
      expect(other.operator_assignment).toBeNull();
      expect(
        await makeStore(connection, observer).list({
          accountId: "other-spaces-manager",
          communityId,
        }),
      ).toEqual({ items: [], next_cursor: null });
      expect(await makeStore(connection, observer).list({ accountId, communityId })).toEqual({
        items: [{ canonical_root: root }],
        next_cursor: null,
      });
      await expect(
        makeStore(connection, observer).current({ ...input, communityId: "other-community" }),
      ).rejects.toBeInstanceOf(SpacesOwnerProofRefused);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM spaces_owner_proof_ceremonies"))
          .rows[0].count,
      ).toBe(1);
    });
  });

  test("resumes a durable unanswered poll without keeping its signature in the browser", async () => {
    await withSchema(async (admin, connection) => {
      let pending = true;
      const observer: SpacesRootAuthorityObserver = {
        observe: async ({ digestHex }) =>
          digestHex !== undefined && pending
            ? { kind: "pending" }
            : {
                kind: "verified",
                evidence: {
                  ...evidence(),
                  owner_signature_verified: digestHex === undefined ? null : true,
                },
                bytes: Buffer.from("{}"),
              },
      };
      const input = { accountId, communityId, canonicalRoot: root };
      const challenge = Schema.decodeUnknownSync(SpacesOwnershipStartResponseV1)(
        await makeStore(connection, observer).start({ ...input, idempotencyKey: "pending-start" }),
      );
      if ("status" in challenge) throw new Error("Missing test challenge");
      const pollInput = {
        accountId,
        communityId,
        ceremonyId: challenge.ceremony_id,
        idempotencyKey: "lost-poll",
      };
      const signatureHex = Buffer.from(
        schnorr.sign(Buffer.from(challenge.challenge_digest_hex, "hex"), secretKey),
      ).toString("hex");
      expect(
        await makeStore(connection, observer).poll({ ...pollInput, signatureHex }),
      ).toMatchObject({ status: "verification_pending" });
      const read = await makeStore(connection, observer).current(input);
      expect(read.ceremony).toMatchObject({
        status: "verification_pending",
        pending_poll_key: "lost-poll",
      });
      expect(JSON.stringify(read)).not.toContain(signatureHex);
      await expect(
        makeStore(connection, observer).resume({ ...pollInput, idempotencyKey: "unknown-poll" }),
      ).rejects.toMatchObject({ reason: "not_found" });
      pending = false;
      const accepted = await makeStore(connection, observer).resume(pollInput);
      expect(accepted).toMatchObject({ status: "verified", replayed: false });
      expect(await makeStore(connection, observer).resume(pollInput)).toEqual({
        ...(accepted as object),
        replayed: true,
      });
      expect((await makeStore(connection, observer).current(input)).ceremony).toMatchObject({
        status: "verified",
        proof_status: "fresh",
      });
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM spaces_owner_proof_polls")).rows[0]
          .count,
      ).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM spaces_namespace_authority_evidence",
          )
        ).rows[0].count,
      ).toBe(1);
    });
  });

  test("reports expiry without rewriting a pending ceremony or deleting its retained records", async () => {
    await withSchema(async (admin, connection) => {
      const observer: SpacesRootAuthorityObserver = {
        observe: async () => ({ kind: "verified", evidence: evidence(), bytes: Buffer.from("{}") }),
      };
      const input = { accountId, communityId, canonicalRoot: root };
      await makeStore(connection, observer).start({ ...input, idempotencyKey: "expires-start" });
      await admin.query(`UPDATE spaces_owner_proof_ceremonies SET
        key_last_changed_at=key_last_changed_at-interval '11 minutes',
        anchored_at=anchored_at-interval '11 minutes',
        publication_verified_at=publication_verified_at-interval '11 minutes',
        created_at=created_at-interval '11 minutes',expires_at=expires_at-interval '11 minutes'`);
      expect((await makeStore(connection, observer).current(input)).ceremony).toMatchObject({
        status: "ended",
        result: { status: "expired" },
      });
      const rows = await admin.query(
        "SELECT status,terminal_response FROM spaces_owner_proof_ceremonies",
      );
      expect(rows.rows).toEqual([{ status: "pending", terminal_response: null }]);
    });
  });

  test("recovers confirmed assignments while independently rechecking current root evidence", async () => {
    await withSchema(async (admin, connection) => {
      let rootChanged = false;
      let unavailable = false;
      const observer: SpacesRootAuthorityObserver = {
        observe: async ({ digestHex }) => {
          if (unavailable) throw new Error("Verifier unavailable");
          return {
            kind: "verified",
            evidence: {
              ...evidence(rootChanged),
              owner_signature_verified: digestHex === undefined ? null : true,
            },
            bytes: Buffer.from("{}"),
          };
        },
      };
      const input = { accountId, communityId, canonicalRoot: root };
      const store = makeStore(connection, observer);
      const challenge = Schema.decodeUnknownSync(SpacesOwnershipStartResponseV1)(
        await store.start({ ...input, idempotencyKey: "assignment-start" }),
      );
      if ("status" in challenge) throw new Error("Missing test challenge");
      const proof = Schema.decodeUnknownSync(SpacesOwnershipPollResponseV1)(
        await store.poll({
          accountId,
          communityId,
          ceremonyId: challenge.ceremony_id,
          idempotencyKey: "assignment-poll",
          signatureHex: Buffer.from(
            schnorr.sign(Buffer.from(challenge.challenge_digest_hex, "hex"), secretKey),
          ).toString("hex"),
        }),
      );
      if (proof.status !== "verified") throw new Error("Missing test proof");
      await admin.query(
        "INSERT INTO spaces_operator_instances (operator_instance_id,network,status,created_at) VALUES ('recovery-instance','mainnet','active',clock_timestamp())",
      );
      const layer = makeDirectPostgresControlPlaneLayer(connection);
      const withDb = <T>(action: (db: ControlPlaneDb["Service"]) => Promise<T>) =>
        Effect.runPromise(
          Effect.scoped(
            Effect.provide(layer)(
              Effect.gen(function* () {
                const db = yield* ControlPlaneDb;
                return yield* Effect.promise(() => action(db));
              }),
            ),
          ),
        );
      const credential = await withDb((db) =>
        mintSpacesOperatorServiceCredential(db, {
          operatorInstanceId: "recovery-instance",
          environment: "staging",
          canonicalRoot: root,
          capability: "assignment_prepare",
          authorizationReference: "recovery-test",
        }),
      );
      const assignments = (db: ControlPlaneDb["Service"]) =>
        makeSpacesOperatorAssignmentStore({ db, observer, environment: "staging" });
      const prepared = await withDb((db) =>
        assignments(db).prepare(credential.token, {
          idempotency_key: "prepare-recovery",
          operator_instance_id: "recovery-instance",
          network: "mainnet",
          canonical_root: root,
          operator_wallet_reference: "recovery-wallet",
          delegation_address: "bcs1p00rgyrzt0gmec52mu3w2un0xl6pzqyq9e8yc9t48fdk0cu3us8ys7rnkp7",
        }),
      );
      expect((await store.current(input)).operator_assignment).toMatchObject({
        status: "prepared",
        current: false,
      });
      await withDb((db) =>
        assignments(db).confirm({
          accountId,
          communityId,
          idempotencyKey: "confirm-recovery",
          assignmentId: prepared.operator_assignment_id,
          expectedGeneration: prepared.generation,
          authorityReference: proof.namespace_authority_reference,
          expectedAuthorityGeneration: proof.namespace_authority_generation,
        }),
      );
      const recovered = await makeStore(connection, observer).current(input);
      expect(recovered.operator_assignment).toMatchObject({
        ...prepared,
        replayed: true,
        status: "confirmed",
        current: true,
      });
      expect(recovered.ceremony).toMatchObject({ status: "verified", proof_status: "fresh" });
      rootChanged = true;
      expect((await store.current(input)).ceremony).toMatchObject({
        status: "verified",
        proof_status: "root_changed",
      });
      unavailable = true;
      expect((await store.current(input)).ceremony).toMatchObject({
        status: "verified",
        proof_status: "unavailable",
      });
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM spaces_operator_assignment_revisions",
          )
        ).rows[0].count,
      ).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM community_handle_sale_namespace_activation_revisions",
          )
        ).rows[0].count,
      ).toBe(0);
      unavailable = false;
      await admin.query("INSERT INTO users (user_id,status) VALUES ('successor-manager','active')");
      await admin.query(
        `INSERT INTO community_handle_sales_authority_grants
        (grant_id,community_id,principal_account_id,authority,source_kind,source_policy_ref,status,granted_at,granted_by_account_id)
        VALUES ('successor-grant',$1,'successor-manager','manage_handle_sales','community_policy','test','active',clock_timestamp(),$2)`,
        [communityId, accountId],
      );
      await store.start({
        ...input,
        accountId: "successor-manager",
        idempotencyKey: "successor-start",
      });
      const superseded = await store.current(input);
      expect(superseded.ceremony).toMatchObject({
        status: "superseded",
        challenge: { ceremony_id: challenge.ceremony_id },
      });
      expect(superseded.operator_assignment).toBeNull();
    });
  });
  for (const size of [303_364, SPACES_ROOT_AUTHORITY_MAX_RESPONSE_BYTES]) {
    test(`retains exact ${size}-byte verified responses in both owner-proof columns`, async () => {
      await withSchema(async (admin, connection) => {
        const observed: Buffer[] = [];
        const observer: SpacesRootAuthorityObserver = {
          observe: async ({ digestHex }) => {
            const unpadded = {
              ...fixture(),
              outpoint,
              owner_script_pubkey_hex: `5120${rootKey}`,
              owner_xonly_key_hex: rootKey,
              owner_signature_verified: digestHex === undefined ? null : true,
              commitment_count: 1,
              latest_commitment: { padding: "" },
            };
            const response = Buffer.from(
              bytes({
                ...unpadded,
                latest_commitment: { padding: "r".repeat(size - bytes(unpadded).byteLength) },
              }),
            );
            expect(response.byteLength).toBe(size);
            const checked = parseSpacesRootAuthorityEvidenceV1(
              response,
              root,
              digestHex !== undefined,
            );
            observed.push(response);
            return { kind: "verified", bytes: response, evidence: checked };
          },
        };
        const store = makeStore(connection, observer);
        const challenge = (await store.start({
          accountId,
          communityId,
          canonicalRoot: root,
          idempotencyKey: "large-start",
        })) as {
          ceremony_id: string;
          challenge_digest_hex: string;
        };
        const signatureHex = Buffer.from(
          schnorr.sign(Buffer.from(challenge.challenge_digest_hex, "hex"), secretKey),
        ).toString("hex");
        expect(
          await store.poll({
            accountId,
            communityId,
            ceremonyId: challenge.ceremony_id,
            idempotencyKey: "large-poll",
            signatureHex,
          }),
        ).toMatchObject({ status: "verified" });
        const result = await admin.query(`
          SELECT ceremony.start_verifier_bytes,ceremony.start_verifier_sha256_hex,
                 authority.raw_verifier_evidence,proof.observation_sha256_hex AS observation_sha256
          FROM spaces_owner_proof_ceremonies ceremony
          JOIN spaces_owner_proof_evidence proof USING (ceremony_id)
          JOIN spaces_namespace_authority_evidence authority USING
            (namespace_authority_reference,namespace_authority_generation)`);
        expect(result.rows[0].start_verifier_bytes).toEqual(observed[0]);
        expect(result.rows[0].raw_verifier_evidence).toEqual(observed[1]);
        expect(result.rows[0].start_verifier_sha256_hex).toBe(
          createHash("sha256")
            .update(observed[0] as Buffer)
            .digest("hex"),
        );
        expect(result.rows[0].observation_sha256).toBe(
          createHash("sha256")
            .update(observed[1] as Buffer)
            .digest("hex"),
        );

        // Copy the actual constraints, without append-only triggers, to test
        // direct SQL boundary violations without changing retained evidence.
        for (const [table, column] of [
          ["spaces_owner_proof_ceremonies", "start_verifier_bytes"],
          ["spaces_namespace_authority_evidence", "raw_verifier_evidence"],
        ]) {
          await admin.query(
            `CREATE TEMP TABLE byte_boundary (LIKE ${table} INCLUDING CONSTRAINTS)`,
          );
          const names = await admin.query(
            "SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum",
            [table],
          );
          const projections = names.rows
            .map(({ attname }: { attname: string }) =>
              attname === column ? "$1::bytea" : `"${attname}"`,
            )
            .join(",");
          for (const invalidSize of [0, SPACES_ROOT_AUTHORITY_MAX_RESPONSE_BYTES + 1]) {
            await expect(
              admin.query(`INSERT INTO byte_boundary SELECT ${projections} FROM ${table} LIMIT 1`, [
                Buffer.alloc(invalidSize),
              ]),
            ).rejects.toMatchObject({ code: "23514", constraint: `${table}_${column}_check` });
          }
          await admin.query("DROP TABLE byte_boundary");
        }
      });
    });
  }

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

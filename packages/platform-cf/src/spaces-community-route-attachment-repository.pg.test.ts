import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { ControlPlaneDb } from "@pirate/application";
import { SpacesRouteAttachmentRefused } from "@pirate/contracts";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { insertActiveCommunityMembershipFixture } from "./community-follow.pg-fixture.ts";
import { makeControlPlaneCanonicalCommunityRouteStore } from "./community-route-repository.ts";
import { activatePendingPersonaFixtures } from "./persona-wallet.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  makeSpacesRouteAttachmentStore,
  renewDueSpacesRouteBindings,
} from "./spaces-community-route-attachment-repository.ts";
import { spacesOwnerChallengeDigestV1 } from "./spaces-owner-proof-codec.ts";
import type { SpacesRootRouteObserver } from "./spaces-root-authority-observer.ts";
import {
  parseSpacesRootRouteEvidenceV1,
  type SpacesRootRouteEvidenceV1,
} from "./spaces-root-route-evidence.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString ? describe : describe.skip;

const ORIGIN = "https://web.example";
const communities = {
  yahoo: "community_00000000-0000-4000-8000-00000000d001",
  csca: "community_00000000-0000-4000-8000-00000000d002",
  spare: "community_00000000-0000-4000-8000-00000000d003",
} as const;
// A persona binds to one community, so each community has its own owner.
const accountFor = (communityId: string): string => {
  const name = Object.entries(communities).find(([, id]) => id === communityId)?.[0];
  if (name === undefined) throw new Error("unknown test community");
  return `spaces-route-owner-${name}`;
};
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const keyOf = (secret: Buffer) => Buffer.from(schnorr.getPublicKey(secret)).toString("hex");
const secrets = {
  yahoo: Buffer.from("03".repeat(32), "hex"),
  csca: Buffer.from("05".repeat(32), "hex"),
  other: Buffer.from("07".repeat(32), "hex"),
};

/** A controllable chain view: each root has one current owner. */
type Owner = { outpoint: string; key: string };
function makeChain() {
  const owners = new Map<string, Owner>([
    ["yahoo", { outpoint: `${"22".repeat(32)}:1`, key: keyOf(secrets.yahoo) }],
    ["csca", { outpoint: `${"33".repeat(32)}:0`, key: keyOf(secrets.csca) }],
  ]);
  const state = { mode: "verified" as "verified" | "pending" | "down", calls: 0 };
  const observer: SpacesRootRouteObserver = {
    observe: async (input) => {
      state.calls += 1;
      if (state.mode === "down") throw new Error("verifier unavailable");
      const owner = owners.get(input.canonicalRoot);
      if (state.mode === "pending" || owner === undefined) return { kind: "pending" };
      const signed = input.digestHex !== undefined && input.signatureHex !== undefined;
      // The real verifier refuses a signature that the current owner key did not make.
      if (
        signed &&
        !schnorr.verify(
          Buffer.from(input.signatureHex ?? "", "hex"),
          Buffer.from(input.digestHex ?? "", "hex"),
          Buffer.from(owner.key, "hex"),
        )
      ) {
        return { kind: "pending" };
      }
      const proof = Buffer.from(`proof:${input.canonicalRoot}:${owner.outpoint}`);
      const evidence: SpacesRootRouteEvidenceV1 = {
        contract: "spaces-verifier-root-route-v1",
        network: "mainnet",
        root: `@${input.canonicalRoot}`,
        outpoint: owner.outpoint,
        owner_script_pubkey_hex: `5120${owner.key}`,
        owner_xonly_key_hex: owner.key,
        expire_height: 1_020_000,
        tip_height: 970_300,
        tip_time: 1,
        tip_age_seconds: 1,
        anchor_height: 970_296,
        anchor_block_hash: "44".repeat(32),
        anchor_bound_outpoint: true,
        proof_anchor_height: 970_296,
        proof_anchor_block_hash: "44".repeat(32),
        proof_root_anchor_id_hex: "66".repeat(32),
        chain_proof_sha256_hex: sha256(proof),
        chain_proof_base64: proof.toString("base64"),
        owner_signature_verified: signed ? true : null,
      };
      const bytes = Buffer.from(JSON.stringify(evidence));
      return {
        kind: "verified",
        bytes,
        evidence: parseSpacesRootRouteEvidenceV1(bytes, input.canonicalRoot, signed),
      };
    },
  };
  return { owners, state, observer };
}

async function withSchema(use: (admin: Client, connection: string) => Promise<void>) {
  if (!connectionString) throw new Error("Missing test database");
  const schema = `spaces_route_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`SET search_path TO "${schema}"`);
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const connection = url.toString();
  try {
    await applyPostgresTestBaselineConnection({ connectionString: connection });
    for (const communityId of Object.values(communities)) {
      await admin.query("INSERT INTO users (user_id,status) VALUES ($1,'active')", [
        accountFor(communityId),
      ]);
    }
    await activatePendingPersonaFixtures(admin);
    for (const [name, communityId] of Object.entries(communities)) {
      const account = accountFor(communityId);
      const persona = await admin.query<{ persona_id: string }>(
        "SELECT persona_id FROM personas WHERE account_id=$1 AND is_first_persona",
        [account],
      );
      const personaId = persona.rows[0]?.persona_id;
      if (personaId === undefined) throw new Error("missing route owner persona");
      await admin.query(
        `INSERT INTO communities (community_id,display_name,status,created_by_user_id,created_at,updated_at,route_slug,route_authority_version)
         VALUES ($1,$2,'active',$3,clock_timestamp(),clock_timestamp(),NULL,'optional_route_v2')`,
        [communityId, `Spaces route ${name}`, account],
      );
      await admin.query(
        `INSERT INTO community_route_authority_grants
         (grant_id,community_id,principal_user_id,authority,source_kind,status,granted_at,granted_by_user_id)
         VALUES ($1,$2,$3,'manage_routes','creator_owner','active',clock_timestamp(),$3)`,
        [`spaces-route-grant-${name}`, communityId, account],
      );
      // The opaque community page resolves through its owner presentation.
      await insertActiveCommunityMembershipFixture(admin, {
        communityId,
        membershipId: `spaces-route-membership-${name}`,
        userId: account,
      });
      await admin.query(
        `INSERT INTO persona_community_bindings (persona_id,account_id,community_id,binding_source)
         VALUES ($1,$2,$3,'first_membership')`,
        [personaId, account, communityId],
      );
      await admin.query(
        `INSERT INTO persona_role_presentations (community_id,account_id,persona_id)
         VALUES ($1,$2,$3)`,
        [communityId, account, personaId],
      );
    }
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

/**
 * Moves fixture rows in time. Guards are bypassed only for this fixture write;
 * every assertion afterwards runs with guards on and reads PostgreSQL's clock.
 */
async function shift(admin: Client, sql: string, values: readonly unknown[]) {
  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query(sql, [...values]);
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
}

type State = {
  status: string;
  attachment_intent_id: string;
  generation: number;
  challenge_message: string;
  challenge_digest_hex: string;
  route_binding_id: string | null;
  replayed: boolean;
  route_expires_at?: string;
};

function makeHarness(connection: string, observer: SpacesRootRouteObserver) {
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
  const store = (db: ControlPlaneDb["Service"]) =>
    makeSpacesRouteAttachmentStore({ db, observer, environment: "staging", publicOrigin: ORIGIN });
  const routes = makeControlPlaneCanonicalCommunityRouteStore(layer);
  return {
    start: (communityId: string, canonicalRoot: string, idempotencyKey: string) =>
      withDb((db) =>
        store(db).start({
          accountId: accountFor(communityId),
          communityId,
          canonicalRoot,
          idempotencyKey,
        }),
      ) as Promise<State>,
    current: (communityId: string) =>
      withDb((db) =>
        store(db).current({ accountId: accountFor(communityId), communityId }),
      ) as Promise<State>,
    prove: (communityId: string, attachmentIntentId: string, signatureHex: string) =>
      withDb((db) =>
        store(db).prove({
          accountId: accountFor(communityId),
          communityId,
          attachmentIntentId,
          signatureHex,
        }),
      ) as Promise<State>,
    commit: (communityId: string, attachmentIntentId: string, generation = 1) =>
      withDb((db) =>
        store(db).commit({
          accountId: accountFor(communityId),
          communityId,
          attachmentIntentId,
          generation,
        }),
      ) as Promise<State>,
    renew: () => withDb((db) => renewDueSpacesRouteBindings({ db, observer, limit: 10 })),
    resolve: (pathSegment: string) =>
      Effect.runPromise(Effect.scoped(routes.resolveCanonicalRoute({ path_segment: pathSegment }))),
  };
}

const sign = (state: Pick<State, "challenge_digest_hex">, secret: Buffer) =>
  Buffer.from(schnorr.sign(Buffer.from(state.challenge_digest_hex, "hex"), secret)).toString("hex");

const refusal = async (action: Promise<unknown>) => {
  try {
    await action;
  } catch (error) {
    return error instanceof SpacesRouteAttachmentRefused ? error.reason : `unexpected:${error}`;
  }
  return "accepted";
};

async function attach(
  harness: ReturnType<typeof makeHarness>,
  root: "yahoo" | "csca",
  key = `start-${root}`,
) {
  const started = await harness.start(communities[root], root, key);
  const proved = await harness.prove(
    communities[root],
    started.attachment_intent_id,
    sign(started, secrets[root]),
  );
  const committed = await harness.commit(communities[root], started.attachment_intent_id);
  return { started, proved, committed };
}

suite("Spaces community route attachment", () => {
  test("attaches two roots through one ceremony and resumes after interruption", async () => {
    await withSchema(async (admin, connection) => {
      const chain = makeChain();
      const harness = makeHarness(connection, chain.observer);
      const started = await harness.start(communities.yahoo, "yahoo", "start-yahoo");
      expect(started).toMatchObject({ status: "awaiting_signature", generation: 1 });
      expect(started.replayed).toBe(false);
      const message = JSON.parse(started.challenge_message) as unknown[];
      expect(message).toHaveLength(18);
      expect(message[0]).toBe("pirate-spaces-community-route-owner-v1");
      expect(message.slice(8, 13)).toEqual([
        "@yahoo",
        `${"22".repeat(32)}:1`,
        keyOf(secrets.yahoo),
        ORIGIN,
        `${ORIGIN}/c/@yahoo`,
      ]);
      expect(spacesOwnerChallengeDigestV1(started.challenge_message)).toBe(
        started.challenge_digest_hex,
      );
      // A client that lost the response reads the same intent back, by key or by community.
      expect(await harness.start(communities.yahoo, "yahoo", "start-yahoo")).toEqual({
        ...started,
        replayed: true,
      });
      expect(await harness.current(communities.yahoo)).toEqual({ ...started, replayed: true });
      expect(await refusal(harness.start(communities.yahoo, "csca", "start-yahoo"))).toBe(
        "conflict",
      );
      expect(await refusal(harness.start(communities.yahoo, "yahoo", "another-key"))).toBe(
        "conflict",
      );
      expect(await refusal(harness.start(communities.spare, "yahoo", "spare-yahoo"))).toBe(
        "conflict",
      );
      expect(await harness.resolve("@yahoo")).toBeNull();

      const signature = sign(started, secrets.yahoo);
      const proved = await harness.prove(
        communities.yahoo,
        started.attachment_intent_id,
        signature,
      );
      expect(proved).toMatchObject({ status: "proved", replayed: false });
      expect(await harness.current(communities.yahoo)).toMatchObject({ status: "proved" });
      expect(
        await harness.prove(communities.yahoo, started.attachment_intent_id, signature),
      ).toMatchObject({ status: "proved", replayed: true });
      expect(
        await refusal(
          harness.prove(communities.yahoo, started.attachment_intent_id, "ab".repeat(64)),
        ),
      ).toBe("conflict");
      expect(await harness.resolve("@yahoo")).toBeNull();

      const committed = await harness.commit(communities.yahoo, started.attachment_intent_id);
      expect(committed).toMatchObject({ status: "committed", replayed: false });
      expect(committed.route_binding_id).toMatch(/^srbind_[0-9a-f]{32}$/u);
      expect(
        await refusal(harness.commit(communities.yahoo, started.attachment_intent_id, 2)),
      ).toBe("conflict");
      // A lost commit response is reconciled without a second binding or signature.
      expect(await harness.commit(communities.yahoo, started.attachment_intent_id)).toEqual({
        ...committed,
        replayed: true,
      });
      expect(await harness.current(communities.yahoo)).toMatchObject({
        status: "committed",
        route_binding_id: committed.route_binding_id,
      });

      // The second root uses the same code path with only its own values.
      const second = await attach(harness, "csca");
      expect(second.committed).toMatchObject({ status: "committed" });
      expect(await harness.resolve("@yahoo")).toMatchObject({
        community_id: communities.yahoo,
        canonical_route: { family: "spaces", root_label: "yahoo", href: "/c/@yahoo" },
      });
      expect(await harness.resolve("@csca")).toMatchObject({
        community_id: communities.csca,
        canonical_route: { family: "spaces", root_label: "csca", href: "/c/@csca" },
      });
      const bindings = await admin.query(
        `SELECT binding.community_id,binding.root_label,binding.binding_generation,
                evidence.origin,evidence.verified_by_actor_id,
                extract(epoch FROM evidence.expires_at-evidence.verified_at)::int AS lease
           FROM community_canonical_route_bindings AS binding
           JOIN community_route_ownership_evidence AS evidence
             ON evidence.evidence_ref=binding.verified_evidence_ref
          ORDER BY binding.root_label`,
      );
      expect(bindings.rows).toEqual([
        {
          community_id: communities.csca,
          root_label: "csca",
          binding_generation: "1",
          origin: "spaces_route_attachment",
          verified_by_actor_id: accountFor(communities.csca),
          lease: 21_600,
        },
        {
          community_id: communities.yahoo,
          root_label: "yahoo",
          binding_generation: "1",
          origin: "spaces_route_attachment",
          verified_by_actor_id: accountFor(communities.yahoo),
          lease: 21_600,
        },
      ]);

      // A bound community and a bound root are both taken for good.
      expect(await refusal(harness.start(communities.yahoo, "csca", "rebind"))).toBe("conflict");
      expect(await refusal(harness.start(communities.spare, "csca", "steal"))).toBe("conflict");
      await expect(
        admin.query(
          `INSERT INTO community_canonical_route_bindings
           (route_binding_id,community_id,family,root_label,root_label_display,ownership_status)
           VALUES ('second-binding',$1,'spaces','other','other','pending')`,
          [communities.yahoo],
        ),
      ).rejects.toThrow(/community_canonical_route_bindings_community_id_key/u);
    });
  }, 60_000);

  test("refuses replayed, foreign and expired signatures by the database clock", async () => {
    await withSchema(async (admin, connection) => {
      const chain = makeChain();
      const harness = makeHarness(connection, chain.observer);
      const yahoo = await harness.start(communities.yahoo, "yahoo", "start-yahoo");
      const csca = await harness.start(communities.csca, "csca", "start-csca");
      // A valid signature for one challenge proves nothing for another
      // community and root, even when made by a real root owner.
      expect(
        await harness.prove(
          communities.csca,
          csca.attachment_intent_id,
          sign(yahoo, secrets.yahoo),
        ),
      ).toMatchObject({ status: "signature_rejected" });
      // Nor does the wrong key over the right challenge.
      expect(
        await harness.prove(
          communities.yahoo,
          yahoo.attachment_intent_id,
          sign(yahoo, secrets.other),
        ),
      ).toMatchObject({ status: "signature_rejected" });
      expect(await refusal(harness.commit(communities.yahoo, yahoo.attachment_intent_id))).toBe(
        "conflict",
      );

      // An expired challenge cannot be proved, although its signature still
      // verifies cryptographically. The successor is a new generation.
      const second = await harness.start(communities.yahoo, "yahoo", "start-yahoo-2");
      expect(second.generation).toBe(2);
      expect(second.challenge_digest_hex).not.toBe(yahoo.challenge_digest_hex);
      const secondSignature = sign(second, secrets.yahoo);
      await shift(
        admin,
        `UPDATE spaces_community_route_attachments
            SET created_at=created_at-interval '1 hour',expires_at=expires_at-interval '1 hour',
                updated_at=updated_at-interval '1 hour'
          WHERE attachment_intent_id=$1`,
        [second.attachment_intent_id],
      );
      // Read time alone reports the expiry; no job has recorded it yet.
      expect(await harness.start(communities.yahoo, "yahoo", "start-yahoo-2")).toMatchObject({
        status: "expired",
        replayed: true,
      });
      const calls = chain.state.calls;
      expect(
        await harness.prove(communities.yahoo, second.attachment_intent_id, secondSignature),
      ).toMatchObject({ status: "expired" });
      expect(chain.state.calls).toBe(calls);
      const third = await harness.start(communities.yahoo, "yahoo", "start-yahoo-3");
      expect(third).toMatchObject({ status: "awaiting_signature", generation: 3 });
      expect(
        await harness.prove(communities.yahoo, third.attachment_intent_id, secondSignature),
      ).toMatchObject({ status: "signature_rejected" });

      // Expiry that crosses between prove and commit refuses the commit.
      const fourth = await harness.start(communities.yahoo, "yahoo", "start-yahoo-4");
      expect(
        await harness.prove(
          communities.yahoo,
          fourth.attachment_intent_id,
          sign(fourth, secrets.yahoo),
        ),
      ).toMatchObject({ status: "proved" });
      await shift(
        admin,
        `UPDATE spaces_community_route_attachments
            SET created_at=created_at-interval '1 hour',expires_at=expires_at-interval '1 hour',
                proved_at=proved_at-interval '1 hour',updated_at=updated_at-interval '1 hour'
          WHERE attachment_intent_id=$1`,
        [fourth.attachment_intent_id],
      );
      // The database itself refuses evidence for the expired proof.
      await expect(
        admin.query(
          `INSERT INTO community_route_ownership_evidence (
             evidence_ref,verified_by_actor_id,family,root_label,root_label_display,path_segment,
             requirement_hash,provider_id,provider_binding_hash,provider_configuration_version,
             provider_identity_digest,evidence_digest,binding_generation,verified_at,expires_at,
             origin,spaces_route_attachment_intent_id)
           SELECT 'forged-evidence',account_id,'spaces','yahoo','yahoo','@yahoo',requirement_hash,
                  provider_id,provider_configuration_digest,'spaces-verifier-root-route-v1',
                  $2,$2,1,proved_at,clock_timestamp()+interval '1 hour',
                  'spaces_route_attachment',attachment_intent_id
             FROM spaces_community_route_attachments WHERE attachment_intent_id=$1`,
          [fourth.attachment_intent_id, "aa".repeat(32)],
        ),
      ).rejects.toThrow(/live proved attachment/u);
      expect(
        await harness.commit(communities.yahoo, fourth.attachment_intent_id, fourth.generation),
      ).toMatchObject({
        status: "expired",
        route_binding_id: null,
      });
      expect(await harness.resolve("@yahoo")).toBeNull();

      // An owner change between start and prove ends that generation.
      const fifth = await harness.start(communities.yahoo, "yahoo", "start-yahoo-5");
      chain.owners.set("yahoo", { outpoint: `${"99".repeat(32)}:0`, key: keyOf(secrets.other) });
      expect(
        await harness.prove(
          communities.yahoo,
          fifth.attachment_intent_id,
          sign(fifth, secrets.yahoo),
        ),
      ).toMatchObject({ status: "root_changed" });
      chain.owners.set("yahoo", { outpoint: `${"22".repeat(32)}:1`, key: keyOf(secrets.yahoo) });

      // An unavailable verifier is retryable and stores nothing.
      const sixth = await harness.start(communities.yahoo, "yahoo", "start-yahoo-6");
      chain.state.mode = "down";
      expect(
        await harness.prove(
          communities.yahoo,
          sixth.attachment_intent_id,
          sign(sixth, secrets.yahoo),
        ),
      ).toMatchObject({ status: "verification_pending" });
      chain.state.mode = "verified";
      expect(
        await harness.prove(
          communities.yahoo,
          sixth.attachment_intent_id,
          sign(sixth, secrets.yahoo),
        ),
      ).toMatchObject({ status: "proved" });

      // Revoking route authority after the proof refuses the commit.
      await admin.query(
        `UPDATE community_route_authority_grants
            SET status='revoked',revoked_at=clock_timestamp(),revoked_by_user_id=$2
          WHERE community_id=$1`,
        [communities.yahoo, accountFor(communities.yahoo)],
      );
      expect(
        await refusal(
          harness.commit(communities.yahoo, sixth.attachment_intent_id, sixth.generation),
        ),
      ).toBe("forbidden");
      const bound = await admin.query(
        "SELECT count(*)::int AS n FROM community_canonical_route_bindings",
      );
      expect(bound.rows[0]?.n).toBe(0);
    });
  }, 60_000);

  test("an expired lease stops resolving at read time with no job running", async () => {
    await withSchema(async (admin, connection) => {
      const chain = makeChain();
      const harness = makeHarness(connection, chain.observer);
      const yahoo = await attach(harness, "yahoo");
      await attach(harness, "csca");
      const effective = async (communityId: string, at: string) =>
        (
          await admin.query(`SELECT 1 FROM effective_active_route($1,${at}) AS route`, [
            communityId,
          ])
        ).rowCount;
      // The exact boundary is exclusive, using a deterministic SQL clock value.
      const boundary = `(SELECT evidence.expires_at FROM community_route_ownership_evidence AS evidence
        JOIN community_canonical_route_bindings AS binding
          ON binding.verified_evidence_ref=evidence.evidence_ref
       WHERE binding.community_id=$1)`;
      expect(await effective(communities.yahoo, `${boundary}-interval '1 millisecond'`)).toBe(1);
      expect(await effective(communities.yahoo, boundary)).toBe(0);
      expect(await effective(communities.yahoo, "clock_timestamp()")).toBe(1);

      // Yahoo's evidence is now seven hours old: its six-hour lease is over.
      // Nothing else is touched and no observer or expiry job runs.
      await shift(
        admin,
        `UPDATE community_route_ownership_evidence
            SET verified_at=verified_at-interval '7 hours',created_at=created_at-interval '7 hours',
                expires_at=expires_at-interval '7 hours'
          WHERE root_label='yahoo'`,
        [],
      );
      const stored = await admin.query(
        `SELECT route_lifecycle_status,ownership_status FROM community_canonical_route_bindings
          WHERE root_label='yahoo'`,
      );
      expect(stored.rows).toEqual([
        { route_lifecycle_status: "active", ownership_status: "verified" },
      ]);
      expect(await effective(communities.yahoo, "clock_timestamp()")).toBe(0);
      expect(await harness.resolve("@yahoo")).toBeNull();
      // The community itself stays reachable by its stable id, without a route.
      expect(await harness.resolve(communities.yahoo)).toMatchObject({
        community_id: communities.yahoo,
        canonical_route: null,
      });
      // The other root is unaffected.
      expect(await harness.resolve("@csca")).toMatchObject({ community_id: communities.csca });
      expect(await effective(communities.csca, "clock_timestamp()")).toBe(1);
      // The historical commit response replays unchanged and revives nothing.
      expect(await harness.commit(communities.yahoo, yahoo.started.attachment_intent_id)).toEqual({
        ...yahoo.committed,
        replayed: true,
      });
      expect(await harness.resolve("@yahoo")).toBeNull();
      // Renewal never revives an expired lease, and an expired address cannot
      // be re-attached as if the slot were empty.
      expect(await harness.renew()).toEqual([]);
      expect(await harness.resolve("@yahoo")).toBeNull();
      expect(await refusal(harness.start(communities.yahoo, "yahoo", "again"))).toBe("conflict");
    });
  }, 60_000);

  test("renewal extends an unchanged owner and suspends only a changed one", async () => {
    await withSchema(async (admin, connection) => {
      const chain = makeChain();
      const harness = makeHarness(connection, chain.observer);
      const yahoo = await attach(harness, "yahoo");
      const csca = await attach(harness, "csca");
      expect(await harness.renew()).toEqual([]);
      // Two hours later both leases are live and old enough to renew.
      const age = () =>
        shift(
          admin,
          `UPDATE community_route_ownership_evidence
              SET verified_at=verified_at-interval '2 hours',
                  created_at=created_at-interval '2 hours',
                  expires_at=expires_at-interval '2 hours'
            WHERE evidence_ref IN (SELECT verified_evidence_ref
                                     FROM community_canonical_route_bindings)`,
          [],
        );
      await age();
      // An unavailable verifier changes nothing; the lease keeps running down.
      chain.state.mode = "pending";
      expect((await harness.renew()).map((entry) => entry.outcome)).toEqual([
        "unavailable",
        "unavailable",
      ]);
      chain.state.mode = "verified";
      // A member-name issuance pause is invisible here: the observer reports
      // ownership only. Csca's owner key changes; yahoo's does not.
      chain.owners.set("csca", { outpoint: `${"33".repeat(32)}:0`, key: keyOf(secrets.other) });
      const outcomes = await harness.renew();
      expect(new Map(outcomes.map((entry) => [entry.routeBindingId, entry.outcome]))).toEqual(
        new Map([
          [yahoo.committed.route_binding_id ?? "", "renewed"],
          [csca.committed.route_binding_id ?? "", "owner_changed"],
        ]),
      );
      const rows = await admin.query(
        `SELECT binding.root_label,binding.route_lifecycle_status,binding.ownership_status,
                binding.binding_generation,evidence.origin,
                evidence.expires_at > clock_timestamp()+interval '5 hours' AS extended
           FROM community_canonical_route_bindings AS binding
           LEFT JOIN community_route_ownership_evidence AS evidence
             ON evidence.evidence_ref=binding.verified_evidence_ref
          ORDER BY binding.root_label`,
      );
      expect(rows.rows).toEqual([
        {
          root_label: "csca",
          route_lifecycle_status: "suspended",
          ownership_status: "revoked",
          binding_generation: "2",
          origin: null,
          extended: null,
        },
        {
          root_label: "yahoo",
          route_lifecycle_status: "active",
          ownership_status: "verified",
          binding_generation: "2",
          origin: "spaces_route_renewal",
          extended: true,
        },
      ]);
      expect(await harness.resolve("@yahoo")).toMatchObject({ community_id: communities.yahoo });
      expect(await harness.resolve("@csca")).toBeNull();
      expect(await harness.resolve(communities.csca)).toMatchObject({
        community_id: communities.csca,
      });
      // Neither the old signature nor a new ceremony silently restores it.
      expect(await harness.commit(communities.csca, csca.started.attachment_intent_id)).toEqual({
        ...csca.committed,
        replayed: true,
      });
      expect(await harness.resolve("@csca")).toBeNull();
      expect(await refusal(harness.start(communities.csca, "csca", "restore"))).toBe("conflict");
      expect(await harness.renew()).toEqual([]);
      // The database refuses renewal evidence that names a different owner.
      await age();
      const forgedRenewal = `srenew_${"0".repeat(32)}`;
      await admin.query(
        `INSERT INTO spaces_community_route_renewals
         (renewal_id,route_binding_id,expected_binding_generation,outcome,root_outpoint,
          root_key_hex,observation,observation_sha256_hex,observed_at)
         VALUES ($1,$2,2,'renewed',$3,$4,'\\x01',$5,date_trunc('milliseconds',clock_timestamp()))`,
        [
          forgedRenewal,
          yahoo.committed.route_binding_id,
          `${"99".repeat(32)}:0`,
          keyOf(secrets.other),
          "aa".repeat(32),
        ],
      );
      const forge = (identityDigest: string) =>
        admin.query(
          `INSERT INTO community_route_ownership_evidence (
             evidence_ref,family,root_label,root_label_display,path_segment,requirement_hash,
             provider_id,provider_binding_hash,provider_configuration_version,
             provider_identity_digest,evidence_digest,binding_generation,verified_at,expires_at,
             origin,spaces_route_renewal_id)
           SELECT 'forged-renewal','spaces','yahoo','yahoo','@yahoo',prior.requirement_hash,
                  prior.provider_id,prior.provider_binding_hash,
                  prior.provider_configuration_version,$2,$3,3,renewal.observed_at,
                  renewal.observed_at+interval '6 hours','spaces_route_renewal',renewal.renewal_id
             FROM spaces_community_route_renewals AS renewal
             JOIN community_canonical_route_bindings AS binding
               ON binding.route_binding_id=renewal.route_binding_id
             JOIN community_route_ownership_evidence AS prior
               ON prior.evidence_ref=binding.verified_evidence_ref
            WHERE renewal.renewal_id=$1`,
          [forgedRenewal, identityDigest, "aa".repeat(32)],
        );
      await expect(forge("bb".repeat(32))).rejects.toThrow(/unchanged owner/u);
    });
  }, 60_000);
});

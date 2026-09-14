import { afterAll, describe, expect, test } from "bun:test";
import { compileAccountAgeVerificationPolicy } from "@pirate/domain";
import { startNationalityFixture } from "@pirate/testing/verification";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlaneAccountAgeVerification } from "./account-age-verification.ts";
import { makeControlPlaneAgeAccessStore } from "./age-access-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneVerificationSessionStartStore } from "./verification-start-repository.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("test URL required");
const suite = url ? describe : describe.skip;
const sentinel =
  process.env.CONTROL_PLANE_POSTGRES_ACCOUNT_AGE_VERIFICATION_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-account-age-verification-suite-complete";
let completed = 0;
const compiled = compileAccountAgeVerificationPolicy(
  ["self.pass", "zkpassport"].map((provider_id) => ({
    provider_id,
    provider_configuration: { kind: "dynamic", reference: `fixture:${provider_id}`, version: "1" },
    method: "document",
    protocol_version: provider_id === "self.pass" ? "self-pass-v1" : "zkpassport-v2",
    scope: {
      kind: "named",
      scope_semantics: "issuer_rp_scope",
      issuer: provider_id,
      rp_scope: "pirate-social",
    },
    environment: "test",
  })),
);
if (!compiled) throw new Error("age policy fixture invalid");
const policy = compiled;
const claims = ["age.minimum", "credential.subject_unique", "document.valid"] as const;
async function withDatabase(use: (connection: string, db: Client) => Promise<void>) {
  if (!url) throw new Error("test URL required");
  const schema = `age_verification_${crypto.randomUUID().replaceAll("-", "")}`;
  const connection = new URL(url);
  connection.searchParams.set("options", `-c search_path=${schema}`);
  const db = new Client({ connectionString: url });
  await db.connect();
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  try {
    await applyPostgresTestBaselineConnection({ connectionString: connection.toString() });
    await db.query("INSERT INTO users (user_id) VALUES ('user-a'), ('user-b')");
    await use(connection.toString(), db);
  } finally {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  }
}
function services(connection: string) {
  const layer = makeDirectPostgresControlPlaneLayer(connection);
  const age = makeControlPlaneAccountAgeVerification(layer, policy);
  return {
    age,
    authority: (actor = "user-a") =>
      Effect.runPromise(Effect.scoped(age.store.getVerification({ accountId: actor }))),
    capability: () =>
      Effect.runPromise(
        Effect.scoped(makeControlPlaneAgeAccessStore(layer).getCapability({ accountId: "user-a" })),
      ),
    start: (intent: string, provider: "self.pass" | "zkpassport", actor = "user-a") =>
      startNationalityFixture(
        makeControlPlaneVerificationSessionStartStore(layer),
        age.intents,
        policy,
        { actor_id: actor, intent_id: intent, provider_id: provider },
        claims,
      ),
  };
}
async function first(connection: string) {
  const api = services(connection);
  const state = await api.authority();
  if (state.status !== "verification_required") throw new Error("expected ceremony");
  return { api, state };
}
// The real generic start writes the session; this fixture supplies deterministic local
// provider evidence and a terminal event atomically. It is not a live document proof.
async function completeEvidence(
  db: Client,
  session: string,
  options: {
    age?: string;
    expired?: boolean;
    documentExpires?: string;
    documentExpired?: boolean;
    nationalityOnly?: boolean;
  } = {},
) {
  const suffix = crypto.randomUUID();
  const subject = `subject-${suffix}`,
    binding = `binding-${suffix}`,
    receipt = `receipt-${suffix}`,
    group = `group-${suffix}`;
  const expires = options.expired
    ? new Date(Date.now() + 1500).toISOString()
    : new Date(Date.now() + 86400000).toISOString();
  const assertion = `assertion-${suffix}`;
  await db.query("BEGIN");
  try {
    await db.query(
      `INSERT INTO subject_keys (subject_key_id,issuer,method,scope_kind,issuer_rp_scope,subject_digest)
      SELECT $2,issuer,method,scope_kind,issuer_rp_scope,encode(sha256(convert_to($2::text,'UTF8')),'hex') FROM proof_sessions WHERE proof_session_id=$1`,
      [session, subject],
    );
    await db.query(
      `INSERT INTO subject_key_binding_events (binding_event_id,subject_key_id,binding_epoch,user_id,proof_session_id,binding_kind,idempotency_key,bound_at)
      SELECT $2,$3,1,actor_id,proof_session_id,'initial',$2,clock_timestamp() FROM proof_sessions WHERE proof_session_id=$1`,
      [session, binding, subject],
    );
    await db.query(
      `INSERT INTO evidence_receipts (evidence_receipt_id,proof_session_id,user_id,provider_id,issuer,method,scope_kind,issuer_rp_scope,
      protocol_version,environment,evidence_kind,evidence_hash,receipt_metadata,observed_at,expires_at,provenance_kind,subject_key_id,
      subject_binding_event_id,subject_binding_epoch,provider_configuration_kind,provider_configuration_ref,provider_configuration_version)
      SELECT $2,proof_session_id,actor_id,provider_id,issuer,method,scope_kind,issuer_rp_scope,protocol_version,environment,'document',encode(sha256(convert_to($2::text,'UTF8')),'hex'),'{}',clock_timestamp(),$5,
      'proof_session',$3,$4,1,provider_configuration_kind,provider_configuration_ref,provider_configuration_version FROM proof_sessions WHERE proof_session_id=$1`,
      [session, receipt, subject, binding, expires],
    );
    await db.query(
      `INSERT INTO assertion_bindings(binding_group_id,user_id,binding_mode,subject_key_id,subject_binding_event_id,subject_binding_epoch)
      SELECT $2,actor_id,'same_subject',$3,$4,1 FROM proof_sessions WHERE proof_session_id=$1`,
      [session, group, subject, binding],
    );
    const values = options.nationalityOnly
      ? [["nationality.allowed", { allowed: true }]]
      : [
          ["age.minimum", { minimum_age: options.age ?? "18" }],
          ["credential.subject_unique", { subject_unique: true }],
          ["document.valid", { valid: true }],
        ];
    for (const [index, [claim, value]] of values.entries()) {
      await db.query(
        `INSERT INTO assertions(assertion_id,binding_group_id,evidence_receipt_id,subject_key_id,user_id,claim_id,assertion_value,assurance,observed_at,expires_at)
        SELECT $2,$3,$4,$5,actor_id,$6,$7::jsonb,'document_zk',clock_timestamp(),$8 FROM proof_sessions WHERE proof_session_id=$1`,
        [
          session,
          `${assertion}-${index}`,
          group,
          receipt,
          subject,
          claim,
          JSON.stringify(value),
          claim === "document.valid"
            ? options.documentExpired
              ? new Date(Date.now() + 1500).toISOString()
              : (options.documentExpires ?? expires)
            : expires,
        ],
      );
    }
    await db.query(
      `WITH terminal AS (SELECT clock_timestamp() AS value) UPDATE proof_sessions
      SET status='completed',completed_at=terminal.value,terminal_at=terminal.value,completion_idempotency_key=$2,completion_result_hash=repeat('c',64)
      FROM terminal WHERE proof_session_id=$1`,
      [session, `completion-${suffix}`],
    );
    await db.query(
      `INSERT INTO proof_session_completion_events(completion_event_id,proof_session_id,actor_id,idempotency_key,terminal_status,result_hash,terminal_at)
      SELECT $2,proof_session_id,actor_id,completion_idempotency_key,status,completion_result_hash,terminal_at FROM proof_sessions WHERE proof_session_id=$1`,
      [session, `completion-${suffix}`],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
  if (options.expired || options.documentExpired) await Bun.sleep(1600);
  return { assertion, receipt, subject, binding };
}
async function copyPendingSession(
  db: Client,
  source: string,
  target: string,
  actor: string,
  intent: string,
  recovering = false,
) {
  await db.query(
    `INSERT INTO proof_sessions(proof_session_id,actor_id,intent_id,request_hash,provider_id,
    provider_configuration_kind,provider_configuration_ref,provider_configuration_version,method,issuer,scope_kind,
    issuer_rp_scope,issuer_rp_action_scope,request_mode,protocol_version,environment,status,requested_requirements,
    requested_claim_ids,subject_binding_intent,started_at,expires_at,upstream_session_ref)
    SELECT $2,$3,$4,request_hash,provider_id,provider_configuration_kind,provider_configuration_ref,provider_configuration_version,
    method,issuer,scope_kind,issuer_rp_scope,issuer_rp_action_scope,request_mode,protocol_version,environment,'pending',
    requested_requirements,requested_claim_ids,$5,clock_timestamp(),clock_timestamp()+interval '1 hour',$2
    FROM proof_sessions WHERE proof_session_id=$1`,
    [source, target, actor, intent, recovering ? "recover" : "establish"],
  );
}
suite("renewable account age verification", () => {
  test("replays authority, starts either provider, and fences provider switches and foreign actors", async () => {
    await withDatabase(async (connection) => {
      const { api, state } = await first(connection);
      expect(await api.authority()).toEqual(state);
      const started = await api.start(state.ceremony_intent_id, "self.pass");
      expect(started).toMatchObject({ provider_id: "self.pass", replayed: false });
      expect(await api.start(state.ceremony_intent_id, "self.pass")).toMatchObject({
        proof_session_id: started.proof_session_id,
        replayed: true,
      });
      await expect(
        api.start(state.ceremony_intent_id, "zkpassport", "user-b"),
      ).rejects.toBeDefined();
      const switched = await api.start(state.ceremony_intent_id, "zkpassport");
      const next = await api.authority();
      expect(next).toMatchObject({
        status: "verification_required",
        provider_id: "zkpassport",
        generation: 2,
      });
      expect(switched.proof_session_id).not.toBe(started.proof_session_id);
      await expect(api.start(state.ceremony_intent_id, "self.pass")).rejects.toBeDefined();
    });
    completed++;
  }, 30000);
  test("either provider grants only age capability with the complete witness expiry", async () => {
    await withDatabase(async (connection, db) => {
      const { api, state } = await first(connection);
      const documentExpires = new Date(Date.now() + 3600000).toISOString();
      const self = await api.start(state.ceremony_intent_id, "self.pass");
      const evidence = await completeEvidence(db, self.proof_session_id, { documentExpires });
      expect(await api.authority()).toEqual({
        version: "account-age-verification-v1",
        minimum_age: 18,
        status: "verified",
      });
      expect(await api.capability()).toMatchObject({
        content_rating: "adult_18",
        provider_id: "self.pass",
        evidence_expires_at: documentExpires,
      });
      await db.query(
        `INSERT INTO assertion_revalidation_events(assertion_revalidation_event_id,assertion_id,user_id,evidence_receipt_id,outcome,observed_at)
        VALUES ('revoke-document',$1,'user-a',$2,'revoked',clock_timestamp())`,
        [`${evidence.assertion}-2`, evidence.receipt],
      );
      expect(await api.capability()).toMatchObject({
        content_rating: "general",
        provider_id: null,
        evidence_expires_at: null,
      });
      const renewed = await api.authority();
      if (renewed.status !== "verification_required") throw new Error("expected renewal");
      expect(renewed.ceremony_intent_id).not.toBe(state.ceremony_intent_id);
      const zk = await api.start(renewed.ceremony_intent_id, "zkpassport");
      await completeEvidence(db, zk.proof_session_id);
      expect(await api.capability()).toMatchObject({
        content_rating: "adult_18",
        provider_id: "zkpassport",
      });
      const writes = await db.query(
        "SELECT (SELECT count(*) FROM community_memberships)::int AS memberships, (SELECT count(*) FROM community_follows)::int AS follows, (SELECT count(*) FROM handle_grants)::int AS grants",
      );
      expect(writes.rows).toEqual([{ memberships: 0, follows: 0, grants: 0 }]);
    });
    completed++;
  }, 30000);
  test("a completed superseded generation cannot unlock adult content", async () => {
    await withDatabase(async (connection, db) => {
      const { api, state } = await first(connection);
      const stale = await api.start(state.ceremony_intent_id, "self.pass");
      const current = await api.start(state.ceremony_intent_id, "zkpassport");
      await completeEvidence(db, stale.proof_session_id);
      expect(await api.capability()).toMatchObject({ content_rating: "general" });
      expect(await api.authority()).toMatchObject({
        status: "verification_required",
        generation: 2,
      });
      await completeEvidence(db, current.proof_session_id);
      expect(await api.capability()).toMatchObject({ content_rating: "adult_18" });
    });
    completed++;
  }, 30000);
  test("underage, expired and nationality-only evidence all require a fresh ceremony", async () => {
    await withDatabase(async (connection, db) => {
      const api = services(connection);
      for (const options of [
        { age: "17" },
        { expired: true },
        { nationalityOnly: true },
        { documentExpired: true },
      ]) {
        const state = await api.authority();
        if (state.status !== "verification_required") throw new Error("expected fresh ceremony");
        const started = await api.start(state.ceremony_intent_id, "self.pass");
        await completeEvidence(db, started.proof_session_id, options);
        expect(await api.capability()).toMatchObject({ content_rating: "general" });
        const next = await api.authority();
        expect(next).toMatchObject({ status: "verification_required", generation: 1 });
        if (next.status !== "verification_required") throw new Error("expected renewal");
        expect(next.ceremony_intent_id).not.toBe(state.ceremony_intent_id);
        await expect(api.start(state.ceremony_intent_id, "self.pass")).rejects.toBeDefined();
      }
    });
    completed++;
  }, 30000);
  test("missing provider assembly fails closed without inventing evidence or a ceremony", async () => {
    await withDatabase(async (connection, db) => {
      const age = makeControlPlaneAccountAgeVerification(
        makeDirectPostgresControlPlaneLayer(connection),
        null,
      );
      expect(
        await Effect.runPromise(Effect.scoped(age.store.getVerification({ accountId: "user-a" }))),
      ).toMatchObject({ status: "unavailable" });
      expect(
        (await db.query("SELECT count(*)::int AS count FROM age_verification_ceremony_attempts"))
          .rows,
      ).toEqual([{ count: 0 }]);
    });
    completed++;
  }, 30000);
  test("ownership recovery removes age authority without transferring it to another account", async () => {
    await withDatabase(async (connection, db) => {
      const { api, state } = await first(connection);
      const started = await api.start(state.ceremony_intent_id, "zkpassport");
      const evidence = await completeEvidence(db, started.proof_session_id);
      expect(await api.capability()).toMatchObject({ content_rating: "adult_18" });
      await copyPendingSession(
        db,
        started.proof_session_id,
        "recovery",
        "user-b",
        "recover-age",
        true,
      );
      await db.query(
        `INSERT INTO subject_key_binding_events(binding_event_id,subject_key_id,binding_epoch,user_id,proof_session_id,
        binding_kind,idempotency_key,bound_at,previous_binding_event_id)
        VALUES('recovered',$1,2,'user-b','recovery','recovery','recovered',clock_timestamp(),$2)`,
        [evidence.subject, evidence.binding],
      );
      expect(await api.capability()).toMatchObject({ content_rating: "general" });
      expect(await api.authority("user-b")).toMatchObject({ status: "verification_required" });
      expect(await api.authority()).toMatchObject({ status: "verification_required" });
    });
    completed++;
  }, 30000);
  test("retained catalog evidence remains usable without a renewable ceremony pointer", async () => {
    await withDatabase(async (connection, db) => {
      const { api, state } = await first(connection);
      const started = await api.start(state.ceremony_intent_id, "zkpassport");
      await copyPendingSession(
        db,
        started.proof_session_id,
        "legacy-age",
        "user-b",
        "platform.document.age-18",
      );
      await completeEvidence(db, "legacy-age");
      expect(await api.authority("user-b")).toMatchObject({ status: "verified" });
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS count FROM account_age_verification_current WHERE account_id='user-b'",
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
    });
    completed++;
  }, 30000);
  test("provider configuration drift retires a pending child and refuses its old start", async () => {
    await withDatabase(async (connection) => {
      const { api, state } = await first(connection);
      const rotated = compileAccountAgeVerificationPolicy(
        policy.provider_bindings.map((binding) => ({
          ...binding,
          provider_configuration: { ...binding.provider_configuration, version: "2" },
        })),
      );
      if (!rotated) throw new Error("rotated fixture invalid");
      const age = makeControlPlaneAccountAgeVerification(
        makeDirectPostgresControlPlaneLayer(connection),
        rotated,
      );
      expect(
        await Effect.runPromise(
          Effect.scoped(
            age.intents.resolve({
              actor_id: "user-a",
              intent_id: state.ceremony_intent_id,
              provider_id: "self.pass",
            }),
          ),
        ),
      ).toBeNull();
      const next = await Effect.runPromise(
        Effect.scoped(age.store.getVerification({ accountId: "user-a" })),
      );
      expect(next).toMatchObject({ status: "verification_required", generation: 1 });
      if (next.status !== "verification_required") throw new Error("expected new binding");
      expect(next.ceremony_intent_id).not.toBe(state.ceremony_intent_id);
      await expect(api.start(state.ceremony_intent_id, "self.pass")).rejects.toBeDefined();
    });
    completed++;
  }, 30000);
  afterAll(async () => {
    if (url && completed === 8)
      await Bun.write(
        sentinel,
        "api-next-control-plane-postgres-account-age-verification-suite-complete\n",
      );
  });
});

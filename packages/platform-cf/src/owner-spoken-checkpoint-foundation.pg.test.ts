// Narrow actual255 foundation gate proposal. No provider/capture/checkpoint
// producer or consumer256 supplement. Root owns adoption/execution.
import { expect, test } from "bun:test";
import { Schema } from "effect";
import {
  accountNew,
  completed,
  financialFingerprint,
  fixture,
  pgUrl,
  q,
  reserve,
  run,
  seedGuest,
} from "./owner-spoken-checkpoint-foundation.pg-fixture.ts";
const pgTest = pgUrl ? test : test.skip;
const tables = ["guest_study_spoken_captures", "guest_study_spoken_checkpoints"] as const;
const leaves = [
  "require_owner_guest_source_private_v1(jsonb)",
  "persist_owner_guest_spoken_success_v1(jsonb,jsonb,text,text,jsonb,jsonb)",
  "read_owner_guest_spoken_success_v1(jsonb,jsonb,text,text)",
  "read_owner_guest_spoken_capture_v1(jsonb,jsonb,text,text)",
  "acknowledge_owner_guest_spoken_success_v1(jsonb,jsonb,text,text,jsonb,jsonb,text,bigint)",
] as const;
const primitives = [
  "capture_guest_spoken_dispatch_private_v1(text,jsonb,text,text,text,text,text,bigint,boolean)",
  "persist_guest_spoken_success_private_v1(text,jsonb,text,text,jsonb,jsonb)",
  "load_guest_spoken_success_private_v1(text,jsonb,text,text)",
  "read_guest_spoken_capture_private_v1(text,jsonb,text,text)",
  "require_guest_resource_success_checkpoint_v1(text,text,text,text,numeric)",
  "guest_spoken_component_has_history_private_v1(text[])",
] as const;
const row = <S extends Schema.ConstraintDecoder<unknown>>(s: S, rows: unknown[]) => {
  expect(rows.length).toBe(1);
  return Schema.decodeUnknownSync(s, { onExcessProperty: "error" })(rows[0]);
};

pgTest(
  "genuine0001..255 startup positively checks phase4, native immutable identities and original source ownership",
  () =>
    fixture(async (f) => {
      const phase = row(
        Schema.Struct({
          phase: Schema.Literal("practice_only_owner_spoken_checkpoint_history_v4"),
          singleton: Schema.Literal(true),
        }),
        (await f.admin.query("SELECT phase,singleton FROM guest_learning_schema_phase")).rows,
      );
      expect(phase.singleton).toBe(true);
      await f.admin.query("SELECT require_guest_practice_only_schema_phase_v1()");
      await f.admin.query("SELECT require_guest_study_composition_v1()");
      for (const name of tables) {
        const identity = row(
          Schema.Struct({
            same_owner: Schema.Literal(true),
            same_namespace: Schema.Literal(true),
            kind: Schema.Literal("r"),
            immutable: Schema.Literal(true),
          }),
          (
            await f.admin.query(
              `SELECT
      c.relowner=o.relowner AS same_owner,c.relnamespace=o.relnamespace AS same_namespace,c.relkind::text AS kind,
      EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgenabled='O' AND t.tgtype=27
        AND t.tgfoid='reject_guest_immutable_mutation_v1()'::regprocedure) AS immutable
      FROM pg_class c CROSS JOIN pg_class o WHERE c.oid=$1::regclass AND o.oid='participation_owners'::regclass`,
              [name],
            )
          ).rows,
        );
        expect(identity.immutable).toBe(true);
      }
      expect(
        row(
          Schema.Struct({ n: Schema.Literal(1) }),
          (
            await f.admin.query(`SELECT count(*)::int AS n
    FROM pg_constraint WHERE conrelid='guest_study_spoken_checkpoints'::regclass AND contype='f'
    AND confrelid='guest_study_spoken_captures'::regclass AND cardinality(conkey)=4 AND convalidated`)
          ).rows,
        ).n,
      ).toBe(1);
      const guest = await seedGuest(f, 601);
      const initial = await reserve(f, guest.access, "foundation-private-start", 24);
      const started = completed(await run(f.store.startSession(initial.input)));
      expect(started.result.session.owner_id).toBe(guest.ownerId);
      expect(started.result.session.reward_mode).toBe("practice_only");
      expect(
        row(
          Schema.Struct({ captures: Schema.Literal(0), checkpoints: Schema.Literal(0) }),
          (
            await f.admin.query(`SELECT
    (SELECT count(*)::int FROM guest_study_spoken_captures) AS captures,
    (SELECT count(*)::int FROM guest_study_spoken_checkpoints) AS checkpoints`)
          ).rows,
        ),
      ).toEqual({ captures: 0, checkpoints: 0 });
    }),
  30000,
);

pgTest(
  "real LOGIN has no owner/SET/schema escape and cannot access any private capture/checkpoint table privilege",
  () =>
    fixture(async (f) => {
      for (const name of tables) {
        const privileges = row(
          Schema.Struct({
            owner_member: Schema.Literal(false),
            owner_set: Schema.Literal(false),
            schema_create: Schema.Literal(false),
            select_allowed: Schema.Literal(false),
            insert_allowed: Schema.Literal(false),
            update_allowed: Schema.Literal(false),
            delete_allowed: Schema.Literal(false),
            truncate_allowed: Schema.Literal(false),
          }),
          (
            await f.guest.query(
              `SELECT pg_has_role(current_user,c.relowner,'MEMBER') AS owner_member,
      pg_has_role(current_user,c.relowner,'SET') AS owner_set,
      has_schema_privilege(current_user,c.relnamespace,'CREATE') AS schema_create,
      has_table_privilege(current_user,c.oid,'SELECT') AS select_allowed,
      has_table_privilege(current_user,c.oid,'INSERT') AS insert_allowed,
      has_table_privilege(current_user,c.oid,'UPDATE') AS update_allowed,
      has_table_privilege(current_user,c.oid,'DELETE') AS delete_allowed,
      has_table_privilege(current_user,c.oid,'TRUNCATE') AS truncate_allowed
      FROM pg_class c WHERE c.oid=$1::regclass`,
              [name],
            )
          ).rows,
        );
        expect(privileges.owner_set).toBe(false);
        await expect(f.guest.query(`SELECT * FROM ${q(name)}`)).rejects.toMatchObject({
          code: "42501",
        });
        await expect(f.guest.query(`TRUNCATE ${q(name)}`)).rejects.toMatchObject({ code: "42501" });
      }
      await f.admin.query("SELECT require_guest_learning_runtime_role_v1($1::regrole)", [f.role]);
    }),
  30000,
);

pgTest(
  "all actual five leaf and six primitive functions are same-owner pinned private with no LOGIN/PUBLIC escape",
  () =>
    fixture(async (f) => {
      for (const signature of [...leaves, ...primitives]) {
        const bound = row(
          Schema.Struct({
            owner_matches: Schema.Literal(true),
            namespace_matches: Schema.Literal(true),
            definer: Schema.Literal(true),
            pinned: Schema.Literal(true),
            nonowner_exec: Schema.Literal(false),
          }),
          (
            await f.admin.query(
              `SELECT p.proowner=c.relowner AS owner_matches,p.pronamespace=c.relnamespace AS namespace_matches,
      p.prosecdef AS definer,p.proconfig @> ARRAY[format('search_path=pg_catalog, %I, pg_temp',n.nspname)] AS pinned,
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE') AS nonowner_exec
      FROM pg_proc p CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE p.oid=$1::regprocedure AND c.oid='participation_owners'::regclass`,
              [signature],
            )
          ).rows,
        );
        expect(bound.nonowner_exec).toBe(false);
        expect(
          row(
            Schema.Struct({ allowed: Schema.Literal(false) }),
            (
              await f.guest.query(
                "SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed",
                [signature],
              )
            ).rows,
          ).allowed,
        ).toBe(false);
      }
      await expect(
        f.guest.query("SELECT read_owner_guest_spoken_success_v1('{}','{}','fixture','fixture')"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        f.guest.query(
          "SELECT load_guest_spoken_success_private_v1('fixture','{}','fixture','fixture')",
        ),
      ).rejects.toMatchObject({ code: "42501" });
    }),
  30000,
);

pgTest(
  "positive phase rejects oddly named FK references to each new history relation and restores only after actual removal",
  () =>
    fixture(async (f) => {
      for (const [ordinal, table, key] of [
        [1, tables[0], "capture_id"],
        [2, tables[1], "checkpoint_id"],
      ] as const) {
        const name = `odd_foundation_history_${ordinal}`;
        await f.admin.query(
          `CREATE TABLE ${q(name)}(ordinary_key TEXT REFERENCES ${q(table)}(${q(key)}))`,
        );
        await expect(
          f.admin.query("SELECT require_guest_practice_only_schema_phase_v1()"),
        ).rejects.toMatchObject({ code: "GP003" });
        await f.admin.query(`DROP TABLE ${q(name)}`);
        await f.admin.query("SELECT require_guest_practice_only_schema_phase_v1()");
      }
    }),
  30000,
);

pgTest(
  "actual original Account source/guard/session and financial rows remain preserved after255",
  () =>
    fixture(async (f) => {
      const fingerprint = await financialFingerprint(f);
      const ordinary = await accountNew(f, "ordinary-after-checkpoint-foundation");
      expect(ordinary.persona_id).toBe(f.accountOriginal.persona_id);
      expect(ordinary.community_id).toBe(f.accountOriginal.community_id);
      expect(ordinary.items.length).toBe(f.accountOriginal.items.length);
      expect(ordinary.session_id).toBe("ordinary-after-checkpoint-foundation");
      expect(await financialFingerprint(f)).toEqual(fingerprint);
      const stored = await run(
        f.accountStore.getSession({
          accountId: "study-account",
          communityId: "study-community",
          sessionId: f.accountOriginal.session_id,
        }),
      );
      expect(stored).toEqual(f.accountOriginal);
    }),
  30000,
);

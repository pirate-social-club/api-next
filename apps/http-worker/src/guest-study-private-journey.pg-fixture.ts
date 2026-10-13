// Outside runnable proposal. Intended apps/http-worker/src placement by root.
// Actual maintained source/roles/engines; no route registry activation or SQL overlay.
import { expect } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import {
  makeOwnerGuestStudyService,
  makeOwnerSpokenSuccessProtocol,
} from "@pirate/application/use-cases/guest-learning";
import { guestParticipationRegistry, toErrorBody } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { type Context, Hono } from "hono";
import { Client } from "pg";
import { makeControlPlaneGuestPracticeParticipationReadStore } from "../../../packages/platform-cf/src/guest-practice-participation-read-store.ts";
import { makeControlPlanePreparedGuestStudyContentStore } from "../../../packages/platform-cf/src/guest-prepared-study-content-store.ts";
import {
  type RecoveryDeletionFixture,
  recoveryDeletionFixture,
} from "../../../packages/platform-cf/src/guest-recovery-deletion.pg-fixture.ts";
import { makeGuestRecoveryAudioDeletionStores } from "../../../packages/platform-cf/src/guest-recovery-deletion-store.ts";
import { makeControlPlaneIdentityStore } from "../../../packages/platform-cf/src/identity-repository.ts";
import { makeOriginalAccountStudySourceControl } from "../../../packages/platform-cf/src/owner-account-source-control.ts";
import { makeOwnerLearnerAudioDeletionIo } from "../../../packages/platform-cf/src/owner-audio-deletion-io.ts";
import { makeControlPlaneOwnerGuestSpokenCheckpointRecoveryStores } from "../../../packages/platform-cf/src/owner-guest-spoken-checkpoint-recovery-store.ts";
import { makeOwnerGuestSpokenDispatchContextStore } from "../../../packages/platform-cf/src/owner-guest-spoken-dispatch-context.ts";
import { makeOwnerGuestStudyPublicVisibilityStore } from "../../../packages/platform-cf/src/owner-guest-study-public-visibility.ts";
import { makeControlPlaneOwnerSpokenPreArchiveCheckpointStore } from "../../../packages/platform-cf/src/owner-spoken-checkpoint-store.ts";
import { makeOwnerSpokenFencedArchiveStage } from "../../../packages/platform-cf/src/owner-spoken-fenced-archive.ts";
import { makeOwnerElevenLabsStudyInvokingTranscriber } from "../../../packages/platform-cf/src/owner-study-invoking-transcriber.ts";
import { makeControlPlaneOwnerStudyMutations } from "../../../packages/platform-cf/src/owner-study-mutations.ts";
import {
  disclosure,
  financialFingerprint,
  pgUrl,
  policy,
  q,
  translation,
} from "../../../packages/platform-cf/src/owner-study-starter.pg-fixture.ts";
import { makeControlPlaneOwnerStudyStarter } from "../../../packages/platform-cf/src/owner-study-starter.ts";
import { composeOwnerAwareStudyV2Store } from "../../../packages/platform-cf/src/owner-study-store-composition.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientFactory,
} from "../../../packages/platform-cf/src/postgres.ts";
import type { PostgresMigration } from "../../../packages/platform-cf/src/postgres-migrations.ts";
import { makeSessionCrypto } from "../../../packages/platform-cf/src/session-crypto.ts";
import { makeRs256SessionTokenVerifier } from "../../../packages/platform-cf/src/session-tokens.ts";
import { makeControlPlaneStudyV2Store } from "../../../packages/platform-cf/src/study-v2-repository.ts";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import type { GuestAuthorityControllerName } from "./guest-authority-controllers.ts";
import { makeGuestAuthorityPrivateComposition } from "./guest-authority-private-composition.ts";
import type { GuestLearningControllerName } from "./guest-learning-controllers.ts";
import { makeGuestLearningPrivateComposition } from "./guest-learning-private-composition.ts";
import { decodeInput } from "./transport.ts";

const origin = "https://community.example";

export { financialFingerprint, pgUrl };

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const coreNames = [
  "GetGuestAuthorityV1",
  "IssueGuestBootstrapV1",
  "ConfirmGuestBootstrapV1",
  "RenewGuestAuthorityV1",
  "RotateGuestCredentialV1",
  "AcknowledgeGuestCredentialV1",
  "CleanupGuestBrowserProofV1",
  "CreateGuestAttachmentIntentV1",
] as const;
const studyNames = [
  "GetPublicStudyPreparedContentV1",
  "StartGuestStudySessionV1",
  "GetGuestStudyStartOperationV1",
  "GetGuestStudySessionV1",
  "SubmitGuestStudyAnswerV1",
  "ListGuestParticipationsV1",
  "SetGuestLearningRetentionV1",
  "DeleteGuestLearnerAudioV1",
] as const;
export type Name = GuestAuthorityControllerName | GuestLearningControllerName;
const isCore = (name: Name): name is GuestAuthorityControllerName =>
  (coreNames as readonly string[]).includes(name);
type DecoderEnv = Parameters<typeof decodeInput>[1] extends Context<infer E> ? E : never;
const extraLeaves = [
  "read_guest_browser_proof_snapshot_v1(text,jsonb,jsonb,boolean)",
  "read_guest_learning_lease_observation_v1(text,text,text)",
  "discover_guest_authority_v1(text,text[],text,text,text)",
  "issue_guest_pending_v1(text,text[],text,text,text,text,text,text,text)",
  "confirm_guest_pending_v1(text,text[],text,text)",
  "renew_guest_authority_v1(text,text[],text,text)",
  "issue_guest_rotation_v1(text,text[],text,text,text,text,text,text,text)",
  "acknowledge_guest_rotation_v1(text,text[],text,text,text)",
  "cleanup_guest_authority_v1(text,text[],text[],text,text[],text[])",
  "create_guest_attachment_intent_v1(text,text[],text,text,text[],text,text,text,text,text)",
  "reserve_guest_prepared_study_start_v1(jsonb,jsonb,text,text,text,text,text,text,jsonb,text)",
  "read_owner_guest_answer_source_v1(jsonb,text,text,text)",
  "read_owner_guest_spoken_dispatch_context_v1(jsonb,text,text,text,text)",
  "read_owner_guest_answer_operation_v1(jsonb,text,jsonb,text,text,text,integer)",
  "find_owner_guest_spoken_success_for_audio_v1(jsonb,text,text,text,text,integer,text,text,integer,integer)",
  "list_guest_practice_participations_v1(jsonb,text,integer)",
  "fail_guest_spoken_answer_v1(text,jsonb,text,text,text,text,text)",
] as const;

async function full260() {
  const directory = new URL("../../../db/postgres/migrations/", import.meta.url);
  const manifest = Schema.decodeUnknownSync(
    Schema.Struct({
      algorithm: Schema.Literal("sha256"),
      migrations: Schema.Record(Schema.String, Schema.String),
    }),
  )(JSON.parse(await readFile(new URL("checksums.json", directory), "utf8")));
  const names = (await readdir(directory))
    .filter((n) => /^\d{4}_.+\.sql$/u.test(n) && Number(n.slice(0, 4)) <= 260)
    .sort();
  expect(names.map((n) => Number(n.slice(0, 4)))).toEqual(
    Array.from({ length: 260 }, (_, i) => i + 1),
  );
  const migrations: PostgresMigration[] = [];
  for (const version of names) {
    const sql = await readFile(new URL(version, directory), "utf8"),
      checksum = sha(sql),
      declared = manifest.migrations[version];
    if (Number(version.slice(0, 4)) <= 247 && declared === undefined)
      throw new Error("Immutable historical hash missing");
    if (declared !== undefined) expect(checksum).toBe(declared);
    if (version.startsWith("0259_"))
      expect(checksum).toBe("3b84f8f3798e777bd7aa674363add62854d330b9ef12079fa49e2f2b24ea0dc9");
    if (version.startsWith("0260_"))
      expect(checksum).toBe("efe82c3b3c132217bc6c01f2b73fef5f7940465d9c08ab18c0bcbaeb3b897120");
    migrations.push({ version, sql, checksum });
  }
  return migrations;
}
function pem(bytes: ArrayBuffer, label: "PRIVATE KEY" | "PUBLIC KEY") {
  const lines = btoa(String.fromCharCode(...new Uint8Array(bytes))).match(/.{1,64}/gu);
  if (lines === null) throw new Error("Disposable key encoding unavailable");
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}
async function ephemeralCrypto() {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  return makeSessionCrypto({
    privateKeyPem: pem(await crypto.subtle.exportKey("pkcs8", pair.privateKey), "PRIVATE KEY"),
    publicKeyPem: pem(await crypto.subtle.exportKey("spki", pair.publicKey), "PUBLIC KEY"),
    issuer: "owned-journey",
    audience: "owned-journey",
    defaultScope: "owned-journey-browser",
    defaultTtlSeconds: 300,
  });
}
export function lostCommitAfter(needle: string) {
  let armed = true,
    observed = false;
  const clientFactory: PostgresClientFactory = (_url, configuration) => {
    const client = new Client(configuration);
    let mutation = false;
    return {
      connection: client.connection,
      connect: () => client.connect(),
      end: () => client.end(),
      query: async ({ text, values }) => {
        const result = await client.query({
          text,
          values: values === undefined ? [] : [...values],
        });
        if (text.includes(needle)) mutation = true;
        if (text === "COMMIT" && mutation && armed) {
          armed = false;
          observed = true;
          throw new Error("Owned real COMMIT acknowledgement lost");
        }
        return result;
      },
    };
  };
  return { clientFactory, observed: () => observed };
}
export class Browser {
  readonly cookies = new Map<string, string>();
  selected: string | null = null;
  headers(unsafe: boolean) {
    const headers = new Headers({
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      "cf-connecting-ip": "192.0.2.42",
    });
    if (this.selected !== null) headers.set("x-guest-credential-id", this.selected);
    if (unsafe) {
      headers.set("origin", origin);
      headers.set("x-guest-csrf-token", this.cookies.get("__Host-pirate_guest_csrf") ?? "");
    }
    return headers;
  }
  apply(response: Response) {
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    for (const cookie of response.headers.getSetCookie()) {
      const first = cookie.split(";", 1)[0];
      if (first === undefined) throw new Error("Cookie frame missing");
      const at = first.indexOf("="),
        name = first.slice(0, at),
        value = first.slice(at + 1);
      expect(cookie.includes("Domain=")).toBe(false);
      expect(cookie.includes("; Secure")).toBe(true);
      expect(cookie.includes("HttpOnly")).toBe(name !== "__Host-pirate_guest_csrf");
      if (cookie.includes("Max-Age=0")) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}
export type HttpHarness = {
  request: (
    b: Browser,
    name: Name,
    options?: Readonly<{
      path?: Readonly<Record<string, string>>;
      query?: Readonly<Record<string, string>>;
      body?: unknown;
      audio?: Uint8Array;
      headers?: Headers;
      extraHeaders?: Readonly<Record<string, string>>;
    }>,
  ) => Promise<Response>;
  decoderCalls: () => number;
};
const Snapshot = Schema.Struct({
  accounts: Schema.Int,
  personas: Schema.Int,
  memberships: Schema.Int,
  guests: Schema.Int,
  credentials: Schema.Int,
  sessions: Schema.Int,
  reservations: Schema.Int,
  calls: Schema.Int,
  checkpoints: Schema.Int,
  uploads: Schema.Int,
});
type Snapshot = Schema.Schema.Type<typeof Snapshot>;
export type JourneyFixture = RecoveryDeletionFixture & {
  objects: Map<string, Uint8Array>;
  providerCalls: () => number;
  putCalls: () => number;
  deleteCalls: () => number;
  transcript: (value: string) => void;
  holdNextPut: () => Readonly<{ started: Promise<void>; release: () => void }>;
  rejectNextDelete: () => void;
  harness: (
    options?: Readonly<{
      clientFactory?: PostgresClientFactory;
      policyAbsent?: boolean;
      disclosureAbsent?: boolean;
    }>,
  ) => HttpHarness;
  snapshot: () => Promise<Snapshot>;
};

export async function journeyFixture(use: (f: JourneyFixture) => Promise<void>) {
  await recoveryDeletionFixture(async (f) => {
    if (!pgUrl) throw new Error("Owned PostgreSQL URL required");
    const migrations = await full260(),
      prefix = migrations.slice(0, 258),
      scoped = new URL(pgUrl);
    scoped.searchParams.set("options", `-c search_path=${f.schema}`);
    expect(
      (await f.admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows,
    ).toEqual(prefix.map(({ version, checksum }) => ({ version, checksum })));
    await runPostgresMigrations({
      connectionString: scoped.toString(),
      migrations,
      expectedLedger: prefix,
    });
    expect(
      (await f.admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows,
    ).toEqual(migrations.map(({ version, checksum }) => ({ version, checksum })));
    // Real native source proofs before NEW leaf binds. Existing approved base
    // fixture grants are permitted; PRIVATE helper grants remain absent.
    for (const signature of extraLeaves) {
      const rows = (
        await f.admin.query(
          `SELECT p.proowner=c.relowner AS owned,p.pronamespace=c.relnamespace AS namespace,
        p.prosecdef AS definer,p.proconfig @> ARRAY[format('search_path=pg_catalog, %I, pg_temp',n.nspname)] AS pinned,
        NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE') AS private
        FROM pg_proc p CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE p.oid=$1::regprocedure AND c.oid='participation_owners'::regclass`,
          [signature],
        )
      ).rows;
      expect(rows).toEqual([
        { owned: true, namespace: true, definer: true, pinned: true, private: true },
      ]);
    }
    for (const signature of extraLeaves)
      await f.admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${q(f.role)}`);
    for (const name of [
      "guest_credentials",
      "guest_attachment_intents",
      "guest_study_spoken_captures",
      "guest_study_spoken_checkpoints",
      "learner_audio_artifacts",
    ]) {
      await expect(f.guest.query(`SELECT * FROM ${q(name)} LIMIT 1`)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(f.guest.query(`TRUNCATE ${q(name)}`)).rejects.toMatchObject({ code: "42501" });
    }
    for (const signature of [
      "require_guest_audio_recovery_access_private_v1(jsonb,text)",
      "read_guest_audio_io_capture_private_v1(text)",
      "require_guest_practice_only_schema_phase_v1()",
    ])
      expect(
        (
          await f.guest.query(
            "SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed",
            [signature],
          )
        ).rows[0]?.allowed,
      ).toBe(false);

    // Reuse the executed preparedness role contract, separate from mutations.
    const declaration = Schema.decodeUnknownSync(
      Schema.Struct({
        source: Schema.String,
        source_sha256: Schema.String,
        read_columns: Schema.Record(Schema.String, Schema.Array(Schema.String)),
        predicate_execute: Schema.String,
        no_private_grader: Schema.Literal(true),
        separate_read_only_login: Schema.Literal(true),
      }),
    )(
      JSON.parse(
        await readFile(
          new URL("./guest-study-journey.public-read-columns.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    expect(
      sha(
        await readFile(
          new URL(
            "../../../packages/platform-cf/src/guest-prepared-content.pg.test.ts",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    ).toBe(declaration.source_sha256);
    const readerRole = `gj_public_${crypto.randomUUID().replaceAll("-", "")}`;
    const password = Array.from(randomBytes(32), (b) => b.toString(16).padStart(2, "0")).join("");
    let reader: Client | undefined,
      created = false;
    const retained: Promise<unknown>[] = [],
      requests: Promise<Response>[] = [],
      objects = new Map<string, Uint8Array>();
    const ioHolds: {
      activeRelease: (() => void) | null;
      pending: Readonly<{ started: () => void; wait: Promise<void>; release: () => void }> | null;
    } = { activeRelease: null, pending: null };
    let providerCalls = 0,
      putCalls = 0,
      deleteCalls = 0,
      providerText = "I can love you",
      rejectDelete = false;

    try {
      const statement = (
        await f.admin.query(
          "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD %L',$1::name,$2::text) AS result",
          [readerRole, password],
        )
      ).rows[0]?.result;
      if (typeof statement !== "string") throw new Error("Reader role construction failed");
      await f.admin.query(statement);
      created = true;
      await f.admin.query(
        `GRANT USAGE ON SCHEMA ${q(f.schema)} TO ${q(readerRole)}; ALTER ROLE ${q(readerRole)} SET default_transaction_read_only=on`,
      );
      for (const [table, columns] of Object.entries(declaration.read_columns))
        await f.admin.query(
          `GRANT SELECT(${columns.map(q).join(",")}) ON ${q(table)} TO ${q(readerRole)}`,
        );
      await f.admin.query(
        `GRANT EXECUTE ON FUNCTION can_guest_access_activity_song_v1(text,text) TO ${q(readerRole)}`,
      );
      const readerUrl = new URL(scoped);
      readerUrl.username = readerRole;
      readerUrl.password = password;
      reader = new Client({
        connectionString: readerUrl.toString(),
        connectionTimeoutMillis: 3000,
        statement_timeout: 3000,
      });
      await reader.connect();
      expect(
        (
          await reader.query(
            "SELECT current_user=session_user AS same, current_setting('default_transaction_read_only') AS readonly",
          )
        ).rows,
      ).toEqual([{ same: true, readonly: "on" }]);
      await expect(
        reader.query("SELECT private_grader FROM study_exercise_versions LIMIT 1"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(reader.query("SELECT * FROM guest_credentials LIMIT 1")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        reader.query("SELECT * FROM study_exercise_versions LIMIT 1"),
      ).rejects.toMatchObject({ code: "42501" });
      const crypto = await ephemeralCrypto();
      const publicLayer = makeDirectPostgresControlPlaneLayer(readerUrl.toString(), {
        closeTimeoutMs: 2000,
        logger: { info: () => {}, error: () => {} },
      });
      const outsideSql = async () =>
        expect(
          (
            await f.admin.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=$1 AND state IN ('active','idle in transaction')",
              [f.role],
            )
          ).rows[0]?.n,
        ).toBe(0);
      const bucket = {
        put: async (key: string, bytes: Uint8Array) => {
          await outsideSql();
          putCalls++;
          const pending = ioHolds.pending;
          ioHolds.pending = null;
          if (pending !== null) {
            pending.started();
            await pending.wait;
            if (ioHolds.activeRelease === pending.release) ioHolds.activeRelease = null;
          }
          objects.set(key, new Uint8Array(bytes));
          return { size: bytes.byteLength };
        },
        delete: async (keys: string[]) => {
          await outsideSql();
          deleteCalls++;
          if (rejectDelete) {
            rejectDelete = false;
            throw new Error("Owned DELETE acknowledgement unavailable");
          }
          for (const key of keys) objects.delete(key);
        },
      };
      const harness = (
        options: Readonly<{
          clientFactory?: PostgresClientFactory;
          policyAbsent?: boolean;
          disclosureAbsent?: boolean;
        }> = {},
      ): HttpHarness => {
        const layer = makeDirectPostgresControlPlaneLayer(f.guestUrl, {
          closeTimeoutMs: 2000,
          logger: { info: () => {}, error: () => {} },
          ...(options.clientFactory === undefined ? {} : { clientFactory: options.clientFactory }),
        });
        const rawPolicy = options.policyAbsent ? null : policy;
        const starter = makeControlPlaneOwnerStudyStarter(layer, disclosure, rawPolicy);
        const mutations = makeControlPlaneOwnerStudyMutations(layer, {
          rawPolicy,
          disclosureVersion: options.disclosureAbsent ? null : disclosure.version,
          rerecordEnabled: true,
          providerRetention: "stored",
        });
        const prepared = makeControlPlanePreparedGuestStudyContentStore(publicLayer, disclosure);
        const store = composeOwnerAwareStudyV2Store({
          starter,
          mutations,
          prepared,
          ordinary: makeControlPlaneStudyV2Store(layer),
          originalAccountSources: makeOriginalAccountStudySourceControl(layer),
          verifiedOrdinaryAccount: null,
        });
        const success = makeOwnerSpokenSuccessProtocol(
          makeControlPlaneOwnerSpokenPreArchiveCheckpointStore(layer),
          store,
          makeOwnerSpokenFencedArchiveStage(layer, bucket, (task) => retained.push(task)),
        );
        const study = makeOwnerGuestStudyService({
          store,
          prepared,
          atomicStarter: starter,
          dispatchContext: makeOwnerGuestSpokenDispatchContextStore(layer),
          resourcePolicy: rawPolicy,
          recovery: makeControlPlaneOwnerGuestSpokenCheckpointRecoveryStores(layer).browser,
          visibility: makeOwnerGuestStudyPublicVisibilityStore(publicLayer),
          success,
          rerecordEnabled: true,
          transcriber: makeOwnerElevenLabsStudyInvokingTranscriber({
            apiKey: "owned-disposable-provider-fixture",
            fetch: async () => {
              await outsideSql();
              providerCalls++;
              return Response.json({
                text: providerText,
                language_code: "en",
                language_probability: 0.99,
              });
            },
          }),
        });
        const core = makeGuestAuthorityPrivateComposition({
          controlPlane: layer,
          accountVerifier: makeRs256SessionTokenVerifier(
            crypto,
            makeControlPlaneIdentityStore(layer),
          ),
          ordinarySessionScope: crypto.defaultScope,
          ordinaryProductOrigin: origin,
          nowMilliseconds: () => Date.now(),
          retryAfterSeconds: 2,
          currentResourcePolicy: rawPolicy,
          disclosure,
          trustedEdgeForRequest: async () => null,
        });
        const recovery = makeGuestRecoveryAudioDeletionStores(layer);
        const learning = makeGuestLearningPrivateComposition({
          authority: core,
          services: {
            study,
            participations: makeControlPlaneGuestPracticeParticipationReadStore(layer),
            retention: recovery.retention,
            deletion: recovery.deletion,
            deletionIo: makeOwnerLearnerAudioDeletionIo(recovery.deletion, bucket),
            clock: { now: Effect.sync(() => Date.now()) },
            ids: { next: Effect.sync(() => cryptoRandomId()) },
            retryAfterSeconds: 2,
          },
        });
        const app = new Hono<DecoderEnv>();
        let decoded = 0;
        for (const name of [...coreNames, ...studyNames]) {
          const definition = guestParticipationRegistry[name];
          expect(definition.implementation).toBe("disabled");
          app.on(definition.method, definition.path, async (context) => {
            try {
              const decode = async () => {
                decoded++;
                const value = await decodeInput(definition, context, null);
                const { principal: _, browserParticipation: __, ...locations } = value;
                const edgeClientIp = context.req.header("cf-connecting-ip");
                return {
                  ...locations,
                  signal: context.req.raw.signal,
                  ...(edgeClientIp === undefined ? {} : { edgeClientIp }),
                };
              };
              const result = isCore(name)
                ? await core.handleAuthorityOperation({
                    name,
                    request: context.req.raw,
                    decodeRequestLocations: decode,
                  })
                : await learning.handleLearningOperation({
                    name,
                    request: context.req.raw,
                    decodeRequestLocations: decode,
                  });
              const headers = new Headers(result.responseHeaders);
              headers.set("content-type", "application/json");
              return new Response(JSON.stringify(result.body), {
                status: result.status ?? 200,
                headers,
              });
            } catch (error) {
              const wire = toErrorBody(error);
              return new Response(JSON.stringify(wire.body), {
                status: wire.status,
                headers: {
                  ...wire.headers,
                  "content-type": "application/json",
                  "cache-control": "private, no-store",
                },
              });
            }
          });
        }
        return {
          decoderCalls: () => decoded,
          request: async (b, name, input = {}) => {
            const d = guestParticipationRegistry[name];
            let path: string = d.path;
            for (const [key, value] of Object.entries(input.path ?? {}))
              path = path.replace(`:${key}`, encodeURIComponent(value));
            if (path.includes(":")) throw new Error("Exact path locators required");
            const query = new URLSearchParams(input.query ?? {}),
              headers = input.headers ?? b.headers(d.method !== "GET");
            for (const [key, value] of Object.entries(input.extraHeaders ?? {}))
              headers.set(key, value);
            const bytes =
              input.audio === undefined
                ? input.body === undefined
                  ? undefined
                  : JSON.stringify(input.body)
                : new Uint8Array(input.audio);
            if (input.body !== undefined) headers.set("content-type", "application/json");
            const request = Promise.resolve(
              app.fetch(
                new Request(`${origin}${path}${query.size === 0 ? "" : `?${query}`}`, {
                  method: d.method,
                  headers,
                  ...(bytes === undefined ? {} : { body: bytes }),
                }),
              ),
            );
            requests.push(request);
            return request;
          },
        };
      };
      const snapshot = async () => {
        const counts = (
          await f.admin.query(`SELECT (SELECT count(*)::int FROM users) AS accounts,
          (SELECT count(*)::int FROM personas) AS personas,(SELECT count(*)::int FROM community_memberships) AS memberships,
          (SELECT count(*)::int FROM participation_owners WHERE kind='guest') AS guests,
          (SELECT count(*)::int FROM guest_credentials) AS credentials,(SELECT count(*)::int FROM study_sessions_v2 WHERE participation_owner_kind='guest') AS sessions,
          (SELECT count(*)::int FROM guest_resource_session_reservations) AS reservations,(SELECT count(*)::int FROM guest_resource_provider_calls) AS calls,
          (SELECT count(*)::int FROM guest_study_spoken_checkpoints) AS checkpoints,(SELECT count(*)::int FROM learner_audio_upload_attempts) AS uploads`)
        ).rows[0];
        if (counts === undefined) throw new Error("Snapshot absent");
        return Schema.decodeUnknownSync(Snapshot, { onExcessProperty: "error" })(counts);
      };
      for (let i = 1; i <= 4; i++) await translation(f, i, "ar", "B1");
      await use({
        ...f,
        objects,
        providerCalls: () => providerCalls,
        putCalls: () => putCalls,
        deleteCalls: () => deleteCalls,
        transcript: (value) => {
          providerText = value;
        },
        rejectNextDelete: () => {
          rejectDelete = true;
        },
        harness,
        snapshot,
        holdNextPut: () => {
          let signal: () => void = () => {},
            release: () => void = () => {};
          const started = new Promise<void>((r) => {
              signal = r;
            }),
            wait = new Promise<void>((r) => {
              release = r;
            });
          ioHolds.pending = { started: signal, wait, release };
          ioHolds.activeRelease = release;
          return { started, release };
        },
      });
    } finally {
      ioHolds.pending?.release();
      ioHolds.activeRelease?.();
      await Promise.allSettled(requests);
      await Promise.allSettled(retained);
      if (reader) await reader.end().catch(() => undefined);
      if (created)
        await f.admin.query(`DROP OWNED BY ${q(readerRole)}; DROP ROLE ${q(readerRole)}`);
    }
  });
}
const cryptoRandomId = () => crypto.randomUUID();
export async function json(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return response.json() as Promise<unknown>;
}
export const startBody = (owner: string, key: string, mixed = true) => ({
  idempotency_key: key,
  expected_owner_id: owner,
  target_language: mixed ? "ar" : null,
  learner_band: mixed ? "B1" : null,
  timezone: "UTC",
  reward_mode: "practice_only",
  reward_preview_terms_hash: null,
  disclosure: { version: disclosure.version, accepted: true },
});

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { Client } from "pg";
import { withBrowserSessionFixture } from "./browser-session.pg-fixture.ts";
import { makeControlPlaneBrowserSessionStore } from "./browser-session-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!url && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1")
  throw Error("Test URL required");
const suite = url ? describe : describe.skip;
const sid = () => `bs_${randomUUID().replaceAll("-", "")}`;
const secret = "a".repeat(64),
  csrf = "b".repeat(64),
  origin = "https://app.example.test";
const create = (sessionId = sid(), accountId = "account-a", providerSubject = "did:privy:a") => ({
  sessionId,
  accountId,
  providerAppId: "privy-test",
  providerSubject,
  scope: "user",
  origin,
  renewable: true,
  secretHash: secret,
  csrfHash: csrf,
  accessSeconds: 3600,
  proofExpiresAt: Math.floor(Date.now() / 1000) + 3600,
  replacement: null,
});
async function seed(owner: Client) {
  await owner.query(`INSERT INTO users(user_id) VALUES('account-a'),('account-b');
    INSERT INTO identity_credentials(credential_id,provider,provider_app_id,provider_subject,canonical_user_id)
    VALUES('credential-a','privy','privy-test','did:privy:a','account-a'),
      ('credential-b','privy','privy-test','did:privy:b','account-b')`);
}

suite("persisted browser-session authority", () => {
  test("uses restricted facades, preserves renewable identity and revokes every access without raw privileges", async () => {
    await withBrowserSessionFixture(url!, async (f) => {
      await seed(f.owner);
      const store = makeControlPlaneBrowserSessionStore(
        makeDirectPostgresControlPlaneLayer(f.runtimeUrl),
      );
      const input = create();
      const row = await Effect.runPromise(store.create(input));
      expect(row.accountId).toBe("account-a");
      expect(row.idleExpiresAt - row.now).toBe(30 * 86400);
      expect(row.absoluteExpiresAt - row.now).toBe(90 * 86400);
      const authority = { sessionId: input.sessionId, secretHash: secret, csrfHash: csrf, origin };
      const [first, second] = await Promise.all(
        [store.renew(authority), store.renew(authority)].map(Effect.runPromise),
      );
      expect(first?.sessionId).toBe(input.sessionId);
      expect(second?.sessionId).toBe(input.sessionId);
      expect(second?.absoluteExpiresAt).toBe(row.absoluteExpiresAt);
      expect(
        await Effect.runPromise(store.renew({ ...authority, secretHash: "c".repeat(64) })),
      ).toBeNull();
      expect(
        await Effect.runPromise(store.renew({ ...authority, csrfHash: "c".repeat(64) })),
      ).toBeNull();
      expect(
        await Effect.runPromise(
          store.renew({ ...authority, origin: "https://other.example.test" }),
        ),
      ).toBeNull();
      const access = { sessionId: input.sessionId, accountId: input.accountId, scope: input.scope };
      expect(await Effect.runPromise(store.access(access))).not.toBeNull();
      expect(await Effect.runPromise(store.revoke({ ...authority, accountId: null }))).toBe(true);
      expect(await Effect.runPromise(store.revoke({ ...authority, accountId: null }))).toBe(true);
      expect(await Effect.runPromise(store.access(access))).toBeNull();
      expect(await Effect.runPromise(store.renew(authority))).toBeNull();
      for (const query of [
        "SELECT * FROM browser_sessions",
        "UPDATE browser_sessions SET revoked_at=NULL",
        "SELECT browser_session_account_matches_v1('account-a','account-a')",
        "TRUNCATE browser_sessions",
      ])
        await expect(f.runtime.query(query)).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await f.owner.query(
            "SELECT renewal_secret_hash,csrf_hash FROM browser_sessions WHERE session_id=$1",
            [input.sessionId],
          )
        ).rows[0],
      ).toEqual({ renewal_secret_hash: secret, csrf_hash: csrf });
    });
  });

  test("replacement revokes the presented family atomically and rejects wrong credential/account before allocating", async () => {
    await withBrowserSessionFixture(url!, async (f) => {
      await seed(f.owner);
      const a = create();
      await f.runtime.query("SELECT create_browser_session_v1($1)", [a]);
      const b = {
        ...create(sid(), "account-b", "did:privy:b"),
        replacement: {
          sessionId: a.sessionId,
          secretHash: secret,
          accountId: null,
          csrfHash: csrf,
          origin,
        },
      };
      await f.runtime.query("SELECT create_browser_session_v1($1)", [b]);
      expect(
        (
          await f.runtime.query("SELECT renew_browser_session_v1($1,$2,$3,$4) packet", [
            a.sessionId,
            secret,
            csrf,
            origin,
          ])
        ).rows[0].packet,
      ).toBeNull();
      const wrong = create(sid(), "account-a", "did:privy:b");
      await expect(
        f.runtime.query("SELECT create_browser_session_v1($1)", [wrong]),
      ).rejects.toMatchObject({ code: "28000" });
      expect(
        (
          await f.owner.query(
            "SELECT count(*)::int count FROM browser_sessions WHERE session_id=$1",
            [wrong.sessionId],
          )
        ).rows[0].count,
      ).toBe(0);
      const failed = {
        ...wrong,
        replacement: {
          sessionId: b.sessionId,
          secretHash: secret,
          accountId: null,
          csrfHash: csrf,
          origin,
        },
      };
      await expect(
        f.runtime.query("SELECT create_browser_session_v1($1)", [failed]),
      ).rejects.toMatchObject({ code: "28000" });
      expect(
        (
          await f.owner.query(
            "SELECT count(*)::int count FROM browser_sessions WHERE session_id=$1",
            [failed.sessionId],
          )
        ).rows[0].count,
      ).toBe(0);
      expect(
        (
          await f.runtime.query(
            "SELECT read_browser_session_access_v1($1,'account-b','user') packet",
            [b.sessionId],
          )
        ).rows[0].packet,
      ).not.toBeNull();
      await f.owner.query(
        "UPDATE identity_credentials SET status='tombstoned' WHERE credential_id='credential-b'",
      );
      expect(
        (
          await f.runtime.query(
            "SELECT read_browser_session_access_v1($1,'account-b','user') packet",
            [b.sessionId],
          )
        ).rows[0].packet,
      ).toBeNull();
    });
  });

  test("setup sessions cannot renew or outlive their original proof", async () => {
    await withBrowserSessionFixture(url!, async (f) => {
      await seed(f.owner);
      const input = {
        ...create(),
        scope: "persona-wallet-setup-v1",
        renewable: false,
        secretHash: null,
        proofExpiresAt: Math.floor(Date.now() / 1000) + 90,
      };
      const row = (await f.runtime.query("SELECT create_browser_session_v1($1) packet", [input]))
        .rows[0].packet;
      expect(row.renewable).toBe(false);
      expect(row.absoluteExpiresAt - row.now).toBeLessThanOrEqual(90);
      expect(
        (
          await f.runtime.query("SELECT renew_browser_session_v1($1,$2,$3,$4) packet", [
            input.sessionId,
            secret,
            csrf,
            origin,
          ])
        ).rows[0].packet,
      ).toBeNull();
      await expect(
        f.runtime.query("SELECT create_browser_session_v1($1)", [
          { ...create(), scope: "persona-wallet-setup-v1" },
        ]),
      ).rejects.toMatchObject({ code: "22023" });
      await expect(
        f.runtime.query("SELECT create_browser_session_v1($1)", [
          { ...create(), proofExpiresAt: 1 },
        ]),
      ).rejects.toMatchObject({ code: "28000" });
    });
  });
});

async function waitForLock(owner: Client, pid: number) {
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    const row = (
      await owner.query("SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [pid])
    ).rows[0];
    if (row.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected fixture operation to wait for its owned lock");
}

suite("browser-session expiry and account fences", () => {
  test("access and renewal reject changed credentials and deleted accounts", async () => {
    for (const mutation of [
      "UPDATE identity_credentials SET status='tombstoned' WHERE credential_id='credential-a'",
      "UPDATE identity_credentials SET provider_subject='changed' WHERE credential_id='credential-a'",
      "UPDATE identity_credentials SET provider_app_id='changed' WHERE credential_id='credential-a'",
      "UPDATE identity_credentials SET canonical_user_id='account-b' WHERE credential_id='credential-a'",
      "UPDATE users SET status='deleted' WHERE user_id='account-a'",
    ])
      await withBrowserSessionFixture(url!, async (f) => {
        await seed(f.owner);
        const input = create();
        await f.runtime.query("SELECT create_browser_session_v1($1)", [input]);
        await f.owner.query(mutation);
        expect(
          (
            await f.runtime.query(
              "SELECT read_browser_session_access_v1($1,'account-a','user') packet",
              [input.sessionId],
            )
          ).rows[0].packet,
        ).toBeNull();
        expect(
          (
            await f.runtime.query("SELECT renew_browser_session_v1($1,$2,$3,$4) packet", [
              input.sessionId,
              secret,
              csrf,
              origin,
            ])
          ).rows[0].packet,
        ).toBeNull();
      });
  });

  test("a valid alias is renewable, but redirect, cycle, inactive edge or deleted owner refuses", async () => {
    for (const mutation of [
      "UPDATE account_aliases SET status='inactive' WHERE source_user_id='account-a'",
      "UPDATE account_aliases SET canonical_user_id='account-c' WHERE source_user_id='account-a'",
      "INSERT INTO account_aliases VALUES('account-b','account-a','alias','active',now())",
      "UPDATE users SET status='deleted' WHERE user_id='account-a'",
      "UPDATE users SET status='deleted' WHERE user_id='account-b'",
    ])
      await withBrowserSessionFixture(url!, async (f) => {
        await seed(f.owner);
        await f.owner.query(
          "INSERT INTO users(user_id) VALUES('account-c'); INSERT INTO account_aliases VALUES('account-a','account-b','alias','active',now())",
        );
        const input = create(sid(), "account-b", "did:privy:a");
        await f.runtime.query("SELECT create_browser_session_v1($1)", [input]);
        expect(
          (
            await f.runtime.query("SELECT renew_browser_session_v1($1,$2,$3,$4) packet", [
              input.sessionId,
              secret,
              csrf,
              origin,
            ])
          ).rows[0].packet.accountId,
        ).toBe("account-b");
        await f.owner.query(mutation);
        expect(
          (
            await f.runtime.query(
              "SELECT read_browser_session_access_v1($1,'account-b','user') packet",
              [input.sessionId],
            )
          ).rows[0].packet,
        ).toBeNull();
        expect(
          (
            await f.runtime.query("SELECT renew_browser_session_v1($1,$2,$3,$4) packet", [
              input.sessionId,
              secret,
              csrf,
              origin,
            ])
          ).rows[0].packet,
        ).toBeNull();
      });
  });

  for (const lock of ["session", "credential"] as const) {
    for (const expiry of ["idle", "absolute"] as const) {
      test(`renewal refuses ${expiry} expiry after waiting on the ${lock} lock`, async () => {
        await withBrowserSessionFixture(url!, async (f) => {
          await seed(f.owner);
          const id = sid();
          await f.owner.query(
            `INSERT INTO browser_sessions(session_id,account_id,credential_id,credential_user_id,
            provider_app_id,provider_subject,scope,browser_origin,renewable,renewal_secret_hash,csrf_hash,
            created_at,idle_expires_at,absolute_expires_at)
            VALUES($1,'account-a','credential-a','account-a','privy-test','did:privy:a','user',$2,true,$3,$4,
            clock_timestamp()-interval '89 days',clock_timestamp()+interval '600 milliseconds',
            clock_timestamp()+$5::interval)`,
            [id, origin, secret, csrf, expiry === "idle" ? "20 seconds" : "600 milliseconds"],
          );
          const before = (
            await f.owner.query(
              "SELECT idle_expires_at::text deadline FROM browser_sessions WHERE session_id=$1",
              [id],
            )
          ).rows[0].deadline;
          const pid = (await f.runtime.query("SELECT pg_backend_pid() pid")).rows[0].pid;
          await f.owner.query("BEGIN");
          let pending: ReturnType<Client["query"]> | undefined;
          try {
            if (lock === "session")
              await f.owner.query("SELECT 1 FROM browser_sessions WHERE session_id=$1 FOR UPDATE", [
                id,
              ]);
            else
              await f.owner.query(
                "SELECT 1 FROM identity_credentials WHERE credential_id='credential-a' FOR UPDATE",
              );
            pending = f.runtime.query("SELECT renew_browser_session_v1($1,$2,$3,$4) packet", [
              id,
              secret,
              csrf,
              origin,
            ]);
            await waitForLock(f.owner, pid);
            await f.owner.query("SELECT pg_sleep(0.7)");
          } finally {
            await f.owner.query("ROLLBACK");
          }
          expect((await pending!).rows[0].packet).toBeNull();
          expect(
            (
              await f.owner.query(
                "SELECT idle_expires_at::text deadline FROM browser_sessions WHERE session_id=$1",
                [id],
              )
            ).rows[0].deadline,
          ).toBe(before);
        });
      });
    }
  }

  for (const first of ["renew", "logout"] as const) {
    test(`${first} first serializes with the competing operation and logout replay stays revoked`, async () => {
      await withBrowserSessionFixture(url!, async (f) => {
        await seed(f.owner);
        const input = create();
        await f.runtime.query("SELECT create_browser_session_v1($1)", [input]);
        const other = new Client({ connectionString: f.runtimeUrl });
        await other.connect();
        try {
          const pid = (await f.runtime.query("SELECT pg_backend_pid() pid")).rows[0].pid;
          const otherPid = (await other.query("SELECT pg_backend_pid() pid")).rows[0].pid;
          const renew = (client: Client) =>
            client.query("SELECT renew_browser_session_v1($1,$2,$3,$4) packet", [
              input.sessionId,
              secret,
              csrf,
              origin,
            ]);
          const logout = (client: Client) =>
            client.query("SELECT revoke_browser_session_v1($1,$2,NULL,$3,$4) packet", [
              input.sessionId,
              secret,
              csrf,
              origin,
            ]);
          await f.owner.query("BEGIN");
          let leading!: ReturnType<typeof renew>, following!: ReturnType<typeof renew>;
          try {
            await f.owner.query("SELECT 1 FROM browser_sessions WHERE session_id=$1 FOR UPDATE", [
              input.sessionId,
            ]);
            leading = first === "renew" ? renew(f.runtime) : logout(f.runtime);
            await waitForLock(f.owner, pid);
            following = first === "renew" ? logout(other) : renew(other);
            await waitForLock(f.owner, otherPid);
          } finally {
            await f.owner.query("ROLLBACK");
          }
          const [a, b] = await Promise.all([leading, following]);
          if (first === "renew") {
            expect(a.rows[0].packet.sessionId).toBe(input.sessionId);
            expect(b.rows[0].packet).toBe(true);
          } else {
            expect(a.rows[0].packet).toBe(true);
            expect(b.rows[0].packet).toBeNull();
          }
          expect((await logout(other)).rows[0].packet).toBe(true);
          expect(
            (
              await f.runtime.query(
                "SELECT read_browser_session_access_v1($1,'account-a','user') packet",
                [input.sessionId],
              )
            ).rows[0].packet,
          ).toBeNull();
          expect((await renew(f.runtime)).rows[0].packet).toBeNull();
        } finally {
          await other.end();
        }
      });
    });
  }

  test("facades ignore a hostile runtime search path and temporary session table", async () => {
    await withBrowserSessionFixture(url!, async (f) => {
      await seed(f.owner);
      const input = create();
      await f.runtime.query("SELECT create_browser_session_v1($1)", [input]);
      await f.runtime.query("CREATE TEMP TABLE browser_sessions(session_id text)");
      await f.runtime.query(`SET search_path=pg_temp,${f.quote(f.schema)},pg_catalog`);
      const read = `SELECT ${f.quote(f.schema)}.read_browser_session_access_v1($1,'account-a','user') packet`;
      expect((await f.runtime.query(read, [input.sessionId])).rows[0].packet.sessionId).toBe(
        input.sessionId,
      );
      const funcs = (
        await f.owner.query(
          "SELECT proconfig FROM pg_proc WHERE pronamespace=$1::regnamespace AND proname LIKE '%browser_session%'",
          [f.schema],
        )
      ).rows;
      expect(funcs.length).toBe(8);
      expect(
        funcs.every((row) =>
          row.proconfig?.some(
            (config: string) => config === `search_path=${f.schema}, pg_catalog, pg_temp`,
          ),
        ),
      ).toBe(true);
    });
  });
});

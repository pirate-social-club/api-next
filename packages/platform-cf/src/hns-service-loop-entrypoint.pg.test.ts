import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { preflightEncodeHnsResourceV1 } from "@pirate/application/namespace-ownership";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

/**
 * The production entrypoint, driving the proven composition.
 *
 * Everything before this ran the lifecycle runner from a test. The runner was
 * real and the observer was real, but nothing in the deployed service called
 * either: `main.ts` claimed provisioning and observation only. This test starts
 * the provisioner the way the service does — `bun src/main.ts --serve`, its own
 * process, its own configuration, its own database URL — and lets it drive two
 * concurrent operations against a live regtest chain.
 *
 * What it proves, in order: two names advance under one process without either
 * blocking the other; a restarted process reclaims a crashed executor's expired
 * lease; a job held under a live foreign lease is left alone and its holder's
 * fence is refused once the service has reclaimed it; and the finality anchor
 * and deadline established by the first qualifying observation are identical at
 * the end.
 *
 * Two accommodations, stated rather than hidden. The policy's observation
 * cadence is fifteen minutes, so the test moves queued jobs' persisted due
 * times forward between mining rounds; that is the same operation a recovery
 * sweep performs and it exercises the real claim path. And the operations are
 * seeded directly in `checking_publication` with their plan digests, because
 * the provisioning leg that would expose those plans needs a PowerDNS
 * authority this harness does not have.
 *
 * Skips unless both a PostgreSQL URL and a reachable regtest node are present.
 */

const baseConnectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const nodeUrl = process.env.HSD_REGTEST_NODE_URL ?? "http://127.0.0.1:14037/";
const walletUrl = process.env.HSD_REGTEST_WALLET_URL ?? "http://127.0.0.1:14039/";
const apiKey = process.env.HSD_REGTEST_API_KEY ?? "controlled-progression";
const authorization = `Basic ${Buffer.from(`x:${apiKey}`).toString("base64")}`;

async function reachable(): Promise<boolean> {
  if (baseConnectionString === undefined) return false;
  try {
    const response = await fetch(nodeUrl, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ method: "getblockchaininfo", params: [] }),
      signal: AbortSignal.timeout(4_000),
    });
    const body = (await response.json()) as { readonly result?: { readonly chain?: string } };
    return body.result?.chain === "regtest";
  } catch {
    return false;
  }
}

const suite = (await reachable()) ? describe : describe.skip;
const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;

async function rpc(url: string, method: string, params: readonly unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as { readonly result?: unknown; readonly error?: unknown };
  if (body.error !== null && body.error !== undefined) {
    throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  }
  return body.result;
}

const node = (method: string, params: readonly unknown[] = []) => rpc(nodeUrl, method, params);
const wallet = (method: string, params: readonly unknown[] = []) => rpc(walletUrl, method, params);

const entrypoint = fileURLToPath(
  new URL("../../../apps/hns-authority-provisioner/src/main.ts", import.meta.url),
);
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const entrypointSha256 = createHash("sha256")
  .update(Buffer.from(await Bun.file(entrypoint).arrayBuffer()))
  .digest("hex");
const started: { process: Bun.Subprocess | null } = { process: null };
afterAll(() => {
  started.process?.kill("SIGKILL");
});

suite("the HNS provisioner entrypoint drives the lifecycle composition", () => {
  test("two names advance under one service process, across a restart, with fences and deadlines held", async () => {
    const database = `hns_loop_${randomUUID().replaceAll("-", "")}`.slice(0, 60);
    const admin = new Client({ connectionString: baseConnectionString });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${quote(database)}`);
    await admin.end().catch(() => undefined);

    const url = new URL(baseConnectionString ?? "");
    url.pathname = `/${database}`;
    const connectionString = url.toString();
    const client = new Client({ connectionString });
    await client.connect();

    let service: Bun.Subprocess | null = null;
    const output: string[] = [];
    const secretDirectory = await mkdtemp(join(tmpdir(), "hns-loop-"));
    const secretFile = join(secretDirectory, "axfr.key");
    await writeFile(secretFile, Buffer.from(randomBytes(32)).toString("base64"));

    const startService = async (executorId: string): Promise<Bun.Subprocess> => {
      const spawned = Bun.spawn({
        cmd: ["bun", "run", entrypoint, "--serve"],
        cwd: repositoryRoot,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          CONTROL_PLANE_POSTGRES_URL: connectionString,
          HNS_AUTHORITY_EXECUTOR_ID: executorId,
          HNS_AUTHORITY_BUNDLE_SHA256: entrypointSha256,
          HNS_AUTHORITY_ATTEMPT_ID: "entrypoint-suite-attempt",
          HNS_AUTHORITY_ENVIRONMENT: "regtest",
          HNS_AUTHORITY_GATEWAY_IPV4: "127.0.0.1",
          HNS_AUTHORITY_GATEWAY_LOCAL_IPV4: "127.0.0.1",
          HNS_AUTHORITY_SHARED_TLSA: `3 1 1 ${"a".repeat(64)}`,
          HNS_AUTHORITY_TTL_SECONDS: "300",
          HNS_AUTHORITY_READINESS_VALID_FOR_SECONDS: "3600",
          HNS_AUTHORITY_READINESS_TIMEOUT_MS: "4000",
          HNS_AUTHORITY_HSD_RPC_URL: nodeUrl,
          HNS_AUTHORITY_HSD_AUTHORIZATION: authorization,
          HNS_AUTHORITY_CHAIN_NETWORK: "regtest",
          HNS_AUTHORITY_CHAIN_GENESIS_BLOCK_HASH: genesis,
          HNS_AUTHORITY_TREE_INTERVAL_BLOCKS: "5",
          HNS_AUTHORITY_SAFE_CONFIRMATIONS: "12",
          HNS_AUTHORITY_MAXIMUM_TIP_AGE_SECONDS: "86400",
          HNS_AUTHORITY_MAXIMUM_FUTURE_TIP_SECONDS: "3600",
          // The provisioning and teardown classes take their turns against
          // an authority that is deliberately unreachable here: they must
          // find no work and never interfere with lifecycle processing.
          HNS_AUTHORITY_PDNS_API_URL: "http://127.0.0.1:9/",
          HNS_AUTHORITY_PDNS_API_KEY: "unused",
          HNS_AUTHORITY_PDNS_SERVER_ID: "localhost",
          HNS_AUTHORITY_PDNS_SOA_CONTENT: "ns1.pirate. hostmaster.pirate. 1 3600 600 604800 300",
          HNS_AUTHORITY_AXFR_TSIG_KEY_NAME: "loop-key",
          HNS_AUTHORITY_AXFR_TSIG_SECRET_FILE: secretFile,
          HNS_AUTHORITY_GATEWAY_DEPLOYMENT_REFERENCE: "loop-gateway",
          HNS_AUTHORITY_NS1_NAME: "ns1.pirate",
          HNS_AUTHORITY_NS1_ADDRESS: "127.0.0.1",
          HNS_AUTHORITY_NS2_NAME: "ns2.pirate",
          HNS_AUTHORITY_NS2_ADDRESS: "127.0.0.2",
          HNS_AUTHORITY_DNS_LOCAL_IPV4: "127.0.0.1",
        },
      });
      started.process = spawned;
      void (async () => {
        for await (const chunk of spawned.stdout as ReadableStream<Uint8Array>) {
          output.push(new TextDecoder().decode(chunk));
        }
      })();
      void (async () => {
        for await (const chunk of spawned.stderr as ReadableStream<Uint8Array>) {
          output.push(new TextDecoder().decode(chunk));
        }
      })();
      return spawned;
    };

    const stopService = async (): Promise<void> => {
      if (service === null) return;
      service.kill("SIGTERM");
      await Promise.race([service.exited, Bun.sleep(20_000)]);
      if (service.exitCode === null) service.kill("SIGKILL");
      await service.exited;
      service = null;
      started.process = null;
    };

    const phases = async (): Promise<Map<string, Record<string, unknown>>> => {
      const rows = await client.query<Record<string, unknown>>(
        `SELECT root_import_session_id, phase, revision, observation_count,
                  first_current_observation_at, finality_deadline_at,
                  publication_deadline_at, plan_exposed_at
             FROM hns_root_import_lifecycle ORDER BY root_import_session_id`,
      );
      return new Map(rows.rows.map((row) => [String(row.root_import_session_id), row]));
    };

    const nudgeDueJobs = () =>
      client.query(
        `UPDATE hns_root_import_lifecycle_jobs
              SET due_at = clock_timestamp() - interval '1 second'
            WHERE state = 'queued' AND due_at > clock_timestamp()`,
      );

    /** Polls a condition against the database while the service runs. */
    const until = async (
      description: string,
      condition: () => Promise<boolean>,
      budgetMs: number,
    ): Promise<void> => {
      const deadline = Date.now() + budgetMs;
      while (Date.now() < deadline) {
        if (await condition()) return;
        await Bun.sleep(500);
      }
      throw new Error(`timed out waiting for ${description}: ${output.join("").slice(-2_000)}`);
    };

    const genesis = (await node("getblockhash", [0])) as string;

    try {
      for (const migration of await loadPostgresMigrations()) await client.query(migration.sql);
      // The cutover contract requires the running service to prove its staged
      // identity and complete one controlled readiness job before it serves.
      await client.query("SELECT seed_hns_lifecycle_readiness_cutover_probe_v1()");

      // Two names acquired and published in the same auction sequence: the
      // service must advance both, not one at a time.
      const stamp = Date.now().toString(36);
      const names = [`loopone${stamp}`, `looptwo${stamp}`] as const;
      const address = (await wallet("getnewaddress", [])) as string;
      const mine = (count: number) => node("generatetoaddress", [count, address]);

      await mine(110);
      for (const name of names) await wallet("sendopen", [name]);
      await mine(8);
      for (const name of names) await wallet("sendbid", [name, 5, 10]);
      await mine(6);
      await wallet("sendreveal", []);
      await mine(12);

      const digests = new Map<string, string>();
      for (const name of names) {
        const records = [
          { type: "NS", ns: "ns1.pirate." },
          { type: "NS", ns: "ns2.pirate." },
          { type: "TXT", txt: [`pirate-verification=${name}`] },
        ] as const;
        digests.set(name, (await preflightEncodeHnsResourceV1(records as never)).sha256);
        await wallet("sendupdate", [name, { records }]);
      }
      await mine(1);
      const inclusion = ((await node("getblockchaininfo")) as { readonly blocks: number }).blocks;

      for (const name of names) {
        const session = `session-${name}`;
        await client.query(
          `INSERT INTO hns_root_import_lifecycle (
               root_import_session_id, root_label, phase, revision, generation,
               plan_exposed_at, publication_deadline_at, pending_reason,
               policy_name, policy_digest
             ) VALUES ($1,$2,'checking_publication',1,1,
               clock_timestamp() - interval '1 hour', clock_timestamp() + interval '13 days',
               'awaiting_publication','hns_root_import_lifecycle_v1','entrypoint')`,
          [session, name],
        );
        await client.query("SELECT set_hns_root_import_lifecycle_plan_digest_v1($1,$2)", [
          session,
          digests.get(name),
        ]);
        await client.query(
          `INSERT INTO hns_root_import_lifecycle_jobs (root_import_session_id, job_kind, due_at)
               VALUES ($1,'observe_current', clock_timestamp() - interval '1 second')`,
          [session],
        );
      }

      service = await startService("loop-executor-1");

      // Both operations reach the finality wait under one process.
      await until(
        "both names to record a qualifying current observation",
        async () => {
          const state = await phases();
          return names.every(
            (name) => state.get(`session-${name}`)?.phase === "waiting_safe_commitment",
          );
        },
        180_000,
      );
      const anchored = await phases();
      for (const name of names) {
        const row = anchored.get(`session-${name}`);
        expect(row?.first_current_observation_at).not.toBeNull();
        expect(row?.finality_deadline_at).not.toBeNull();
      }

      // The safe view lags the current view until the tree commits. Mine
      // past the commitment boundary, moving persisted due times forward so
      // the fifteen-minute cadence does not dominate the test.
      await until(
        "both names to reach checking_authority through the safe view",
        async () => {
          await mine(5);
          await nudgeDueJobs();
          await Bun.sleep(1_500);
          const state = await phases();
          return names.every(
            (name) => state.get(`session-${name}`)?.phase === "checking_authority",
          );
        },
        300_000,
      );

      const advanced = await phases();
      for (const name of names) {
        // The anchor and its deadline were established once and never
        // recomputed by any later observation the service made.
        expect(advanced.get(`session-${name}`)?.first_current_observation_at).toEqual(
          anchored.get(`session-${name}`)?.first_current_observation_at,
        );
        expect(advanced.get(`session-${name}`)?.finality_deadline_at).toEqual(
          anchored.get(`session-${name}`)?.finality_deadline_at,
        );
        expect(Number(advanced.get(`session-${name}`)?.observation_count)).toBeGreaterThan(0);
      }

      // Restart and reclaim: a crashed executor leaves a job leased with an
      // expired lease. A restarted service must take it over, not wait for
      // an owner that no longer exists.
      await stopService();
      const abandoned = await client.query<{ readonly lifecycle_job_id: string }>(
        `INSERT INTO hns_root_import_lifecycle_jobs (
             root_import_session_id, job_kind, due_at, state, attempt_count,
             leased_by, lease_expires_at, lease_fence
           ) VALUES ($1,'observe_current', clock_timestamp() - interval '1 minute',
             'leased', 1, 'crashed-executor', clock_timestamp() - interval '1 minute', 7)
           RETURNING lifecycle_job_id`,
        [`session-${names[0]}`],
      );
      const abandonedId = abandoned.rows[0]?.lifecycle_job_id;
      expect(abandonedId).toBeDefined();

      service = await startService("loop-executor-2");
      await until(
        "the restarted service to reclaim the abandoned lease",
        async () => {
          const row = await client.query<Record<string, unknown>>(
            "SELECT state, leased_by, lease_fence FROM hns_root_import_lifecycle_jobs WHERE lifecycle_job_id=$1",
            [abandonedId],
          );
          return row.rows[0]?.state === "completed";
        },
        120_000,
      );
      const reclaimed = await client.query<Record<string, unknown>>(
        "SELECT lease_fence, attempt_count FROM hns_root_import_lifecycle_jobs WHERE lifecycle_job_id=$1",
        [abandonedId],
      );
      // A reclaim always advances the fence, which is what makes the
      // previous holder's writes refusable.
      expect(Number(reclaimed.rows[0]?.lease_fence)).toBe(8);
      expect(Number(reclaimed.rows[0]?.attempt_count)).toBe(2);

      // A live foreign lease is left alone, and once the service has taken
      // the job over the previous holder's fence is refused.
      const contended = await client.query<{ readonly lifecycle_job_id: string }>(
        `INSERT INTO hns_root_import_lifecycle_jobs (root_import_session_id, job_kind, due_at)
             VALUES ($1,'observe_current', clock_timestamp() - interval '1 second')
           RETURNING lifecycle_job_id`,
        [`session-${names[1]}`],
      );
      const contendedId = contended.rows[0]?.lifecycle_job_id;
      const foreign = await client.query<Record<string, unknown>>(
        "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
        ["outside-executor", 120],
      );
      expect(String(foreign.rows[0]?.lifecycle_job_id)).toBe(String(contendedId));
      const foreignFence = Number(foreign.rows[0]?.lease_fence);
      const beforeContention = await phases();

      await Bun.sleep(6_000);
      const heldStill = await client.query<Record<string, unknown>>(
        "SELECT state, leased_by FROM hns_root_import_lifecycle_jobs WHERE lifecycle_job_id=$1",
        [contendedId],
      );
      expect(heldStill.rows[0]).toMatchObject({
        state: "leased",
        leased_by: "outside-executor",
      });
      expect((await phases()).get(`session-${names[1]}`)?.revision).toEqual(
        beforeContention.get(`session-${names[1]}`)?.revision,
      );

      await client.query(
        `UPDATE hns_root_import_lifecycle_jobs
              SET lease_expires_at = clock_timestamp() - interval '1 second'
            WHERE lifecycle_job_id = $1`,
        [contendedId],
      );
      await until(
        "the service to take over the lapsed foreign lease",
        async () => {
          const row = await client.query<Record<string, unknown>>(
            "SELECT state FROM hns_root_import_lifecycle_jobs WHERE lifecycle_job_id=$1",
            [contendedId],
          );
          return row.rows[0]?.state === "completed";
        },
        120_000,
      );
      const staleFinalize = await client.query<Record<string, unknown>>(
        "SELECT * FROM finalize_hns_root_import_lifecycle_job_v1($1,$2,$3,$4,$5)",
        [contendedId, "outside-executor", foreignFence, "completed", null],
      );
      expect(staleFinalize.rows[0]?.outcome).toBe("conflict");

      // Nothing in the restart, the reclaim or the contention moved a
      // deadline that was already established.
      const final = await phases();
      for (const name of names) {
        expect(final.get(`session-${name}`)?.first_current_observation_at).toEqual(
          anchored.get(`session-${name}`)?.first_current_observation_at,
        );
        expect(final.get(`session-${name}`)?.finality_deadline_at).toEqual(
          anchored.get(`session-${name}`)?.finality_deadline_at,
        );
        expect(final.get(`session-${name}`)?.publication_deadline_at).toEqual(
          anchored.get(`session-${name}`)?.publication_deadline_at,
        );
      }

      console.log(
        JSON.stringify({
          names,
          inclusion,
          final_phases: names.map((name) => final.get(`session-${name}`)?.phase),
          reclaimed_fence: Number(reclaimed.rows[0]?.lease_fence),
        }),
      );
    } finally {
      await stopService();
      await client.end().catch(() => undefined);
      const cleanup = new Client({ connectionString: baseConnectionString });
      await cleanup.connect().catch(() => undefined);
      await cleanup
        .query(`DROP DATABASE IF EXISTS ${quote(database)} WITH (FORCE)`)
        .catch(() => undefined);
      await cleanup.end().catch(() => undefined);
    }
  }, 900_000);
});

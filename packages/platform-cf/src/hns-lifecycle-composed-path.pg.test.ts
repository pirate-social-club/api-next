import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { preflightEncodeHnsResourceV1 } from "@pirate/application/namespace-ownership";
import { makeHsdRootResourceObserver } from "@pirate/platform-cf/namespace-ownership-hns-root-resource-observer";
import { Client } from "pg";
import { makeHnsLifecycleObservePort } from "../../../apps/hns-authority-provisioner/src/lifecycle-evidence.ts";
import { runHnsRootImportLifecycleJobOnce } from "../../../apps/hns-authority-provisioner/src/lifecycle-executor.ts";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

/**
 * The composed path: the production observer reads a live regtest chain,
 * qualification compares the observed records against the retained plan's wire
 * digest, and the leased runner persists the evidence and advances the
 * operation. Every layer is the real one; nothing is injected but the plan.
 *
 * Skips unless both a PostgreSQL URL and a reachable regtest node are present,
 * because it mutates a disposable chain.
 */

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const nodeUrl = process.env.HSD_REGTEST_NODE_URL ?? "http://127.0.0.1:14037/";
const walletUrl = process.env.HSD_REGTEST_WALLET_URL ?? "http://127.0.0.1:14039/";
const apiKey = process.env.HSD_REGTEST_API_KEY ?? "controlled-progression";
const authorization = `Basic ${Buffer.from(`x:${apiKey}`).toString("base64")}`;

async function reachable(): Promise<boolean> {
  if (connectionString === undefined) return false;
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
const height = async (): Promise<number> =>
  ((await node("getblockchaininfo")) as { readonly blocks: number }).blocks;

suite("HNS lifecycle composed path against regtest and PostgreSQL", () => {
  test("the real observer advances checking_publication through to checking_authority", async () => {
    const name = `composed${Date.now().toString(36)}`;
    const session = `session-${name}`;
    const address = (await wallet("getnewaddress", [])) as string;
    const mine = (count: number) => node("generatetoaddress", [count, address]);

    // Acquire the name and publish the plan's exact replacement resource.
    await mine(110);
    await wallet("sendopen", [name]);
    await mine(8);
    await wallet("sendbid", [name, 5, 10]);
    await mine(6);
    await wallet("sendreveal", [name]);
    await mine(12);

    const records = [
      { type: "NS", ns: "ns1.pirate." },
      { type: "NS", ns: "ns2.pirate." },
      { type: "TXT", txt: [`pirate-verification=${name}`] },
    ] as const;
    // The retained plan digest is prepared independently of any observation,
    // so a match proves the chain carries what the plan specified.
    const planDigest = (await preflightEncodeHnsResourceV1(records as never)).sha256;

    await wallet("sendupdate", [name, { records }]);
    await mine(1);
    const inclusion = await height();

    const observer = makeHsdRootResourceObserver({
      rpc_url: nodeUrl,
      authorization,
      chain_network: "regtest",
      genesis_block_hash: (await node("getblockhash", [0])) as string,
      tree_interval_blocks: 5,
      safe_minimum_confirmations: 12,
      maximum_tip_age_seconds: 86_400,
      maximum_future_tip_seconds: 3_600,
    });
    const observe = makeHnsLifecycleObservePort({ observe_chain: observer });

    const schema = `hns_composed_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA ${quote(schema)}`);
      await admin.query(`SET search_path TO ${quote(schema)}`);
      for (const migration of await loadPostgresMigrations()) await admin.query(migration.sql);
      await admin.query(
        `INSERT INTO hns_root_import_lifecycle (
             root_import_session_id, root_label, phase, revision, generation,
             plan_exposed_at, publication_deadline_at, pending_reason,
             policy_name, policy_digest
           ) VALUES ($1,$2,'checking_publication',1,1,
             clock_timestamp() - interval '1 hour', clock_timestamp() + interval '13 days',
             'awaiting_publication','hns_root_import_lifecycle_v1','composed')`,
        [session, name],
      );

      const ports = (jobKind: string) => ({
        claim: async (executorId: string, leaseSeconds: number) => {
          const claimed = await admin.query(
            "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
            [executorId, leaseSeconds],
          );
          const row = claimed.rows[0];
          return row === undefined
            ? null
            : {
                lifecycle_job_id: String(row.lifecycle_job_id),
                root_import_session_id: String(row.root_import_session_id),
                job_kind: row.job_kind,
                lease_fence: Number(row.lease_fence),
              };
        },
        identity: async () => ({
          root_label: name,
          generation: 1,
          revision: Number(
            (
              await admin.query(
                "SELECT revision FROM hns_root_import_lifecycle WHERE root_import_session_id=$1",
                [session],
              )
            ).rows[0]?.revision,
          ),
          plan_encoded_resource_sha256: planDigest,
        }),
        observe,
        withTransaction: async <A>(use: (client: never) => Promise<A>): Promise<A> => {
          await admin.query("BEGIN");
          try {
            const result = await use(admin as never);
            await admin.query("COMMIT");
            return result;
          } catch (error) {
            await admin.query("ROLLBACK").catch(() => undefined);
            throw error;
          }
        },
        finalize: async () => ({ outcome: "completed" }),
        now_epoch_ms: () => Date.now(),
        _kind: jobKind,
      });

      const queue = async (kind: string) => {
        await admin.query(
          `INSERT INTO hns_root_import_lifecycle_jobs (root_import_session_id, job_kind, due_at)
             VALUES ($1,$2, clock_timestamp() - interval '1 second')`,
          [session, kind],
        );
      };
      const state = async () =>
        (
          await admin.query(
            `SELECT phase, first_current_observation_at, finality_deadline_at
                 FROM hns_root_import_lifecycle WHERE root_import_session_id=$1`,
            [session],
          )
        ).rows[0];

      // Current view: the chain already carries the published resource.
      await queue("observe_current");
      const current = await runHnsRootImportLifecycleJobOnce(
        "composed-executor",
        60,
        ports("observe_current") as never,
      );
      expect(current.outcome).toBe("completed");
      const afterCurrent = await state();
      expect(afterCurrent?.phase).toBe("waiting_safe_commitment");
      expect(afterCurrent?.first_current_observation_at).not.toBeNull();
      expect(afterCurrent?.finality_deadline_at).not.toBeNull();

      // The safe view lags the current view until the tree commits.
      await queue("observe_safe");
      await runHnsRootImportLifecycleJobOnce(
        "composed-executor",
        60,
        ports("observe_safe") as never,
      );
      expect((await state())?.phase).toBe("waiting_safe_commitment");

      // Advance past the commitment boundary and observe again.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await mine(5);
        await queue("observe_safe");
        await runHnsRootImportLifecycleJobOnce(
          "composed-executor",
          60,
          ports("observe_safe") as never,
        );
        if ((await state())?.phase === "checking_authority") break;
      }

      const advanced = await state();
      expect(advanced?.phase).toBe("checking_authority");
      // The finality anchor and deadline were established once by the first
      // qualifying current observation and never recomputed.
      expect(advanced?.first_current_observation_at).toEqual(
        afterCurrent?.first_current_observation_at,
      );
      expect(advanced?.finality_deadline_at).toEqual(afterCurrent?.finality_deadline_at);

      // A stale lease cannot commit: claim the job as one executor, then run
      // the job under a fence the database no longer recognises.
      await queue("observe_current");
      const stolen = await admin.query(
        "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
        ["other-executor", 60],
      );
      const stolenRow = stolen.rows[0];
      expect(stolenRow).toBeDefined();
      const before = await state();
      const stalePorts = ports("observe_current") as unknown as Record<string, unknown>;
      const stale = await runHnsRootImportLifecycleJobOnce("composed-executor", 60, {
        ...stalePorts,
        claim: async () => ({
          lifecycle_job_id: String(stolenRow?.lifecycle_job_id),
          root_import_session_id: session,
          job_kind: "observe_current",
          lease_fence: Number(stolenRow?.lease_fence) - 1,
        }),
      } as never);
      expect(stale.reason).toBe("lease_conflict");
      expect(await state()).toEqual(before);

      console.log(
        JSON.stringify({
          name,
          inclusion,
          plan_digest: planDigest.slice(0, 16),
          final_phase: advanced?.phase,
        }),
      );
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  }, 600_000);
});

import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { fundingHash, goldenRetryFixture } from "./rewards-golden-retry.pg-fixture.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("Postgres required");
const pgTest = url ? test : test.skip;

pgTest(
  "SIGKILL after real leg/funding HTTP responses replays one journal without duplicate funding",
  async () => {
    const schema = `golden_retry_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString: url });
    const directory = await mkdtemp(join(tmpdir(), "golden-route-retry-"));
    const journal = join(directory, "run.jsonl");
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const connection = `${url}${url?.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await admin.query(`SET search_path TO "${schema}"`);
      const fixture = await goldenRetryFixture(admin, connection);
      const requests: { path: string; body: unknown; status: number; replayed: unknown }[] = [];
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          const path = new URL(request.url).pathname;
          const body = request.method === "POST" ? await request.clone().json() : null;
          const response = await fixture.worker.request(
            `https://api-next-staging.pirate.sc${path}`,
            {
              method: request.method,
              headers: request.headers,
              ...(body ? { body: JSON.stringify(body) } : {}),
            },
          );
          const reply = (await response.clone().json()) as { replayed?: unknown };
          requests.push({ path, body, status: response.status, replayed: reply.replayed });
          return response;
        },
      });
      const run = async (crashAt: string | null) => {
        const child = Bun.spawn(
          [
            process.execPath,
            "-e",
            `
        import { prepareGoldenPool } from ${JSON.stringify(new URL("../../../scripts/megapot-golden-multi-pool.ts", import.meta.url).pathname)};
        import { withGoldenJournal } from ${JSON.stringify(new URL("../../../scripts/megapot-golden-journal.ts", import.meta.url).pathname)};
        try {
          await withGoldenJournal(${JSON.stringify(journal)}, ${JSON.stringify(fixture.input)}, journal => prepareGoldenPool(${JSON.stringify(fixture.input)},
            { apiOrigin: "https://api-next-staging.pirate.sc", authorization: "Bearer fixture" }, journal,
            { fetcher: async (url, init) => {
              const path = new URL(url).pathname;
              const response = await fetch(${JSON.stringify(server?.url.origin)} + path, init);
              if (!response.ok) throw new Error(await response.text());
              if (${JSON.stringify(crashAt)} && path.endsWith(${JSON.stringify(crashAt)})) {
                console.log("accepted-before-journal"); await Bun.sleep(60000);
              }
              return response;
            } }));
          throw new Error("Unexpected drawing: fixture does not run scheduler");
        } catch (error) {
          if (${JSON.stringify(crashAt)} === null && error.message === "Exact funded drawing and safe qualification window required.") console.log("funding-confirmed-drawing-not-open");
          else { console.error(error); process.exitCode=1; }
        }
      `,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        try {
          const reader = child.stdout.getReader();
          const chunk = await reader.read();
          reader.releaseLock();
          const output = new TextDecoder().decode(chunk.value);
          if (chunk.done) throw new Error(await new Response(child.stderr).text());
          if (crashAt) {
            expect(output).toContain("accepted-before-journal");
            child.kill("SIGKILL");
            await child.exited;
            expect(JSON.parse(await readFile(`${journal}.lock`, "utf8")).pid).toBe(child.pid);
            await rename(`${journal}.lock`, `${journal}.lock.${requests.length}`);
          } else {
            const code = await child.exited;
            const stderr = await new Response(child.stderr).text();
            expect({ code, stderr, output }).toEqual({
              code: 0,
              stderr: "",
              output: "funding-confirmed-drawing-not-open\n",
            });
          }
        } finally {
          child.kill();
          await child.exited;
        }
      };
      await run("/reward-offers");
      await run("/megapot-pool-legs");
      expect(
        JSON.parse((await readFile(journal, "utf8")).trim().split("\n").at(-1) ?? "").leg_id,
      ).toBeNull();
      await run("/observations");
      for (let retry = 0; retry < 2; retry++) await run(null);
      const persisted = JSON.parse(
        (await readFile(journal, "utf8")).trim().split("\n").at(-1) ?? "",
      );
      const originals = await admin.query(
        "SELECT leg_id, funding_effect_id FROM song_reward_leg_funding_effects",
      );
      expect(originals.rows).toHaveLength(1);
      expect(persisted).toMatchObject({
        ...originals.rows[0],
        drawing_id: null,
        funding_transaction_hash: fundingHash,
      });
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM song_reward_offers")).rows,
      ).toEqual([{ count: 1 }]);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count, sum(funded_atomic)::text AS funded FROM song_reward_offer_legs",
          )
        ).rows,
      ).toEqual([{ count: 1, funded: "1000" }]);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count, min(state) AS state, min(transaction_hash) AS hash, sum(confirmed_amount_atomic)::text AS confirmed FROM song_reward_leg_funding_effects",
          )
        ).rows,
      ).toEqual([{ count: 1, state: "confirmed", hash: fundingHash, confirmed: "1000" }]);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM song_reward_offer_actions")).rows,
      ).toEqual([{ count: 3 }]);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM megapot_ticket_purchase_effects"))
          .rows,
      ).toEqual([{ count: 0 }]);
      expect(fixture.receiptsRead()).toBe(1);
      for (const suffix of ["/reward-offers", "/megapot-pool-legs", "/observations"]) {
        const repeated = requests.filter((r) => r.path.endsWith(suffix));
        expect(repeated.length).toBeGreaterThanOrEqual(2);
        expect(new Set(repeated.map((r) => JSON.stringify(r.body))).size).toBe(1);
        expect(repeated.every((r) => r.status >= 200 && r.status < 300)).toBe(true);
        expect(repeated[0]?.replayed).toBe(false);
        expect(repeated.slice(1).every((r) => r.replayed === true)).toBe(true);
      }
    } finally {
      server?.stop(true);
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120000,
);
